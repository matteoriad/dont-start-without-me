// Core sync engine. Site-agnostic: everything site-specific lives in an adapter.
//
// Rules:
// - The host (whoever opened the room) is the source of truth. Joiners jump
//   to the host, and only the host sends drift-correction heartbeats.
// - Only things a person actually did (click / key press) are shared.
//   Autoplay, ads ending, players loading etc. are never broadcast.
// - Ads: an ad while you're still joining is ignored (you catch up after).
//   An ad later on pauses everyone else until it's over.
(() => {
  const DSWM = window.DSWM;
  if (!DSWM) return;
  // After an extension update, an older copy of this script may still be on
  // the page but cut off from the extension. Only stop if a *live* copy runs.
  if (DSWM.coreAlive && DSWM.coreAlive()) return;
  const alive = () => {
    try {
      return Boolean(chrome.runtime && chrome.runtime.id);
    } catch {
      return false;
    }
  };
  DSWM.coreAlive = alive;
  document.querySelectorAll("#dswm-root").forEach((el) => el.remove()); // stale UI from an old copy

  const adapter = DSWM.findAdapter();
  if (!adapter) return;
  const math = DSWM.math;

  const HEARTBEAT_MS = 2000;
  const TICK_MS = 300;
  // After we apply a remote command, the resulting play/pause/seeked events
  // are ours, not the user's. Ignore local events for this long.
  const SUPPRESS_MS = 1500;
  // A play/pause/seek only counts as the user's if they clicked or pressed a
  // key this recently.
  const GESTURE_WINDOW_MS = 2000;
  const MISMATCH_TOAST_EVERY_MS = 15000;

  let active = false;
  let offset = 0; // serverTime - Date.now(), in ms
  let myId = null;
  let hostId = null;
  let peers = [];

  let video = null;
  let controls = null;
  let suppressUntil = 0;
  let lastGestureAt = 0;
  let nudging = false;
  let pendingRemote = null;
  let lastMismatchToast = 0;
  let synced = false; // joined and lined up with the host at least once
  let helloPending = false; // host owes a newcomer a sync
  let followPending = false; // just joined: go to whatever the host is watching
  let announcedMedia = undefined; // what the host last told the room it has open
  let lastSwitchToast = 0;

  let inAd = false;
  let adAnnounced = false;
  const adPeers = new Map(); // id -> name of people currently watching an ad
  let pausedForAd = false;

  const serverNow = () => Date.now() + offset;
  const suppressed = () => Date.now() < suppressUntil;
  const suppress = () => (suppressUntil = Date.now() + SUPPRESS_MS);
  const userActed = () => Date.now() - lastGestureAt < GESTURE_WINDOW_MS;
  const isHost = () => Boolean(myId) && hostId === myId;
  const othersHere = () => peers.some((p) => p.id !== myId);
  const nameOf = (id) => (peers.find((p) => p.id === id) || {}).name || "Your partner";
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

  for (const type of ["pointerdown", "pointerup", "keydown", "keyup"]) {
    window.addEventListener(
      type,
      (e) => {
        if (e.isTrusted) lastGestureAt = Date.now();
      },
      true,
    );
  }

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
    if (!others.length) return ui.setPill("🍿 Waiting for your partner… don't start without them");
    ui.setPill(`🍿 Watching with ${others.join(", ")}${isHost() ? " · you're the host" : ""}`);
  }

  // ---------------------------------------------------------------- video binding

  function onLocal(reason) {
    if (!active || !controls || suppressed() || !adapter.isReady() || !userActed()) return;
    if (reason === "play") pausedForAd = false; // they chose to carry on
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
      mediaTitle: adapter.getTitle ? adapter.getTitle() : null,
      sentAt: serverNow(),
    };
  }

  function broadcast(reason) {
    if (!controls) return;
    stopNudge();
    send(snapshot(reason));
  }

  function send(msg) {
    if (!alive()) return;
    try {
      chrome.runtime.sendMessage({ type: "send", msg }).catch(() => {});
    } catch {}
  }

  function stopNudge() {
    if (nudging && controls) controls.setRate(1);
    nudging = false;
  }

  // The host tells the room what it has open, even before pressing play, so
  // joiners can open the same thing and the invite page can show it.
  function announceWhere(force) {
    if (!active || !isHost()) return;
    const mediaId = adapter.getMediaId();
    if (!mediaId || (!force && mediaId === announcedMedia)) return;
    announcedMedia = mediaId;
    send({
      type: "where",
      mediaId,
      mediaUrl: adapter.getMediaUrl(),
      mediaTitle: adapter.getTitle ? adapter.getTitle() : null,
    });
  }

  function trySendHello() {
    if (helloPending && isHost() && controls && adapter.isReady()) {
      helloPending = false;
      broadcast("hello");
    }
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
    // Only the host corrects drift.
    if (msg.reason === "heartbeat" && msg.from !== hostId) return;
    const name = msg.fromName || "Your partner";

    const mine = adapter.getMediaId();
    // Different thing playing (or nothing playing at all) → offer to join them.
    // If our page is playing but can't tell what it is, assume it's the same.
    if (msg.mediaId && mine !== msg.mediaId && (mine || !adapter.isReady())) {
      if (followPending && msg.mediaUrl) {
        // We just joined: go straight to the host's title, no questions asked.
        followPending = false;
        window.location.href = msg.mediaUrl;
        return;
      }
      if (msg.mediaUrl && Date.now() - lastMismatchToast > MISMATCH_TOAST_EVERY_MS) {
        lastMismatchToast = Date.now();
        ui.toast(`${name} is watching something else.`, {
          label: "Join them",
          onClick: () => (window.location.href = msg.mediaUrl),
        });
      }
      return;
    }

    followPending = false; // we're on the right title
    if (!controls || !adapter.isReady()) {
      pendingRemote = msg; // apply once the ad / loading screen is gone
      return;
    }

    synced = true;
    const target = math.expectedPosition(msg, serverNow());
    const local = controls.getTime();
    const isHeartbeat = msg.reason === "heartbeat";

    // While we're holding for someone's ad, don't let a heartbeat restart us.
    const wantPlaying = msg.playing && !(isHeartbeat && pausedForAd);

    if (wantPlaying && controls.isPaused()) {
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

  function handleWhere(msg) {
    if (!active || msg.from === myId || !msg.mediaUrl) return;
    const mine = adapter.getMediaId();
    if (mine && mine === msg.mediaId) {
      followPending = false;
      return;
    }
    if (followPending) {
      followPending = false;
      window.location.href = msg.mediaUrl;
      return;
    }
    if (msg.from === hostId && Date.now() - lastSwitchToast > 5000) {
      lastSwitchToast = Date.now();
      ui.toast(`${msg.fromName || "The host"} switched to something else.`, {
        label: "Join them",
        onClick: () => (window.location.href = msg.mediaUrl),
      });
    }
  }

  function resumeIfAdsDone(name) {
    if (adPeers.size > 0 || !pausedForAd) return;
    pausedForAd = false;
    if (controls && controls.isPaused()) {
      suppress();
      controls.play();
    }
    if (name) ui.toast(`${name}'s ad is over. Back to it.`);
  }

  function handleAd(msg) {
    const name = msg.fromName || nameOf(msg.from);
    if (msg.active) {
      adPeers.set(msg.from, name);
      ui.toast(`${name} got an ad. Waiting for them…`);
      if (controls && !controls.isPaused()) {
        suppress();
        controls.pause();
        pausedForAd = true;
      }
    } else {
      adPeers.delete(msg.from);
      resumeIfAdsDone(name);
    }
  }

  // Our own ad started or ended.
  function onOwnAd(nowInAd) {
    if (nowInAd) {
      // An ad while still joining doesn't hold anyone up; we catch up after.
      if (synced && othersHere()) {
        adAnnounced = true;
        send({ type: "ad", active: true });
        ui.toast("Ad break. The others are waiting for you.");
      }
    } else if (adAnnounced) {
      adAnnounced = false;
      send({ type: "ad", active: false });
    }
  }

  function handleServer(msg) {
    switch (msg.type) {
      case "joined":
        myId = msg.you;
        hostId = msg.hostId || null;
        peers = msg.peers || [];
        synced = isHost();
        // The host tells the room what's playing right away, so the invite page
        // can show it and joiners know where to go.
        if (isHost()) {
          helloPending = true;
          announceWhere(true);
        } else if (msg.where) {
          handleWhere(msg.where);
        }
        updatePill();
        // Joiners wait for the host's "hello" rather than trusting old room state.
        break;
      case "presence":
        peers = msg.peers || [];
        if (msg.hostId) hostId = msg.hostId;
        if (isHost()) {
          synced = true;
          announceWhere(false); // e.g. we just became host
        }
        updatePill();
        if (msg.event === "joined") {
          ui.toast(`${msg.who} joined. Now you can start.`);
          if (isHost()) {
            helloPending = true; // bring the newcomer to where we are
            trySendHello();
          }
        } else if (msg.event === "left") {
          ui.toast(`${msg.who} left. Rude.`);
          if (msg.whoId && adPeers.delete(msg.whoId)) resumeIfAdsDone(null);
        }
        break;
      case "state":
        applyRemote(msg);
        break;
      case "ad":
        handleAd(msg);
        break;
      case "where":
        handleWhere(msg);
        break;
      case "error":
        ui.toast(`Hmm: ${msg.error}`);
        break;
    }
  }

  function reset() {
    stopNudge();
    pendingRemote = null;
    synced = false;
    helloPending = false;
    followPending = false;
    announcedMedia = undefined;
    adAnnounced = false;
    adPeers.clear();
    pausedForAd = false;
  }

  function setParty(info) {
    const wasActive = active;
    active = Boolean(info.active);
    if (typeof info.offset === "number") offset = info.offset;
    if (info.myId) myId = info.myId;
    if (info.hostId) hostId = info.hostId;
    if (info.peers) peers = info.peers;
    if (typeof info.follow === "boolean") followPending = info.follow;
    if (!active) reset();
    if (active && isHost()) {
      synced = true;
      announceWhere(true);
    }
    updatePill();
    // After a page reload mid-party, catch up with the latest known state.
    if (active && !wasActive && info.state && !isHost()) applyRemote(info.state);
  }

  chrome.runtime.onMessage.addListener((m) => {
    if (m.type === "party") setParty(m);
    else if (m.type === "offset") offset = m.offset;
    else if (m.type === "server") handleServer(m.msg);
  });

  // ---------------------------------------------------------------- loops

  setInterval(() => {
    bind();
    const ad = Boolean(adapter.isAd && adapter.isAd());
    if (ad !== inAd) {
      inAd = ad;
      if (active) onOwnAd(ad);
    }
    if (!active) return;
    announceWhere(false);
    if (pendingRemote && controls && adapter.isReady()) {
      const m = pendingRemote;
      pendingRemote = null;
      applyRemote(m);
    }
    trySendHello();
  }, TICK_MS);

  setInterval(() => {
    if (active && isHost() && othersHere() && controls && adapter.isReady() && !controls.isPaused()) {
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
