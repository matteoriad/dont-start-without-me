const $ = (id) => document.getElementById(id);
const $$ = (sel) => document.querySelectorAll(sel);

const ROOM_RE = /^[A-Za-z0-9-]{3,32}$/;
const SUPPORTED_RE = /^https:\/\/((www\.|m\.)?youtube\.com|www\.netflix\.com|tv\.apple\.com|shahid\.mbc\.net)\//;

const WORDS_A = ["nile", "spree", "popcorn", "couch", "snack", "remote", "blanket", "koshary", "pretzel"];
const WORDS_B = ["party", "night", "club", "date", "gang", "crew"];

function randomRoom() {
  const pick = (a) => a[Math.floor(Math.random() * a.length)];
  return `${pick(WORDS_A)}-${pick(WORDS_B)}-${Math.floor(10 + Math.random() * 90)}`;
}

// People paste whole invite links into the code box too.
function codeFrom(input) {
  const s = input.trim();
  const m = s.match(/\/join\/([A-Za-z0-9-]{3,32})/);
  return (m ? m[1] : s).toLowerCase();
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

let filledForm = false;
let localError = "";
let renaming = false;
let last = null;

function statusText(s) {
  if (s.status === "connected") return "Connected.";
  if (s.status === "connecting") return "Connecting…";
  if (s.status === "reconnecting") return "Connection lost, reconnecting…";
  if (s.status === "error") return "Something's wrong.";
  return "Not connected.";
}

function inviteUrl(s) {
  const base = (s.party && s.party.serverUrl) || s.defaultServer;
  return new URL(`/join/${s.party.room}`, base).toString();
}

function showOnly(id) {
  for (const v of ["name-view", "join-view", "party-view", "rename-view"]) $(v).hidden = v !== id;
}

async function render() {
  const s = await chrome.runtime.sendMessage({ type: "popup-get" });
  last = s;
  $("error").textContent = localError || s.lastError || "";
  $$(".my-name").forEach((el) => (el.textContent = s.saved.name));

  if (renaming) return showOnly("rename-view");
  if (!s.saved.name) {
    showOnly("name-view");
    return;
  }

  if (!s.party) {
    showOnly("join-view");
    if (!filledForm) {
      $("server").value = s.saved.serverUrl;
      $("server").placeholder = s.defaultServer;
      filledForm = true;
    }
    const tab = await activeTab();
    const onVideoSite = Boolean(tab && tab.url && SUPPORTED_RE.test(tab.url));
    $("start").disabled = !onVideoSite;
    $("start-hint").textContent = onVideoSite ? "" : "To start one, open YouTube, Netflix, Apple TV or Shahid in this tab.";
    return;
  }

  showOnly("party-view");
  $("room-code").textContent = s.party.room;
  $("status").textContent = statusText(s);
  const list = $("peers");
  list.replaceChildren();
  for (const p of s.peers) {
    const li = document.createElement("li");
    const tags = [p.id === s.myId && "you", p.id === s.hostId && "host"].filter(Boolean);
    li.textContent = tags.length ? `${p.name} (${tags.join(", ")})` : p.name;
    list.appendChild(li);
  }
  if (s.status === "connected" && !s.peers.some((p) => p.id !== s.myId)) {
    const li = document.createElement("li");
    li.className = "muted";
    li.textContent = "Waiting for them to join…";
    list.appendChild(li);
  }
}

async function joinRoom(room, { start }) {
  localError = "";
  if (!ROOM_RE.test(room)) {
    localError = "Party codes are 3–32 letters, numbers or dashes.";
    $("error").textContent = localError;
    return;
  }
  const tab = await activeTab();
  const res = await chrome.runtime.sendMessage({
    type: "popup-join",
    room,
    serverUrl: $("server").value.trim(),
    tabId: tab.id,
    follow: !start, // joiners go to whatever the host is watching
  });
  if (res && res.ok === false) localError = res.error;
  else if (res && !res.tabReady && start) localError = "Reload this tab once so the extension can hook into the player.";
  render();
}

async function saveName(value) {
  const res = await chrome.runtime.sendMessage({ type: "popup-set-name", name: value });
  if (!res.ok) {
    localError = res.error;
    $("error").textContent = localError;
    return false;
  }
  localError = "";
  return true;
}

// first run
$("save-first-name").addEventListener("click", async () => {
  if (await saveName($("first-name").value)) render();
});
$("first-name").addEventListener("keydown", (e) => e.key === "Enter" && $("save-first-name").click());

// rename
$$(".edit-name").forEach((b) =>
  b.addEventListener("click", () => {
    renaming = true;
    $("rename").value = last ? last.saved.name : "";
    render().then(() => $("rename").select());
  }),
);
$("save-rename").addEventListener("click", async () => {
  if (await saveName($("rename").value)) {
    renaming = false;
    render();
  }
});
$("rename").addEventListener("keydown", (e) => e.key === "Enter" && $("save-rename").click());
$("cancel-rename").addEventListener("click", () => {
  renaming = false;
  localError = "";
  render();
});

// start / join
$("start").addEventListener("click", () => joinRoom(randomRoom(), { start: true }));
$("join").addEventListener("click", () => joinRoom(codeFrom($("room").value), { start: false }));
$("room").addEventListener("keydown", (e) => e.key === "Enter" && $("join").click());

$("leave").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "popup-leave" });
  filledForm = false;
  localError = "";
  render();
});

$("copy-invite").addEventListener("click", async () => {
  if (!last || !last.party) return;
  await navigator.clipboard.writeText(inviteUrl(last));
  $("copy-invite").textContent = "Copied! Send it over";
  setTimeout(() => ($("copy-invite").textContent = "Copy invite link"), 1600);
});

render().then(() => {
  if (!$("name-view").hidden) $("first-name").focus();
});
setInterval(() => {
  if (!renaming) render();
}, 1000);
