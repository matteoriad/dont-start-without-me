// Runs on the relay's invite page (/join/<code>). Tells the page the extension
// is installed (and the saved name), and joins the party when the page asks.
(function () {
  if (!/^\/join\/[A-Za-z0-9-]{3,32}\/?$/.test(location.pathname)) return;

  async function announce() {
    const { name = "" } = await chrome.storage.local.get({ name: "" });
    document.dispatchEvent(new CustomEvent("dswm-ready", { detail: JSON.stringify({ name }) }));
  }

  document.addEventListener("dswm-page-hello", announce);
  announce();

  document.addEventListener("dswm-join", async (e) => {
    let req;
    try {
      req = JSON.parse(e.detail);
    } catch {
      return;
    }
    let res;
    try {
      res = await chrome.runtime.sendMessage({
        type: "invite-join",
        room: String(req.room || ""),
        name: String(req.name || "").trim(),
        serverUrl: location.origin,
      });
    } catch {
      res = { ok: false, error: "The extension didn't answer. Reload the page and try again." };
    }
    document.dispatchEvent(new CustomEvent("dswm-joined", { detail: JSON.stringify(res || { ok: false }) }));
  });
})();
