// Adapter registry.
//
// An adapter teaches the core how to talk to one streaming site. It must provide:
//
//   name                 display name, e.g. "YouTube"
//   matches(location)    true if this adapter handles the current page
//   getVideo()           the <video> element to sync, or null
//   getMediaId()         stable id of what's playing (so we know you're watching the same thing)
//   getMediaUrl()        a URL the partner can open to get to the same thing
//   getTitle()           OPTIONAL. human title for the invite page ("Inception")
//   isReady()            false while ads/loading screens are showing
//   isAd()               OPTIONAL. true while an ad is playing (lets the party wait for you)
//   controls(video)      OPTIONAL. Return {play, pause, seek, getTime, isPaused, setRate}
//                        if the site breaks when you poke <video> directly (Netflix does).
//                        Defaults to DSWM.videoControls(video).
(function () {
  const DSWM = (window.DSWM = window.DSWM || {});
  // Fresh list on every injection (the extension may re-inject after an update).
  DSWM.adapters = [];

  DSWM.registerAdapter = (adapter) => DSWM.adapters.push(adapter);

  DSWM.findAdapter = () => DSWM.adapters.find((a) => a.matches(window.location)) || null;

  // querySelectorAll that also looks inside shadow roots — including closed
  // ones, which only extensions can open (chrome.dom.openOrClosedShadowRoot).
  function shadowOf(el) {
    try {
      if (chrome.dom && chrome.dom.openOrClosedShadowRoot) return chrome.dom.openOrClosedShadowRoot(el);
    } catch {}
    return el.shadowRoot;
  }
  DSWM.deepQueryAll = (selector, root = document) => {
    const out = [...root.querySelectorAll(selector)];
    for (const el of root.querySelectorAll("*")) {
      const sr = shadowOf(el);
      if (sr) out.push(...DSWM.deepQueryAll(selector, sr));
    }
    return out;
  };

  // The main video among several (ads, previews, trailers): the longest one,
  // and among similar lengths the biggest on screen.
  DSWM.pickMainVideo = (videos) => {
    const area = (v) => {
      const r = v.getBoundingClientRect();
      return r.width * r.height;
    };
    const dur = (v) => (isFinite(v.duration) ? v.duration : 0);
    return (
      [...videos].sort((a, b) => {
        const d = dur(b) - dur(a);
        if (Math.abs(d) > 30) return d;
        return area(b) - area(a);
      })[0] || null
    );
  };

  // Default controls: talk to the HTML5 <video> element directly.
  DSWM.videoControls = (video) => ({
    play: () => video.play().catch(() => {}),
    pause: () => video.pause(),
    seek: (t) => {
      video.currentTime = t;
    },
    getTime: () => video.currentTime,
    isPaused: () => video.paused,
    setRate: (r) => {
      video.playbackRate = r;
    },
  });
})();
