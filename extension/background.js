// Background service worker: owns the connection to the relay, the room, and
// the clock offset. The content script in the "party tab" does the actual
// video work; this worker just shuttles messages.
importScripts("config.js", "content/sync-math.js", "transport.js");
const math = self.DSWM.math;

const DEFAULT_SERVER = self.DSWM_CONFIG.serverUrl;
const KEEPALIVE_MS = 20_000; // keeps the service worker (and a WebSocket) alive
const CLOCK_SYNC_MS = 30_000;

let conn = null; // transport from transport.js
let connectGen = 0; // bumps on every connect/leave so stale attempts give up
let party = null; // { room, name, serverUrl, tabId } while in a party
let status = "idle"; // idle | connecting | connected | reconnecting | error
let lastError = null;
let myId = null;
let peers = [];
let lastState = null;
let samples = [];
let offset = 0;
let keepaliveTimer = null;
let clockTimers = [];
let reconnectTimer = null;
let reconnectDelay = 1000;

// Restore after the worker was suspended / restarted.
const restored = chrome.storage.session.get("party").then(({ party: saved }) => {
  if (saved && !party) {
    party = saved;
    connect();
  }
});

// ---------------------------------------------------------------- connection

async function connect() {
  clearTimeout(reconnectTimer);
  stopTimers();
  if (conn) {
    conn.close();
    conn = null;
  }
  if (!party) return;
  const gen = ++connectGen;
  status = status === "connected" || status === "reconnecting" ? "reconnecting" : "connecting";
  let t;
  try {
    t = await self.DSWM.connectRelay(party.serverUrl, {
      onMessage: (msg) => conn === t && handleServer(msg),
      onClose: () => conn === t && onDisconnected(),
    });
  } catch {
    if (gen !== connectGen) return;
    lastError = "Can't reach the server.";
    return onDisconnected();
  }
  if (gen !== connectGen || !party) return t.close(); // left or rejoined meanwhile
  conn = t;
  lastError = null;
  reconnectDelay = 1000;
  sendRaw({ type: "join", room: party.room, name: party.name });
  startClockSync();
  // Any extension API call keeps an MV3 worker alive; the WebSocket message too.
  keepaliveTimer = setInterval(() => {
    chrome.runtime.getPlatformInfo(() => {});
    if (conn && conn.kind === "ws") sendRaw({ type: "keepalive" });
  }, KEEPALIVE_MS);
}

function onDisconnected() {
  stopTimers();
  conn = null;
  myId = null;
  if (!party) return;
  status = "reconnecting";
  reconnectTimer = setTimeout(connect, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, 15000);
}

function fail(message) {
  status = "error";
  lastError = message;
}

function stopTimers() {
  clearInterval(keepaliveTimer);
  keepaliveTimer = null;
  clockTimers.forEach((t) => clearTimeout(t) || clearInterval(t));
  clockTimers = [];
}

function sendRaw(msg) {
  if (conn) conn.send(msg);
}

function startClockSync() {
  samples = [];
  // A quick burst for a good first estimate, then occasional refreshes.
  for (let i = 0; i < 6; i++) clockTimers.push(setTimeout(() => sendRaw({ type: "ping", t0: Date.now() }), 300 + i * 250));
  clockTimers.push(setInterval(() => sendRaw({ type: "ping", t0: Date.now() }), CLOCK_SYNC_MS));
}

function handleServer(msg) {
  switch (msg.type) {
    case "pong": {
      samples.push({ t0: msg.t0, t1: Date.now(), serverTime: msg.serverTime });
      if (samples.length > 12) samples.shift();
      const est = math.estimateOffset(samples);
      if (est !== null && est !== offset) {
        offset = est;
        toTab({ type: "offset", offset });
      }
      return;
    }
    case "joined":
      status = "connected";
      myId = msg.you;
      peers = msg.peers || [];
      lastState = msg.state;
      break;
    case "presence":
      peers = msg.peers || [];
      break;
    case "state":
      lastState = msg;
      break;
    case "error":
      lastError = msg.error;
      if (msg.error === "bad_room_code" || msg.error === "room_full") {
        fail(msg.error === "room_full" ? "That room is full." : "Room codes are 3–32 letters, numbers or dashes.");
      }
      break;
  }
  toTab({ type: "server", msg });
}

function toTab(message) {
  if (party && party.tabId != null) chrome.tabs.sendMessage(party.tabId, message).catch(() => {});
}

// ---------------------------------------------------------------- party lifecycle

async function join({ room, name, serverUrl, tabId }) {
  if (party && party.tabId !== tabId) toTabId(party.tabId, { type: "party", active: false });
  party = { room, name: name || "Someone", serverUrl: serverUrl || DEFAULT_SERVER, tabId };
  peers = [];
  lastState = null;
  await chrome.storage.session.set({ party });
  // Only remember a server if the user deliberately picked a different one.
  await chrome.storage.local.set({ name: party.name, room, serverUrl: serverUrl && serverUrl !== DEFAULT_SERVER ? serverUrl : "" });
  status = "connecting";
  connect();
  let tabReady = true;
  try {
    await chrome.tabs.sendMessage(tabId, { type: "party", active: true, offset });
  } catch {
    tabReady = false; // content script not injected yet (tab opened before install)
  }
  return { ok: true, tabReady };
}

async function leave() {
  connectGen++;
  if (party) toTabId(party.tabId, { type: "party", active: false });
  party = null;
  sendRaw({ type: "leave" });
  if (conn) {
    const c = conn;
    conn = null;
    setTimeout(() => c.close(), 300); // let the "leave" go out first
  }
  stopTimers();
  clearTimeout(reconnectTimer);
  status = "idle";
  myId = null;
  peers = [];
  lastState = null;
  await chrome.storage.session.remove("party");
}

function toTabId(tabId, message) {
  if (tabId != null) chrome.tabs.sendMessage(tabId, message).catch(() => {});
}

chrome.tabs.onRemoved.addListener((tabId) => {
  if (party && party.tabId === tabId) leave();
});

// ---------------------------------------------------------------- messages from popup / content

chrome.runtime.onMessage.addListener((m, sender, sendResponse) => {
  (async () => {
    await restored;
    switch (m.type) {
      case "tab-hello": {
        const isParty = Boolean(party && sender.tab && sender.tab.id === party.tabId);
        return { active: isParty, offset, myId, peers, state: isParty && myId ? lastState : null };
      }
      case "send":
        if (party && sender.tab && sender.tab.id === party.tabId) sendRaw(m.msg);
        return { ok: true };
      case "popup-get": {
        const saved = await chrome.storage.local.get({ name: "", room: "", serverUrl: "" });
        return {
          party,
          status,
          lastError,
          myId,
          peers,
          offset,
          transport: conn ? conn.kind : null,
          defaultServer: DEFAULT_SERVER,
          saved,
        };
      }
      case "popup-join":
        return join(m);
      case "popup-leave":
        await leave();
        return { ok: true };
      default:
        return null;
    }
  })().then(sendResponse);
  return true; // async response
});
