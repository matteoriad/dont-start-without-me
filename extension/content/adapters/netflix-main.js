// Runs in Netflix's own page context ("MAIN" world), not the extension's.
//
// Netflix's player breaks (error M7375) if you set <video>.currentTime
// directly, so seeking has to go through Netflix's internal player API,
// which only exists in the page context. The Netflix adapter sends commands
// here as a DOM event: document "dswm-netflix" with a JSON string detail.
(function () {
  if (window.__dswmNetflixBridge) return;
  window.__dswmNetflixBridge = true;

  function player() {
    try {
      const vp = window.netflix.appContext.state.playerApp.getAPI().videoPlayer;
      const ids = vp.getAllPlayerSessionIds();
      if (!ids || !ids.length) return null;
      const id = ids.find((i) => i.startsWith("watch")) || ids[ids.length - 1];
      return vp.getVideoPlayerBySessionId(id);
    } catch {
      return null;
    }
  }

  document.addEventListener("dswm-netflix", (e) => {
    let cmd;
    try {
      cmd = JSON.parse(e.detail);
    } catch {
      return;
    }
    const p = player();
    if (!p) return;
    try {
      if (cmd.action === "seek") p.seek(Math.round(cmd.seconds * 1000));
      else if (cmd.action === "play") p.play();
      else if (cmd.action === "pause") p.pause();
    } catch {}
  });
})();
