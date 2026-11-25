// Connection to the relay. Tries a WebSocket first (fast); if the host doesn't
// allow WebSockets, falls back to HTTP long-polling. Same messages either way.
//
//   const t = await DSWM.connectRelay(baseUrl, { onMessage, onClose });
//   t.kind      // "ws" | "http"
//   t.send(msg) // first message must be {type: "join", ...}
//   t.close()
(function (root) {
  const WS_OPEN_TIMEOUT_MS = 4000;

  function wsUrlFor(base) {
    const u = new URL(base);
    u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
    return u.toString();
  }

  function tryWebSocket(base, { onMessage, onClose }) {
    return new Promise((resolve, reject) => {
      let ws;
      try {
        ws = new WebSocket(wsUrlFor(base));
      } catch (e) {
        return reject(e);
      }
      let opened = false;
      const timer = setTimeout(() => {
        if (!opened) {
          ws.onclose = ws.onerror = null;
          ws.close();
          reject(new Error("ws_timeout"));
        }
      }, WS_OPEN_TIMEOUT_MS);
      ws.onopen = () => {
        opened = true;
        clearTimeout(timer);
        resolve({
          kind: "ws",
          send: (msg) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(msg)),
          close: () => {
            ws.onclose = null;
            ws.close();
          },
        });
      };
      ws.onmessage = (ev) => {
        try {
          onMessage(JSON.parse(ev.data));
        } catch {}
      };
      ws.onerror = () => {
        if (!opened) {
          clearTimeout(timer);
          reject(new Error("ws_failed"));
        }
      };
      ws.onclose = () => {
        if (opened) onClose();
      };
    });
  }

  function httpTransport(base, { onMessage, onClose }) {
    const api = (path) => new URL(path, base).toString();
    let clientId = null;
    let closed = false;
    let polling = false;
    let outbox = Promise.resolve(); // keep message order

    function die() {
      if (closed) return;
      closed = true;
      onClose();
    }

    async function post(msg) {
      const r = await fetch(api("/api/message"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientId, msg }),
      });
      if (r.status === 404) return die(); // server restarted and forgot us
      if (!r.ok) throw new Error(`http_${r.status}`);
      const body = await r.json();
      clientId = body.clientId;
      for (const m of body.replies || []) onMessage(m);
      if (!polling) poll();
    }

    async function poll() {
      polling = true;
      let failures = 0;
      while (!closed) {
        try {
          const r = await fetch(api(`/api/poll?clientId=${encodeURIComponent(clientId)}`), { cache: "no-store" });
          if (r.status === 404) return die();
          if (!r.ok) throw new Error(`http_${r.status}`);
          const body = await r.json();
          failures = 0;
          for (const m of body.messages || []) if (!closed) onMessage(m);
        } catch {
          if (++failures >= 3) return die();
          await new Promise((res) => setTimeout(res, 1000 * failures));
        }
      }
    }

    return {
      kind: "http",
      send(msg) {
        if (closed) return;
        outbox = outbox.then(() => post(msg)).catch(() => die());
      },
      close() {
        closed = true;
      },
    };
  }

  async function connectRelay(base, handlers) {
    try {
      return await tryWebSocket(base, handlers);
    } catch {
      // Check the server is actually there before settling for HTTP.
      const r = await fetch(new URL("/health", base).toString(), { cache: "no-store" });
      if (!r.ok) throw new Error("server_unreachable");
      return httpTransport(base, handlers);
    }
  }

  (root.DSWM = root.DSWM || {}).connectRelay = connectRelay;
})(self);
