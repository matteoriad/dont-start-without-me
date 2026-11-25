// Shahid adapter (shahid.mbc.net). A regular HTML5 player: find the main
// <video> (the longest one, so ad/preview clips are skipped).
(function () {
  const DSWM = window.DSWM;

  // Player URLs look like /en/player/episodes/Some-Show-S1-E3/id-1234567
  // (or /ar/…). The numeric id is the same for everyone; the language isn't.
  function contentId() {
    const m = window.location.pathname.match(/\/player\/.*?id-(\d+)/i);
    return m ? m[1] : null;
  }

  function findVideo() {
    if (!contentId()) return null;
    const videos = DSWM.deepQueryAll("video");
    return DSWM.pickMainVideo(videos) || null;
  }

  DSWM.registerAdapter({
    name: "Shahid",

    matches: (loc) => /(^|\.)shahid\.mbc\.net$/.test(loc.hostname),

    getVideo: findVideo,

    getMediaId: () => (contentId() ? `shahid:${contentId()}` : null),

    getMediaUrl: () => {
      const u = new URL(window.location.href);
      u.search = "";
      u.hash = "";
      return u.toString();
    },

    getTitle: () =>
      document.title
        .replace(/\s*[-|]\s*(Shahid|شاهد).*$/i, "")
        .replace(/^(Watch|شاهد)\s+/i, "")
        .trim() || null,

    isReady: () => {
      const v = findVideo();
      return Boolean(v) && v.readyState > 0 && v.duration > 0;
    },
  });
})();
