// Background service worker: owns the WebSocket to the relay, the room, and
// the clock offset. The content script in the "party tab" does the actual
// video work; this worker just shuttles messages.
importScripts("content/sync-math.js");
const math = self.DSWM.math;

const DEFAULTS = { serverUrl: "ws://localhost:8787", name: "", room: "" };
const KEEPALIVE_MS = 20_000; // Chrome 116+ keeps the worker alive while a WebSocket is active
const CLOCK_SYNC_MS = 30_000;

let ws = null;
let party = null; // { room, name, serverUrl, tabId } while in a party
let status = "idle"; // idle | connecting | connected | reconnecting | error
let lastError = null;
let myId = null;
let peers = [];
let lastState = null;
let samples = [];
let offset = 0;
let keepaliveTimer = null;
let clockTimer = null;
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

function connect() {
  clearTimeout(reconnectTimer);
  stopTimers();
  if (ws) {
    ws.onclose = null;
    ws.close();
  }
  status = status === "connected" ? "reconnecting" : "connecting";
  lastError = null;
  try {
    ws = new WebSocket(party.serverUrl);
  } catch (e) {
    fail(`Bad server URL: ${party.serverUrl}`);
    return;
  }

  ws.onopen = () => {
    reconnectDelay = 1000;
    sendRaw({ type: "join", room: party.room, name: party.name });
    startClockSync();
    keepaliveTimer = setInterval(() => sendRaw({ type: "keepalive" }), KEEPALIVE_MS);
  };

  ws.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    handleServer(msg);
  };

  ws.onerror = () => {
    lastError = "Can't reach the server.";
  };

  ws.onclose = () => {
    stopTimers();
    ws = null;
    myId = null;
    if (!party) return;
    status = "reconnecting";
    reconnectTimer = setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 15000);
  };
}

function fail(message) {
  status = "error";
  lastError = message;
}

function stopTimers() {
  clearInterval(keepaliveTimer);
  clearInterval(clockTimer);
  keepaliveTimer = clockTimer = null;
}

function sendRaw(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function startClockSync() {
  samples = [];
  // A quick burst for a good first estimate, then occasional refreshes.
  for (let i = 0; i < 6; i++) setTimeout(() => sendRaw({ type: "ping", t0: Date.now() }), i * 250);
  clockTimer = setInterval(() => sendRaw({ type: "ping", t0: Date.now() }), CLOCK_SYNC_MS);
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
  party = { room, name: name || "Someone", serverUrl: serverUrl || DEFAULTS.serverUrl, tabId };
  peers = [];
  lastState = null;
  await chrome.storage.session.set({ party });
  await chrome.storage.local.set({ serverUrl: party.serverUrl, name: party.name, room });
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
  if (party) toTabId(party.tabId, { type: "party", active: false });
  party = null;
  sendRaw({ type: "leave" });
  if (ws) {
    ws.onclose = null;
    ws.close();
    ws = null;
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
        const saved = await chrome.storage.local.get(DEFAULTS);
        return { party, status, lastError, myId, peers, offset, saved: { ...DEFAULTS, ...saved } };
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
