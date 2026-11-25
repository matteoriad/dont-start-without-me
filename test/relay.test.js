const test = require("node:test");
const assert = require("node:assert");
const WebSocket = require("ws");
const { createRelay } = require("../lib/relay");

function client(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const inbox = [];
  const waiters = [];
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    const i = waiters.findIndex((w) => w.type === msg.type);
    if (i >= 0) waiters.splice(i, 1)[0].resolve(msg);
    else inbox.push(msg);
  });
  return {
    ws,
    open: () => new Promise((r) => ws.on("open", r)),
    send: (m) => ws.send(JSON.stringify(m)),
    next(type) {
      const i = inbox.findIndex((m) => m.type === type);
      if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
      return new Promise((resolve) => waiters.push({ type, resolve }));
    },
  };
}

test("relay: join, presence, state relay, late joiner gets state, ping", async () => {
  const relay = createRelay({ port: 0, log: () => {} });
  const port = await relay.listen();
  try {
    const a = client(port);
    const b = client(port);
    await Promise.all([a.open(), b.open()]);

    a.send({ type: "join", room: "nile-spree", name: "Matteo" });
    const aj = await a.next("joined");
    assert.equal(aj.peers.length, 1);
    assert.equal(aj.state, null);

    b.send({ type: "join", room: "nile-spree", name: "Partner" });
    const bj = await b.next("joined");
    assert.equal(bj.peers.length, 2);
    const pres = await a.next("presence");
    assert.equal(pres.event, "joined");
    assert.equal(pres.who, "Partner");

    a.send({ type: "state", reason: "play", playing: true, position: 42.5, mediaId: "abc", sentAt: 1000 });
    const st = await b.next("state");
    assert.equal(st.fromName, "Matteo");
    assert.equal(st.playing, true);
    assert.equal(st.position, 42.5);
    assert.equal(st.mediaId, "abc");

    const c = client(port);
    await c.open();
    c.send({ type: "join", room: "nile-spree", name: "Late" });
    const cj = await c.next("joined");
    assert.equal(cj.state.position, 42.5);

    c.send({ type: "ping", t0: 123 });
    const pong = await c.next("pong");
    assert.equal(pong.t0, 123);
    assert.ok(pong.serverTime > 0);

    c.send({ type: "join", room: "x", name: "bad" }); // too short
    const err = await c.next("error");
    assert.equal(err.error, "bad_room_code");

    for (const x of [a, b, c]) x.ws.close();
  } finally {
    await relay.close();
  }
});

async function post(port, body) {
  const r = await fetch(`http://127.0.0.1:${port}/api/message`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
}

test("relay: HTTP long-poll clients talk to WebSocket clients", async () => {
  const relay = createRelay({ port: 0, log: () => {} });
  const port = await relay.listen();
  try {
    // HTTP client joins
    const j = await post(port, { msg: { type: "join", room: "http-room", name: "Poller" } });
    assert.equal(j.status, 200);
    const clientId = j.body.clientId;
    assert.equal(j.body.replies[0].type, "joined");

    // ping replies come back inline
    const p = await post(port, { clientId, msg: { type: "ping", t0: 7 } });
    assert.equal(p.body.replies[0].type, "pong");
    assert.equal(p.body.replies[0].t0, 7);

    // WS client joins the same room
    const w = client(port);
    await w.open();
    w.send({ type: "join", room: "http-room", name: "Socket" });
    const wj = await w.next("joined");
    assert.equal(wj.peers.length, 2);

    // HTTP client should get presence via poll
    const poll1 = await (await fetch(`http://127.0.0.1:${port}/api/poll?clientId=${clientId}`)).json();
    assert.equal(poll1.messages[0].type, "presence");
    assert.equal(poll1.messages[0].who, "Socket");

    // A pending poll is woken up by a WS state message
    const pending = fetch(`http://127.0.0.1:${port}/api/poll?clientId=${clientId}`).then((r) => r.json());
    await new Promise((r) => setTimeout(r, 100));
    w.send({ type: "state", reason: "pause", playing: false, position: 99, sentAt: 1 });
    const poll2 = await pending;
    assert.equal(poll2.messages[0].type, "state");
    assert.equal(poll2.messages[0].position, 99);

    // HTTP → WS
    await post(port, { clientId, msg: { type: "state", reason: "play", playing: true, position: 100, sentAt: 2 } });
    const st = await w.next("state");
    assert.equal(st.fromName, "Poller");

    // unknown client
    const bad = await post(port, { clientId: "nope", msg: { type: "ping" } });
    assert.equal(bad.status, 404);

    w.ws.close();
  } finally {
    await relay.close();
  }
});

test("relay: HTTP-only mode refuses WebSockets but serves HTTP", async () => {
  const relay = createRelay({ port: 0, log: () => {}, disableWebSocket: true });
  const port = await relay.listen();
  try {
    const failed = await new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      ws.on("open", () => resolve(false));
      ws.on("error", () => resolve(true));
    });
    assert.equal(failed, true);
    const j = await post(port, { msg: { type: "join", room: "only-http", name: "A" } });
    assert.equal(j.body.replies[0].type, "joined");
  } finally {
    await relay.close();
  }
});

