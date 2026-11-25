// Netflix adapter. Reading the <video> element is fine, but seeking must go
// through Netflix's own player (see netflix-main.js), otherwise playback
// errors out.
(function () {
  const DSWM = window.DSWM;

  function titleId() {
    const m = window.location.pathname.match(/^\/watch\/(\d+)/);
    return m ? m[1] : null;
  }

  function command(action, extra) {
    document.dispatchEvent(new CustomEvent("dswm-netflix", { detail: JSON.stringify({ action, ...extra }) }));
  }

  DSWM.registerAdapter({
    name: "Netflix",

    matches: (loc) => /(^|\.)netflix\.com$/.test(loc.hostname),

    getVideo: () => (titleId() ? document.querySelector("video") : null),

    // Netflix title ids are the same in every country.
    getMediaId: () => (titleId() ? `netflix:${titleId()}` : null),

    getTitle: () => {
      // The player shows "Show  E3 Episode name" in its title bar when controls are visible.
      const el = document.querySelector('[data-uia="video-title"]');
      const t = el ? el.textContent.trim() : "";
      return t || null;
    },

    getMediaUrl: () => (titleId() ? `https://www.netflix.com/watch/${titleId()}` : window.location.href),

    isReady: () => {
      const v = titleId() && document.querySelector("video");
      return Boolean(v) && v.readyState > 0;
    },

    controls: (video) => ({
      play: () => command("play"),
      pause: () => command("pause"),
      seek: (t) => command("seek", { seconds: t }),
      getTime: () => video.currentTime,
      isPaused: () => video.paused,
      setRate: (r) => {
        video.playbackRate = r;
      },
    }),
  });
})();
