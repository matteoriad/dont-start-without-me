const test = require("node:test");
const assert = require("node:assert");
const WebSocket = require("ws");
const { createRelay } = require("../server");

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
