// Don't Start Without Me — relay server.
//
// The server never sees any video. It only passes small messages between
// the people in a room ("play at 12:34", "pause", "heartbeat") and answers
// pings so clients can estimate the clock offset to the server.
//
// Two ways to connect, same messages:
//   - WebSocket (fast; used when the host allows it, e.g. a VPS)
//   - HTTP long-polling (fallback for hosts that block inbound WebSockets,
//     e.g. Hostinger's managed Node.js hosting):
//       POST /api/message  {clientId?, msg}  → {clientId, replies: [...]}
//       GET  /api/poll?clientId=…            → {messages: [...]}   (waits up to 25 s)

const http = require("http");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

const MAX_ROOM_SIZE = 8;
const MAX_MESSAGE_BYTES = 4 * 1024;
const ROOM_CODE_RE = /^[A-Za-z0-9-]{3,32}$/;
const POLL_WAIT_MS = 25_000;
const HTTP_CLIENT_TIMEOUT_MS = 45_000; // no poll for this long → gone
const MAX_QUEUE = 200;

function createRelay({ port = 8787, log = console.log, disableWebSocket = false } = {}) {
  /** @type {Map<string, {clients: Set<Client>, state: object|null}>} */
  const rooms = new Map();
  /** HTTP clients by id. @type {Map<string, Client>} */
  const httpClients = new Map();

  // ------------------------------------------------------------ clients

  class Client {
    constructor(kind) {
      this.kind = kind; // "ws" | "http"
      this.id = crypto.randomUUID();
      this.name = "Someone";
      this.room = null;
      this.ws = null; // ws clients
      this.queue = []; // http clients
      this.waiter = null; // pending long-poll {res, timer}
      this.capture = null; // replies to return inline in the current POST
      this.lastSeen = Date.now();
    }
    send(msg) {
      if (this.kind === "ws") {
        if (this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify(msg));
        return;
      }
      if (this.capture) return void this.capture.push(msg);
      this.queue.push(msg);
      if (this.queue.length > MAX_QUEUE) this.queue.shift();
      this.flush();
    }
    flush() {
      if (!this.waiter || this.queue.length === 0) return;
      const { res, timer } = this.waiter;
      this.waiter = null;
      clearTimeout(timer);
      json(res, 200, { messages: this.queue.splice(0) });
    }
  }

  // ------------------------------------------------------------ rooms

  function broadcast(room, msg, except) {
    for (const client of room.clients) if (client !== except) client.send(msg);
  }

  function peersOf(room) {
    return [...room.clients].map((c) => ({ id: c.id, name: c.name }));
  }

  function leave(client) {
    const code = client.room;
    if (!code) return;
    const room = rooms.get(code);
    client.room = null;
    if (!room) return;
    room.clients.delete(client);
    if (room.clients.size === 0) {
      rooms.delete(code);
      log(`room ${code} closed`);
    } else {
      // If the host left, the longest-present person takes over.
      if (room.hostId === client.id) room.hostId = room.clients.values().next().value.id;
      broadcast(room, {
        type: "presence",
        event: "left",
        who: client.name,
        whoId: client.id,
        hostId: room.hostId,
        peers: peersOf(room),
      });
    }
  }

  function handle(client, msg) {
    if (!msg || typeof msg.type !== "string") return;
    client.lastSeen = Date.now();

    switch (msg.type) {
      case "ping":
        return client.send({ type: "pong", t0: msg.t0, serverTime: Date.now() });

      case "join": {
        const code = String(msg.room || "").trim();
        if (!ROOM_CODE_RE.test(code)) return client.send({ type: "error", error: "bad_room_code" });
        leave(client);
        let room = rooms.get(code);
        if (!room) {
          room = { clients: new Set(), state: null, hostId: null };
          rooms.set(code, room);
          log(`room ${code} opened`);
        }
        if (room.clients.size >= MAX_ROOM_SIZE) return client.send({ type: "error", error: "room_full" });
        client.name = String(msg.name || "Someone").slice(0, 40);
        client.room = code;
        room.clients.add(client);
        // Whoever opened the room is the host: the source of truth for timing.
        if (!room.hostId) room.hostId = client.id;
        client.send({
          type: "joined",
          room: code,
          you: client.id,
          hostId: room.hostId,
          peers: peersOf(room),
          state: room.state,
          serverTime: Date.now(),
        });
        broadcast(
          room,
          { type: "presence", event: "joined", who: client.name, whoId: client.id, hostId: room.hostId, peers: peersOf(room) },
          client,
        );
        return;
      }

      case "leave":
        return leave(client);

      case "state": {
        // A playback event or heartbeat. Stamp the sender, remember it for
        // late joiners, pass it on.
        const room = client.room && rooms.get(client.room);
        if (!room) return client.send({ type: "error", error: "not_in_room" });
        const state = {
          type: "state",
          from: client.id,
          fromName: client.name,
          reason: String(msg.reason || "update").slice(0, 20),
          playing: Boolean(msg.playing),
          position: Number(msg.position) || 0,
          mediaId: msg.mediaId ? String(msg.mediaId).slice(0, 200) : null,
          mediaUrl: msg.mediaUrl ? String(msg.mediaUrl).slice(0, 500) : null,
          // sentAt is in *server* time (the client already applied its offset).
          sentAt: Number(msg.sentAt) || Date.now(),
        };
        room.state = state;
        broadcast(room, state, client);
        return;
      }

      case "ad": {
        // Someone's player started or finished an ad.
        const room = client.room && rooms.get(client.room);
        if (!room) return client.send({ type: "error", error: "not_in_room" });
        broadcast(room, { type: "ad", active: Boolean(msg.active), from: client.id, fromName: client.name }, client);
        return;
      }

      case "keepalive":
        return;

      default:
        return client.send({ type: "error", error: "unknown_type" });
    }
  }

  // ------------------------------------------------------------ HTTP

  function json(res, status, body) {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...CORS });
    res.end(JSON.stringify(body));
  }

  const CORS = {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
  };

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on("data", (c) => {
        size += c.length;
        if (size > MAX_MESSAGE_BYTES) {
          reject(new Error("too_big"));
          req.destroy();
        } else chunks.push(c);
      });
      req.on("end", () => resolve(Buffer.concat(chunks).toString()));
      req.on("error", reject);
    });
  }

  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://relay");

    if (req.method === "OPTIONS") {
      res.writeHead(204, CORS);
      return res.end();
    }

    if (url.pathname === "/" || url.pathname === "/health") {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8", ...CORS });
      return res.end("ok — don't start without me\n");
    }

    if (url.pathname === "/api/message" && req.method === "POST") {
      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        return json(res, 400, { error: "bad_request" });
      }
      let client = body.clientId ? httpClients.get(body.clientId) : null;
      if (body.clientId && !client) return json(res, 404, { error: "unknown_client" });
      if (!client) {
        client = new Client("http");
        httpClients.set(client.id, client);
      }
      client.capture = [];
      handle(client, body.msg);
      const replies = client.capture;
      client.capture = null;
      return json(res, 200, { clientId: client.id, replies });
    }

    if (url.pathname === "/api/poll" && req.method === "GET") {
      const client = httpClients.get(url.searchParams.get("clientId"));
      if (!client) return json(res, 404, { error: "unknown_client" });
      client.lastSeen = Date.now();
      if (client.waiter) {
        // A newer poll replaces an old one.
        clearTimeout(client.waiter.timer);
        json(client.waiter.res, 200, { messages: [] });
      }
      const timer = setTimeout(() => {
        if (client.waiter && client.waiter.res === res) {
          client.waiter = null;
          json(res, 200, { messages: [] });
        }
      }, POLL_WAIT_MS);
      client.waiter = { res, timer };
      req.on("close", () => {
        if (client.waiter && client.waiter.res === res) {
          clearTimeout(timer);
          client.waiter = null;
        }
      });
      client.flush();
      return;
    }

    res.writeHead(404, CORS);
    res.end();
  });

  // Forget HTTP clients that stopped polling.
  const httpSweep = setInterval(() => {
    const now = Date.now();
    for (const [id, c] of httpClients) {
      if (!c.waiter && now - c.lastSeen > HTTP_CLIENT_TIMEOUT_MS) {
        leave(c);
        httpClients.delete(id);
      }
    }
  }, 10_000);

  // ------------------------------------------------------------ WebSocket

  let wss = null;
  let wsSweep = null;
  if (!disableWebSocket) {
    wss = new WebSocketServer({ server: httpServer, maxPayload: MAX_MESSAGE_BYTES });
    wss.on("connection", (ws) => {
      const client = new Client("ws");
      client.ws = ws;
      ws.isAlive = true;
      ws.on("pong", () => (ws.isAlive = true));
      ws.on("message", (raw) => {
        let msg;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return client.send({ type: "error", error: "bad_json" });
        }
        handle(client, msg);
      });
      ws.on("close", () => leave(client));
    });
    // Drop dead connections (laptop closed, Wi-Fi gone).
    wsSweep = setInterval(() => {
      for (const ws of wss.clients) {
        if (!ws.isAlive) {
          ws.terminate();
          continue;
        }
        ws.isAlive = false;
        ws.ping();
      }
    }, 30_000);
  }

  return {
    rooms,
    listen() {
      return new Promise((resolve) =>
        httpServer.listen(port, () => {
          const a = httpServer.address();
          resolve(typeof a === "string" ? a : a.port);
        }),
      );
    },
    close() {
      clearInterval(httpSweep);
      clearInterval(wsSweep);
      for (const c of httpClients.values()) {
        if (c.waiter) {
          clearTimeout(c.waiter.timer);
          c.waiter.res.end();
        }
      }
      const closeHttp = () => new Promise((resolve) => httpServer.close(() => resolve()));
      if (!wss) return closeHttp();
      for (const ws of wss.clients) ws.terminate();
      return new Promise((resolve) => wss.close(() => resolve())).then(closeHttp);
    },
  };
}

module.exports = { createRelay };
