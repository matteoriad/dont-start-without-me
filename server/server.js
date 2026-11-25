// Don't Start Without Me — relay server.
//
// The server never sees any video. It only passes small messages between
// the people in a room ("play at 12:34", "pause", "heartbeat") and answers
// pings so clients can estimate the clock offset to the server.

const http = require("http");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

const MAX_ROOM_SIZE = 8;
const MAX_MESSAGE_BYTES = 4 * 1024;
const ROOM_CODE_RE = /^[A-Za-z0-9-]{3,32}$/;

function createRelay({ port = 8787, log = console.log } = {}) {
  /** @type {Map<string, {clients: Set<any>, state: object|null}>} */
  const rooms = new Map();

  const httpServer = http.createServer((req, res) => {
    if (req.url === "/health" || req.url === "/") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok — don't start without me\n");
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const wss = new WebSocketServer({ server: httpServer, maxPayload: MAX_MESSAGE_BYTES });

  function send(ws, msg) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  }

  function broadcast(room, msg, except) {
    for (const client of room.clients) {
      if (client !== except) send(client, msg);
    }
  }

  function peersOf(room) {
    return [...room.clients].map((c) => ({ id: c.meta.id, name: c.meta.name }));
  }

  function leave(ws) {
    const code = ws.meta.room;
    if (!code) return;
    const room = rooms.get(code);
    ws.meta.room = null;
    if (!room) return;
    room.clients.delete(ws);
    if (room.clients.size === 0) {
      rooms.delete(code);
      log(`room ${code} closed`);
    } else {
      broadcast(room, { type: "presence", event: "left", who: ws.meta.name, peers: peersOf(room) });
    }
  }

  wss.on("connection", (ws) => {
    ws.meta = { id: crypto.randomUUID(), name: "Someone", room: null };
    ws.isAlive = true;
    ws.on("pong", () => (ws.isAlive = true));

    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return send(ws, { type: "error", error: "bad_json" });
      }
      if (!msg || typeof msg.type !== "string") return;

      switch (msg.type) {
        case "ping":
          // Clock sync: client computes offset from t0, serverTime and receive time.
          return send(ws, { type: "pong", t0: msg.t0, serverTime: Date.now() });

        case "join": {
          const code = String(msg.room || "").trim();
          if (!ROOM_CODE_RE.test(code)) return send(ws, { type: "error", error: "bad_room_code" });
          leave(ws);
          let room = rooms.get(code);
          if (!room) {
            room = { clients: new Set(), state: null };
            rooms.set(code, room);
            log(`room ${code} opened`);
          }
          if (room.clients.size >= MAX_ROOM_SIZE) return send(ws, { type: "error", error: "room_full" });
          ws.meta.name = String(msg.name || "Someone").slice(0, 40);
          ws.meta.room = code;
          room.clients.add(ws);
          send(ws, {
            type: "joined",
            room: code,
            you: ws.meta.id,
            peers: peersOf(room),
            state: room.state,
            serverTime: Date.now(),
          });
          broadcast(room, { type: "presence", event: "joined", who: ws.meta.name, peers: peersOf(room) }, ws);
          return;
        }

        case "leave":
          return leave(ws);

        case "state": {
          // A playback event or heartbeat. We stamp who sent it, remember the
          // latest one for late joiners, and pass it on.
          const room = ws.meta.room && rooms.get(ws.meta.room);
          if (!room) return send(ws, { type: "error", error: "not_in_room" });
          const state = {
            type: "state",
            from: ws.meta.id,
            fromName: ws.meta.name,
            reason: String(msg.reason || "update").slice(0, 20),
            playing: Boolean(msg.playing),
            position: Number(msg.position) || 0,
            mediaId: msg.mediaId ? String(msg.mediaId).slice(0, 200) : null,
            mediaUrl: msg.mediaUrl ? String(msg.mediaUrl).slice(0, 500) : null,
            // sentAt is in *server* time (client already applied its offset).
            sentAt: Number(msg.sentAt) || Date.now(),
          };
          room.state = state;
          broadcast(room, state, ws);
          return;
        }

        case "keepalive":
          return; // keeps the extension's service worker awake; nothing to do

        default:
          return send(ws, { type: "error", error: "unknown_type" });
      }
    });

    ws.on("close", () => leave(ws));
  });

  // Drop dead connections (laptop closed, Wi-Fi gone).
  const sweep = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30_000);

  return {
    rooms,
    listen() {
      return new Promise((resolve) => httpServer.listen(port, () => resolve(httpServer.address().port)));
    },
    close() {
      clearInterval(sweep);
      for (const ws of wss.clients) ws.terminate();
      return new Promise((resolve) => wss.close(() => httpServer.close(() => resolve())));
    },
  };
}

module.exports = { createRelay };

if (require.main === module) {
  const port = Number(process.env.PORT) || 8787;
  createRelay({ port })
    .listen()
    .then((p) => console.log(`relay listening on :${p}`));
}
