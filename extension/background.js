// Background service worker: owns the connection to the relay, the room, and
// the clock offset. The content script in the "party tab" does the actual
// video work; this worker just shuttles messages.
importScripts("config.js", "content/sync-math.js", "transport.js");
const math = self.DSWM.math;

const DEFAULT_SERVER = self.DSWM_CONFIG.serverUrl;
// Pages where the extension can sync a player. Anything else (a blank tab,
// the invite page, …) gets navigated to the host's title after joining.
const SUPPORTED_RE = /^https:\/\/((www\.|m\.)?youtube\.com|www\.netflix\.com|tv\.apple\.com)\//;
const KEEPALIVE_MS = 20_000; // keeps the service worker (and a WebSocket) alive
const CLOCK_SYNC_MS = 30_000;

let conn = null; // transport from transport.js
let connectGen = 0; // bumps on every connect/leave so stale attempts give up
let party = null; // { room, name, serverUrl, tabId } while in a party
let status = "idle"; // idle | connecting | connected | reconnecting | error
let lastError = null;
let myId = null;
let peers = [];
let hostId = null;
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
      hostId = msg.hostId || null;
      peers = msg.peers || [];
      lastState = msg.state;
      if (msg.where) maybeFollow(msg.where);
      else if (msg.state) maybeFollow(msg.state);
      break;
    case "presence":
      peers = msg.peers || [];
      if (msg.hostId) hostId = msg.hostId;
      break;
    case "state":
      lastState = msg;
      maybeFollow(msg);
      break;
    case "where":
      maybeFollow(msg);
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

// A joiner's tab goes to whatever the host is watching. If the tab is on a
// supported site, its content script does that itself (it knows whether it's
// already on the right title); otherwise we navigate the tab from here.
async function maybeFollow(state) {
  if (!party || !party.follow || !state.mediaUrl || state.from === myId) return;
  party.follow = false;
  await chrome.storage.session.set({ party });
  let tab;
  try {
    tab = await chrome.tabs.get(party.tabId);
  } catch {
    return;
  }
  if (!SUPPORTED_RE.test(tab.url || "")) {
    chrome.tabs.update(party.tabId, { url: state.mediaUrl }).catch(() => {});
  }
}

// ---------------------------------------------------------------- content scripts

// After the extension is installed or updated, tabs that were already open
// still run the old copy (or none), cut off from us. Put fresh copies in.
async function injectContent(tabId, url) {
  const scripts = chrome.runtime.getManifest().content_scripts || [];
  for (const cs of scripts) {
    if (cs.js.includes("content/invite.js")) continue;
    if (!cs.matches.some((pattern) => matchPattern(pattern, url))) continue;
    await chrome.scripting.executeScript({ target: { tabId }, files: cs.js, world: cs.world || "ISOLATED" }).catch(() => {});
  }
}

function matchPattern(pattern, url) {
  const re = new RegExp("^" + pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
  return re.test(url);
}

chrome.runtime.onInstalled.addListener(async () => {
  const tabs = await chrome.tabs.query({}).catch(() => []);
  for (const t of tabs) if (t.url && SUPPORTED_RE.test(t.url)) injectContent(t.id, t.url);
});

// Tell a tab it's the party tab; if nobody answers there, inject and retry.
async function activateTab(tabId) {
  const message = { type: "party", active: true, offset, follow: Boolean(party && party.follow) };
  try {
    await chrome.tabs.sendMessage(tabId, message);
    return true;
  } catch {}
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return false;
  }
  if (!SUPPORTED_RE.test(tab.url || "")) return false; // e.g. invite page / blank tab: we navigate it instead
  await injectContent(tabId, tab.url);
  await new Promise((r) => setTimeout(r, 300));
  try {
    await chrome.tabs.sendMessage(tabId, message);
    return true;
  } catch {
    return false;
  }
}

function toTab(message) {
  if (party && party.tabId != null) chrome.tabs.sendMessage(party.tabId, message).catch(() => {});
}

// ---------------------------------------------------------------- party lifecycle

async function join({ room, name, serverUrl, tabId, follow }) {
  const saved = await chrome.storage.local.get({ name: "" });
  name = (name || saved.name || "").trim().slice(0, 40);
  if (!name) return { ok: false, error: "Pick a name first." };
  if (!/^[A-Za-z0-9-]{3,32}$/.test(room || "")) return { ok: false, error: "That party code doesn't look right." };
  if (party && party.tabId !== tabId) toTabId(party.tabId, { type: "party", active: false });
  // follow: a joiner's tab should go to whatever the host is watching.
  party = { room, name, serverUrl: serverUrl || DEFAULT_SERVER, tabId, follow: Boolean(follow) };
  peers = [];
  lastState = null;
  await chrome.storage.session.set({ party });
  // Only remember a server if the user deliberately picked a different one.
  await chrome.storage.local.set({ name: party.name, room, serverUrl: serverUrl && serverUrl !== DEFAULT_SERVER ? serverUrl : "" });
  status = "connecting";
  connect();
  const tabReady = await activateTab(tabId);
  return { ok: true, tabReady };
}

async function setName(raw) {
  const name = String(raw || "").trim().slice(0, 40);
  if (!name) return { ok: false, error: "Names can't be empty." };
  await chrome.storage.local.set({ name });
  if (party) {
    party.name = name;
    await chrome.storage.session.set({ party });
    sendRaw({ type: "rename", name });
  }
  return { ok: true };
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
        return {
          active: isParty,
          offset,
          myId,
          hostId,
          peers,
          follow: isParty && party.follow,
          state: isParty && myId ? lastState : null,
        };
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
          hostId,
          peers,
          offset,
          transport: conn ? conn.kind : null,
          defaultServer: DEFAULT_SERVER,
          saved,
        };
      }
      case "popup-join":
        return join(m);
      case "invite-join":
        // From the invite page: join in that tab, then go to the host's title.
        if (!sender.tab) return { ok: false };
        return join({ room: m.room, name: m.name, serverUrl: m.serverUrl, tabId: sender.tab.id, follow: true });
      case "popup-set-name":
        return setName(m.name);
      case "popup-leave":
        await leave();
        return { ok: true };
      default:
        return null;
    }
  })()
    .catch((e) => ({ ok: false, error: `Something went wrong: ${e && e.message ? e.message : e}` }))
    .then(sendResponse);
  return true; // async response
});