test("relay: host is the room opener, passes on when they leave; ad messages relay", async () => {
  const relay = createRelay({ port: 0, log: () => {} });
  const port = await relay.listen();
  try {
    const a = client(port);
    const b = client(port);
    await Promise.all([a.open(), b.open()]);
    a.send({ type: "join", room: "host-room", name: "Host" });
    const aj = await a.next("joined");
    assert.equal(aj.hostId, aj.you);
    b.send({ type: "join", room: "host-room", name: "Guest" });
    const bj = await b.next("joined");
    assert.equal(bj.hostId, aj.you);
    const pres = await a.next("presence");
    assert.equal(pres.whoId, bj.you);

    b.send({ type: "ad", active: true });
    const ad = await a.next("ad");
    assert.equal(ad.active, true);
    assert.equal(ad.fromName, "Guest");

    a.ws.close();
    const left = await b.next("presence");
    assert.equal(left.event, "left");
    assert.equal(left.hostId, bj.you);
    b.ws.close();
  } finally {
    await relay.close();
  }
});

test("relay: invite page, room info and rename", async () => {
  const relay = createRelay({ port: 0, log: () => {} });
  const port = await relay.listen();
  try {
    const page = await fetch(`http://127.0.0.1:${port}/join/movie-night-1`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Admit two/);

    const none = await (await fetch(`http://127.0.0.1:${port}/api/room/movie-night-1`)).json();
    assert.equal(none.exists, false);

    const a = client(port);
    const b = client(port);
    await Promise.all([a.open(), b.open()]);
    a.send({ type: "join", room: "movie-night-1", name: "Matteo" });
    await a.next("joined");
    a.send({ type: "state", reason: "hello", playing: false, position: 75, mediaUrl: "https://www.netflix.com/watch/1", mediaTitle: "Dark", sentAt: Date.now() });
    await new Promise((r) => setTimeout(r, 50));
    const info = await (await fetch(`http://127.0.0.1:${port}/api/room/movie-night-1`)).json();
    assert.equal(info.hostName, "Matteo");
    assert.equal(info.service, "Netflix");
    assert.equal(info.title, "Dark");
    assert.equal(info.position, 75);
    assert.equal(info.playing, false);

    b.send({ type: "join", room: "movie-night-1", name: "Y" });
    await b.next("joined");
    await a.next("presence");
    b.send({ type: "rename", name: "Yasso" });
    const ren = await a.next("presence");
    assert.equal(ren.event, "renamed");
    assert.ok(ren.peers.some((p) => p.name === "Yasso"));

    a.ws.close();
    b.ws.close();
  } finally {
    await relay.close();
  }
});
