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

  // Remember this person's own Apple country, so links from someone in
  // another country can be opened in theirs (otherwise Apple asks to pick one).
  const storefront = window.location.pathname.match(/^\/([a-z]{2})(?=\/)/i);
  if (storefront) {
    try {
      chrome.storage.local.set({ appleStorefront: storefront[1].toLowerCase() });
    } catch {}
  }

  // A link without the country part; the extension adds the right one when
  // it opens it for someone (see localizeUrl in background.js).
  function neutralUrl() {
    const u = new URL(window.location.href);
    u.pathname = u.pathname.replace(/^\/[a-z]{2}(?=\/)/i, "");
    u.search = "";
    u.hash = "";
    return u.toString();
  }

  // Searching every shadow root is expensive, so remember the last hit. Keep
  // looking every couple of seconds while we only have a short clip (trailer /
  // preview loop), since the real player may show up later.
  let cached = null;
  let lastSearch = 0;
  function findVideo() {
    const good = cached && cached.isConnected && cached.duration > 300;
    if (good || Date.now() - lastSearch < 2000) return cached && cached.isConnected ? cached : null;
    lastSearch = Date.now();
    const videos = DSWM.deepQueryAll("video");
    // Prefer the longest one (the show, not a trailer/preview loop).
    cached = DSWM.pickMainVideo(videos) || null;
    return cached;
  }

  DSWM.registerAdapter({
    name: "Apple TV",

    matches: (loc) => loc.hostname === "tv.apple.com",

    getVideo: findVideo,

    getMediaId: () => (contentId() ? `appletv:${contentId()}` : null),

    getMediaUrl: neutralUrl,

    getTitle: () => document.title.replace(/\s*[-–|]\s*Apple TV.*$/i, "").trim() || null,

    isReady: () => {
      const v = findVideo();
      return Boolean(v) && v.readyState > 0 && v.duration > 0;
    },
  });
})();
