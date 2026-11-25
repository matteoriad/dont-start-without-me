// The relay server built into the extension, so people never have to type it.
// Put your deployed server here, e.g. "https://watch.yourdomain.com" or
// "http://203.0.113.10:8787". (http/https, not ws — the extension picks the
// best way to connect by itself.)
// If you change it, also update the invite-page match in manifest.json
// (content_scripts → content/invite.js).
self.DSWM_CONFIG = {
  serverUrl: "https://celestial-darkgreen-hyena-82.hostingersite.com",
};
