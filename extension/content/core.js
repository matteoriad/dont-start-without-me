// Core sync engine. Site-agnostic: everything site-specific lives in an adapter.
//
// Model: whoever acted last (play/pause/seek) is the "leader". The leader sends
// a heartbeat every couple of seconds while playing; everyone else corrects
// drift towards it (small drift: nudge playback speed, big drift: seek).
(() => {
  const DSWM = window.DSWM;
  if (!DSWM || DSWM.coreStarted) return;
  DSWM.coreStarted = true;

  const adapter = DSWM.findAdapter();
  if (!adapter) return;
  const math = DSWM.math;

  const HEARTBEAT_MS = 2000;
  const TICK_MS = 500;
  // After we apply a remote command, the resulting play/pause/seeked events
  // are ours, not the user's. Ignore local events for this long.
  const SUPPRESS_MS = 1500;
  const MISMATCH_TOAST_EVERY_MS = 15000;

  let active = false;
  let offset = 0; // serverTime - Date.now(), in ms
  let myId = null;
  let peers = [];
  let leaderId = null;

  let video = null;
  let controls = null;
  let suppressUntil = 0;
  let nudging = false;
  let pendingRemote = null;
  let lastMismatchToast = 0;

  const serverNow = () => Date.now() + offset;
  const suppressed = () => Date.now() < suppressUntil;
  const suppress = () => (suppressUntil = Date.now() + SUPPRESS_MS);
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

  // ---------------------------------------------------------------- UI

  const ui = (() => {
    let root = null;
    let pill = null;
    function ensure() {
      if (root && document.documentElement.contains(root)) return;
      root = document.createElement("div");
      root.id = "dswm-root";
      Object.assign(root.style, {
        position: "fixed",
        top: "72px",
        right: "16px",
        zIndex: "2147483647",
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-end",
        gap: "8px",
        pointerEvents: "none",
        font: "500 14px/1.35 system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
      });
      pill = document.createElement("div");
      Object.assign(pill.style, bubbleStyle("rgba(20,20,20,.72)"));
      pill.style.display = "none";
      root.appendChild(pill);
      document.documentElement.appendChild(root);
    }
    function bubbleStyle(bg) {
      return {
        background: bg,
        color: "#fff",
        padding: "8px 12px",
        borderRadius: "12px",
        boxShadow: "0 4px 16px rgba(0,0,0,.3)",
        maxWidth: "320px",
        pointerEvents: "auto",
        transition: "opacity .3s",
      };
    }
    return {
      setPill(text) {
        ensure();
        pill.textContent = text || "";
        pill.style.display = text ? "block" : "none";
      },
      toast(text, action) {
        ensure();
        const el = document.createElement("div");
        Object.assign(el.style, bubbleStyle("rgba(229,9,80,.92)"));
        el.textContent = text;
        if (action) {
          const btn = document.createElement("button");
          btn.textContent = action.label;
          Object.assign(btn.style, {
            marginLeft: "10px",
            background: "#fff",
            color: "#111",
            border: "0",
            borderRadius: "8px",
            padding: "4px 10px",
            font: "inherit",
            cursor: "pointer",
          });
          btn.addEventListener("click", action.onClick);
          el.appendChild(btn);
        }
        root.appendChild(el);
        setTimeout(() => (el.style.opacity = "0"), action ? 9000 : 3500);
        setTimeout(() => el.remove(), action ? 9400 : 3900);
      },
    };
  })();

  function updatePill() {
    if (!active) return ui.setPill(null);
    const others = peers.filter((p) => p.id !== myId).map((p) => p.name);
    ui.setPill(others.length ? `🍿 Watching with ${others.join(", ")}` : "🍿 Waiting for your partner… don't start without them");
  }

  // ---------------------------------------------------------------- video binding

  function onLocal(reason) {
    if (!active || !controls || suppressed() || !adapter.isReady()) return;
    broadcast(reason);
  }
  const onPlay = () => onLocal("play");
  const onPause = () => onLocal("pause");
  const onSeeked = () => onLocal("seek");

  function bind() {
    const v = adapter.getVideo();
    if (v === video) return;
    if (video) {
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("seeked", onSeeked);
    }
    video = v;
    controls = v ? (adapter.controls ? adapter.controls(v) : DSWM.videoControls(v)) : null;
    nudging = false;
    if (v) {
      v.addEventListener("play", onPlay);
      v.addEventListener("pause", onPause);
      v.addEventListener("seeked", onSeeked);
    }
  }

  // ---------------------------------------------------------------- sending

  function snapshot(reason) {
    return {
      type: "state",
      reason,
      playing: !controls.isPaused(),
      position: controls.getTime(),
      mediaId: adapter.getMediaId(),
      mediaUrl: adapter.getMediaUrl(),
      sentAt: serverNow(),
    };
  }

  function broadcast(reason) {
    if (!controls) return;
    leaderId = myId;
    stopNudge();
    send(snapshot(reason));
  }

  function send(msg) {
    chrome.runtime.sendMessage({ type: "send", msg }).catch(() => {});
  }

  function stopNudge() {
    if (nudging && controls) controls.setRate(1);
    nudging = false;
  }

  // ---------------------------------------------------------------- receiving

  const PAUSE_LINES = [
    (n) => `${n} paused. Probably snacks.`,
    (n) => `${n} paused. Bathroom break, presumably.`,
    (n) => `${n} paused. Don't start without them.`,
    (n) => `${n} paused.`,
  ];

  function describe(msg, target) {
    const n = msg.fromName || "Your partner";
    switch (msg.reason) {
      case "play":
        return `${n} pressed play.`;
      case "pause":
        return pick(PAUSE_LINES)(n);
      case "seek":
        return `${n} jumped to ${math.formatTime(target)}. Wait, go back?`;
      case "hello":
        return `Synced with ${n}.`;
      default:
        return null;
    }
  }

  function applyRemote(msg) {
    if (!active || msg.from === myId) return;
    const name = msg.fromName || "Your partner";

    const mine = adapter.getMediaId();
    if (msg.mediaId && mine !== msg.mediaId) {
      if (msg.mediaUrl && Date.now() - lastMismatchToast > MISMATCH_TOAST_EVERY_MS) {
        lastMismatchToast = Date.now();
        ui.toast(`${name} is watching something else.`, {
          label: "Join them",
          onClick: () => (window.location.href = msg.mediaUrl),
        });
      }
      return;
    }

    if (!controls || !adapter.isReady()) {
      pendingRemote = msg; // apply once the ad / loading screen is gone
      return;
    }

    leaderId = msg.from;
    const target = math.expectedPosition(msg, serverNow());
    const local = controls.getTime();
    const isHeartbeat = msg.reason === "heartbeat";

    if (msg.playing && controls.isPaused()) {
      suppress();
      controls.play();
    } else if (!msg.playing && !controls.isPaused()) {
      suppress();
      controls.pause();
    }

    if (!msg.playing) {
      stopNudge();
      if (Math.abs(target - local) > 0.25) {
        suppress();
        controls.seek(target);
      }
    } else if (isHeartbeat) {
      const c = math.correction(local, target, nudging);
      if (c.action === "seek") {
        stopNudge();
        suppress();
        controls.seek(c.to);
      } else if (c.action === "rate") {
        nudging = true;
        controls.setRate(c.rate);
      } else {
        stopNudge();
      }
    } else {
      stopNudge();
      if (Math.abs(target - local) > 0.5) {
        suppress();
        controls.seek(target);
      }
    }

    if (!isHeartbeat) {
      const text = describe(msg, target);
      if (text) ui.toast(text);
    }
  }

  function handleServer(msg) {
    switch (msg.type) {
      case "joined":
        myId = msg.you;
        peers = msg.peers || [];
        updatePill();
        if (msg.state) applyRemote(msg.state);
        break;
      case "presence":
        peers = msg.peers || [];
        updatePill();
        if (msg.event === "joined") {
          ui.toast(`${msg.who} joined. Now you can start.`);
          // Bring the newcomer up to speed — only one person needs to do this.
          if ((leaderId === null || leaderId === myId) && controls && adapter.isReady()) broadcast("hello");
        } else if (msg.event === "left") {
          ui.toast(`${msg.who} left. Rude.`);
        }
        break;
      case "state":
        applyRemote(msg);
        break;
      case "error":
        ui.toast(`Hmm: ${msg.error}`);
        break;
    }
  }

  function setParty(info) {
    const wasActive = active;
    active = Boolean(info.active);
    if (typeof info.offset === "number") offset = info.offset;
    if (info.myId) myId = info.myId;
    if (info.peers) peers = info.peers;
    if (!active) {
      stopNudge();
      pendingRemote = null;
      leaderId = null;
    }
    updatePill();
    if (active && !wasActive && info.state) applyRemote(info.state);
  }

  chrome.runtime.onMessage.addListener((m) => {
    if (m.type === "party") setParty(m);
    else if (m.type === "offset") offset = m.offset;
    else if (m.type === "server") handleServer(m.msg);
  });

  // ---------------------------------------------------------------- loops

  setInterval(() => {
    bind();
    if (active && pendingRemote && controls && adapter.isReady()) {
      const m = pendingRemote;
      pendingRemote = null;
      applyRemote(m);
    }
  }, TICK_MS);

  setInterval(() => {
    if (active && leaderId === myId && controls && adapter.isReady() && !controls.isPaused()) {
      send(snapshot("heartbeat"));
    }
  }, HEARTBEAT_MS);

  bind();
  // Ask the background whether this tab is the party tab (e.g. after a reload).
  chrome.runtime
    .sendMessage({ type: "tab-hello", adapter: adapter.name })
    .then((info) => info && setParty(info))
    .catch(() => {});
})();
