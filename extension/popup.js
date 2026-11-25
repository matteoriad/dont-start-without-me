const $ = (id) => document.getElementById(id);

const STATUS_TEXT = {
  idle: "Not connected.",
  connecting: "Connecting…",
  connected: "Connected.",
  reconnecting: "Connection lost, reconnecting…",
  error: "Something's wrong.",
};

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

async function render() {
  const s = await chrome.runtime.sendMessage({ type: "popup-get" });
  const inParty = Boolean(s.party);
  $("join-view").hidden = inParty;
  $("party-view").hidden = !inParty;
  $("error").textContent = localError || s.lastError || "";

  if (!inParty) {
    if (!filledForm) {
      $("name").value = s.saved.name;
      $("room").value = s.saved.room;
      $("server").value = s.saved.serverUrl;
      filledForm = true;
    }
    const tab = await activeTab();
    const supported = tab && tab.url && /^https:\/\/(www\.|m\.)?youtube\.com\//.test(tab.url);
    $("join").disabled = !supported;
    $("join-hint").textContent = supported ? "" : "Open a YouTube video in this tab first. (More sites coming.)";
    return;
  }

  $("room-code").textContent = s.party.room;
  $("status").textContent = STATUS_TEXT[s.status] || s.status;
  const list = $("peers");
  list.replaceChildren();
  const others = s.peers.filter((p) => p.id !== s.myId);
  if (s.status === "connected" && others.length === 0) {
    const li = document.createElement("li");
    li.textContent = "Nobody else yet. Send them the room code.";
    list.appendChild(li);
  }
  for (const p of s.peers) {
    const li = document.createElement("li");
    li.textContent = p.id === s.myId ? `${p.name} (you)` : p.name;
    list.appendChild(li);
  }
}

$("dice").addEventListener("click", () => {
  $("room").value = randomRoom();
});

$("join").addEventListener("click", async () => {
  const room = $("room").value.trim() || randomRoom();
  $("room").value = room;
  if (!/^[A-Za-z0-9-]{3,32}$/.test(room)) {
    localError = "Room codes are 3–32 letters, numbers or dashes.";
    $("error").textContent = localError;
    return;
  }
  localError = "";
  const tab = await activeTab();
  const res = await chrome.runtime.sendMessage({
    type: "popup-join",
    room,
    name: $("name").value.trim(),
    serverUrl: $("server").value.trim(),
    tabId: tab.id,
  });
  if (res && !res.tabReady) {
    localError = "Reload this tab once so the extension can hook into the player.";
  }
  render();
});

$("leave").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "popup-leave" });
  filledForm = false;
  localError = "";
  render();
});

$("copy").addEventListener("click", async () => {
  await navigator.clipboard.writeText($("room-code").textContent);
  $("copy").textContent = "✅";
  setTimeout(() => ($("copy").textContent = "📋"), 1200);
});

render();
setInterval(render, 1000);
