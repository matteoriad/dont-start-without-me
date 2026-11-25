// Apple TV adapter (tv.apple.com in the browser). Apple's player hides the
// <video> element inside shadow DOM, so we search through shadow roots.
(function () {
  const DSWM = window.DSWM;

  // Apple's content ids look like "umc.cmc.1abc23def…" and are the same in
  // every country; the URL's country part (/de/, /eg/, …) is not.
  function contentId() {
    const ids = window.location.href.match(/umc\.cmc\.[a-z0-9]+/gi);
    return ids ? ids[ids.length - 1] : null;
  }

  // Searching every shadow root is expensive, so remember the last hit and
  // only search again every couple of seconds if it's gone.
  let cached = null;
  let lastSearch = 0;
  function findVideo() {
    if (cached && cached.isConnected) return cached;
    if (Date.now() - lastSearch < 2000) return null;
    lastSearch = Date.now();
    const videos = DSWM.deepQueryAll("video");
    // Prefer the longest one (the show, not a trailer/preview loop).
    cached = videos.sort((a, b) => (b.duration || 0) - (a.duration || 0))[0] || null;
    return cached;
  }

  DSWM.registerAdapter({
    name: "Apple TV",

    matches: (loc) => loc.hostname === "tv.apple.com",

    getVideo: findVideo,

    getMediaId: () => (contentId() ? `appletv:${contentId()}` : null),

    getMediaUrl: () => window.location.href,

    getTitle: () => document.title.replace(/\s*[-–|]\s*Apple TV.*$/i, "").trim() || null,

    isReady: () => {
      const v = findVideo();
      return Boolean(v) && v.readyState > 0 && v.duration > 0;
    },
  });
})();
