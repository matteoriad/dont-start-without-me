const $ = (id) => document.getElementById(id);

const ROOM_RE = /^[A-Za-z0-9-]{3,32}$/;
const SUPPORTED_RE = /^https:\/\/((www\.|m\.)?youtube\.com|www\.netflix\.com|tv\.apple\.com)\//;

const WORDS_A = ["nile", "spree", "popcorn", "couch", "snack", "remote", "blanket", "koshary", "pretzel"];
const WORDS_B = ["party", "night", "club", "date", "gang", "crew"];

function randomRoom() {
  const pick = (a) => a[Math.floor(Math.random() * a.length)];
  return `${pick(WORDS_A)}-${pick(WORDS_B)}-${Math.floor(10 + Math.random() * 90)}`;
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

let filledForm = false;
let localError = "";

function statusText(s) {
  if (s.status === "connected") return "Connected.";
  if (s.status === "connecting") return "Connecting…";
  if (s.status === "reconnecting") return "Connection lost, reconnecting…";
  if (s.status === "error") return "Something's wrong.";
  return "Not connected.";
}

async function render() {
  const s = await chrome.runtime.sendMessage({ type: "popup-get" });
  const inParty = Boolean(s.party);
  $("join-view").hidden = inParty;
  $("party-view").hidden = !inParty;
  $("error").textContent = localError || s.lastError || "";

  if (!inParty) {
    if (!filledForm) {
      $("name").value = s.saved.name;
      $("server").value = s.saved.serverUrl;
      $("server").placeholder = s.defaultServer;
      filledForm = true;
    }
    const tab = await activeTab();
    const supported = Boolean(tab && tab.url && SUPPORTED_RE.test(tab.url));
    $("start").disabled = $("join").disabled = !supported;
    $("join-hint").textContent = supported ? "" : "Open a YouTube, Netflix or Apple TV video in this tab first.";
    return;
  }

  $("room-code").textContent = s.party.room;
  $("status").textContent = statusText(s);
  const list = $("peers");
  list.replaceChildren();
  const others = s.peers.filter((p) => p.id !== s.myId);
  for (const p of s.peers) {
    const li = document.createElement("li");
    const tags = [p.id === s.myId && "you", p.id === s.hostId && "host"].filter(Boolean);
    li.textContent = tags.length ? `${p.name} (${tags.join(", ")})` : p.name;
    list.appendChild(li);
  }
  if (s.status === "connected" && others.length === 0) {
    const li = document.createElement("li");
    li.className = "muted";
    li.textContent = "Waiting for them to join…";
    list.appendChild(li);
  }
}

async function joinRoom(room) {
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
    name: $("name").value.trim(),
    serverUrl: $("server").value.trim(),
    tabId: tab.id,
  });
  if (res && !res.tabReady) localError = "Reload this tab once so the extension can hook into the player.";
  render();
}

$("start").addEventListener("click", () => joinRoom(randomRoom()));
$("join").addEventListener("click", () => joinRoom($("room").value.trim().toLowerCase()));
$("room").addEventListener("keydown", (e) => e.key === "Enter" && $("join").click());

$("leave").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "popup-leave" });
  filledForm = false;
  localError = "";
  render();
});

$("copy").addEventListener("click", async () => {
  await navigator.clipboard.writeText($("room-code").textContent);
  $("copy").textContent = "Copied";
  setTimeout(() => ($("copy").textContent = "Copy"), 1200);
});

render();
setInterval(render, 1000);
