// YouTube adapter. YouTube is friendly: the plain <video> element can be
// controlled directly, so we only need to find it and detect ads.
(function () {
  const DSWM = window.DSWM;

  function videoId() {
    const url = new URL(window.location.href);
    const v = url.searchParams.get("v");
    if (v) return v;
    const shorts = url.pathname.match(/^\/shorts\/([^/?#]+)/);
    return shorts ? shorts[1] : null;
  }

  function isAdShowing() {
    const player = document.querySelector("#movie_player");
    return Boolean(player) && player.classList.contains("ad-showing");
  }

  DSWM.registerAdapter({
    name: "YouTube",

    matches: (loc) => /(^|\.)youtube\.com$/.test(loc.hostname),

    getVideo: () =>
      document.querySelector("#movie_player video.html5-main-video") ||
      document.querySelector("video.html5-main-video"),

    getMediaId: videoId,

    getTitle: () => document.title.replace(/^\(\d+\)\s*/, "").replace(/\s*-\s*YouTube\s*$/, "") || null,

    getMediaUrl: () => {
      const id = videoId();
      return id ? `https://www.youtube.com/watch?v=${id}` : window.location.href;
    },

    // While an ad plays, the <video> element is playing the ad, not the video.
    isAd: isAdShowing,

    isReady: () => Boolean(document.querySelector("#movie_player")) && !isAdShowing() && Boolean(videoId()),
  });
})();
