// Adapter registry.
//
// An adapter teaches the core how to talk to one streaming site. It must provide:
//
//   name                 display name, e.g. "YouTube"
//   matches(location)    true if this adapter handles the current page
//   getVideo()           the <video> element to sync, or null
//   getMediaId()         stable id of what's playing (so we know you're watching the same thing)
//   getMediaUrl()        a URL the partner can open to get to the same thing
//   isReady()            false while ads/loading screens are showing
//   controls(video)      OPTIONAL. Return {play, pause, seek, getTime, isPaused, setRate}
//                        if the site breaks when you poke <video> directly (Netflix does).
//                        Defaults to DSWM.videoControls(video).
(function () {
  const DSWM = (window.DSWM = window.DSWM || {});
  DSWM.adapters = DSWM.adapters || [];

  DSWM.registerAdapter = (adapter) => DSWM.adapters.push(adapter);

  DSWM.findAdapter = () => DSWM.adapters.find((a) => a.matches(window.location)) || null;

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
