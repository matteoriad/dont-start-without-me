// End-to-end test: two real Chrome profiles with the extension, a fake "YouTube"
// page served over HTTPS (www.youtube.com mapped to localhost), the real relay.
const path = require("path");
const fs = require("fs");
const https = require("https");
const { execSync } = require("child_process");
const { chromium } = require("playwright");
const { createRelay } = require("../lib/relay.js");

// Usage: CHROME=/path/to/chrome node e2e/run.js   (needs ffmpeg + openssl for fixtures)
const EXT = path.resolve(__dirname, "../extension");
const FIX = path.join(__dirname, ".fixtures");
const CHROME = process.env.CHROME || "/usr/bin/google-chrome";
// HTTP_ONLY=1 simulates a host that blocks WebSockets (e.g. Hostinger managed Node.js).
const HTTP_ONLY = process.env.HTTP_ONLY === "1";
// A non-localhost name, so we also prove plain-http servers work from the extension.
const SERVER_URL = "http://relay.test:8787";

function fixtures() {
  fs.mkdirSync(FIX, { recursive: true });
  if (!fs.existsSync(path.join(FIX, "video.mp4"))) {
    execSync(`ffmpeg -loglevel error -y -f lavfi -i testsrc=duration=300:size=320x180:rate=25 -c:v libx264 -pix_fmt yuv420p -movflags +faststart "${FIX}/video.mp4"`);
  }
  if (!fs.existsSync(path.join(FIX, "cert.pem"))) {
    execSync(`openssl req -x509 -newkey rsa:2048 -nodes -keyout "${FIX}/key.pem" -out "${FIX}/cert.pem" -days 30 -subj "/CN=www.youtube.com"`, { stdio: "ignore" });
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PAGE = `<!doctype html><html><body>
<div id="movie_player" class="html5-video-player"><video class="html5-main-video" src="/video.mp4" muted playsinline width="320"></video></div>
</body></html>`;

async function main() {
  fixtures();
  const relay = createRelay({ port: 8787, log: () => {}, disableWebSocket: HTTP_ONLY });
  await relay.listen();
  const web = https
    .createServer({ key: fs.readFileSync(path.join(FIX, "key.pem")), cert: fs.readFileSync(path.join(FIX, "cert.pem")) }, (req, res) => {
      if (req.url.startsWith("/video.mp4")) {
        const data = fs.readFileSync(path.join(FIX, "video.mp4"));
        const range = req.headers.range;
        if (range) {
          const [s, e] = range.replace("bytes=", "").split("-");
          const start = Number(s);
          const end = e ? Number(e) : data.length - 1;
          res.writeHead(206, {
            "content-type": "video/mp4",
            "content-range": `bytes ${start}-${end}/${data.length}`,
            "accept-ranges": "bytes",
            "content-length": end - start + 1,
          });
          return res.end(data.subarray(start, end + 1));
        }
        res.writeHead(200, { "content-type": "video/mp4", "accept-ranges": "bytes", "content-length": data.length });
        return res.end(data);
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(PAGE);
    })
    .listen(8443);

  async function launch(name) {
    const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(require("os").tmpdir(), `dswm-${name}-`)), {
      executablePath: CHROME,
      headless: false,
      args: [
        "--headless=new",
        `--disable-extensions-except=${EXT}`,
        `--load-extension=${EXT}`,
        "--host-resolver-rules=MAP www.youtube.com 127.0.0.1:8443, MAP relay.test 127.0.0.1",
        "--ignore-certificate-errors",
        "--autoplay-policy=no-user-gesture-required",
        "--no-proxy-server",
      ],
    });
    const page = await ctx.newPage();
    page.on("console", (m) => m.type() === "error" && console.log(`[${name} console]`, m.text()));
    // Keep every toast the extension shows, since they fade after a few seconds.
    await page.addInitScript(() => {
      window.__toasts = [];
      new MutationObserver((muts) => {
        for (const m of muts)
          for (const n of m.addedNodes)
            if (n.parentElement && n.parentElement.id === "dswm-root") window.__toasts.push(n.textContent);
      }).observe(document, { childList: true, subtree: true });
    });
    await page.goto("https://www.youtube.com/watch?v=abc123");
    let sw = ctx.serviceWorkers()[0];
    if (!sw) sw = await ctx.waitForEvent("serviceworker");
    return { ctx, page, sw, name };
  }

  const A = await launch("A"); // Matteo, the host
  const B = await launch("B"); // Yasso, joins later
  await sleep(1000);

  const join = (p, name) =>
    p.sw.evaluate(
      async ([name, serverUrl]) => {
        const [t] = await chrome.tabs.query({ url: "https://www.youtube.com/*" });
        return join({ room: "e2e-room", name, serverUrl, tabId: t.id });
      },
      [name, SERVER_URL],
    );
  const leave = (p) => p.sw.evaluate(() => leave());
  const transport = (p) => p.sw.evaluate(() => (conn ? conn.kind : null));

  const v = (p) =>
    p.page.evaluate(() => {
      const el = document.querySelector("video");
      return { t: +el.currentTime.toFixed(2), paused: el.paused, rate: el.playbackRate };
    });
  const toasts = (p) =>
    p.page.evaluate(() => [document.querySelector("#dswm-root")?.innerText || "", ...(window.__toasts || [])].join("\n"));
  // Something the person really did: a trusted click on the player, then the action.
  const user = async (p, fn) => {
    await p.page.click("video");
    await p.page.evaluate(fn);
  };
  // Something the player did by itself (autoplay, ad ending, …): no click.
  const auto = (p, fn) => p.page.evaluate(fn);
  const setAd = (p, on) => auto(p, (on) => document.querySelector("#movie_player").classList.toggle("ad-showing", on), on);
  const report = async (label) => {
    const [a, b] = await Promise.all([v(A), v(B)]);
    const diff = Math.abs(a.t - b.t);
    console.log(`  ${label}: A=${JSON.stringify(a)} B=${JSON.stringify(b)} diff=${diff.toFixed(2)}`);
    return { a, b, diff };
  };
  const results = [];
  const check = (name, ok) => {
    results.push([name, ok]);
    console.log(ok ? "PASS" : "FAIL", name);
  };
  const joinWait = HTTP_ONLY ? 6500 : 2000; // HTTP mode first tries the WebSocket

  // 1. Matteo starts a party alone and watches to 40 s.
  await join(A, "Matteo");
  await sleep(joinWait);
  await user(A, () => {
    const el = document.querySelector("video");
    el.currentTime = 40;
    return el.play();
  });
  // Yasso's player autoplays from the start before she joins.
  await auto(B, () => document.querySelector("video").play());
  await sleep(2000);

  // 2. Yasso joins mid-video.
  await join(B, "Yasso");
  await sleep(joinWait + 1000);
  check(`transport is ${HTTP_ONLY ? "http" : "ws"}`, (await Promise.all([transport(A), transport(B)])).every((k) => k === (HTTP_ONLY ? "http" : "ws")));
  let r = await report("after Yasso joined");
  check("host was NOT restarted by the joiner", r.a.t > 42 && !r.a.paused);
  check("joiner jumped to the host", r.diff < 0.5 && !r.b.paused);
  check("joiner saw 'Synced with Matteo'", (await toasts(B)).includes("Synced with Matteo"));
  check("host pill says host", (await toasts(A)).includes("you're the host"));

  // 3. Yasso's player jumps on its own (no click) — must not affect Matteo; heartbeat pulls her back.
  await auto(B, () => (document.querySelector("video").currentTime = 3));
  await sleep(500);
  r = await report("after B's player jumped by itself");
  check("automatic jump not shared", r.a.t > 45);
  await sleep(4500);
  r = await report("after heartbeat");
  check("joiner pulled back to host", r.diff < 0.5);

  // 4. Yasso really pauses and plays → Matteo follows.
  await user(B, () => document.querySelector("video").pause());
  await sleep(1500);
  r = await report("after Yasso paused");
  check("host paused by joiner's click", r.a.paused && r.diff < 0.3);
  check("pause toast", (await toasts(A)).includes("Yasso paused"));
  await user(B, () => document.querySelector("video").play());
  await sleep(1500);
  r = await report("after Yasso played");
  check("host resumed by joiner's click", !r.a.paused && r.diff < 0.5);

  // 5. Mid-video ad for Yasso → Matteo waits, then both continue.
  await sleep(1000);
  await setAd(B, true);
  await sleep(1200);
  r = await report("during Yasso's ad");
  check("host paused for the joiner's ad", r.a.paused);
  check("host told about the ad", (await toasts(A)).includes("Yasso got an ad"));
  await sleep(2500);
  check("host still waiting during the ad", (await v(A)).paused);
  await setAd(B, false);
  await sleep(1500);
  r = await report("after Yasso's ad");
  check("host resumed after the ad", !r.a.paused);
  check("host told the ad is over", (await toasts(A)).includes("ad is over"));
  await sleep(3000);
  r = await report("settled after ad");
  check("in sync after the ad", r.diff < 0.5);

  // 6. Yasso leaves and rejoins while an ad is showing → nobody pauses.
  await leave(B);
  await sleep(1000);
  await setAd(B, true);
  await join(B, "Yasso");
  await sleep(joinWait + 1500);
  r = await report("Yasso rejoined during an ad");
  check("host NOT paused by a join-time ad", !r.a.paused);
  await setAd(B, false);
  await sleep(3000);
  r = await report("after join-time ad ended");
  check("joiner caught up after the join-time ad", r.diff < 0.5 && !r.b.paused);

  // 7. Drift: Yasso's player runs fast for a bit; heartbeat nudges her back.
  await auto(B, () => (document.querySelector("video").playbackRate = 1.4));
  await sleep(2000);
  let last;
  for (let i = 0; i < 13; i++) {
    await sleep(1000);
    last = await report(`correcting ${i}`);
  }
  check("drift corrected", last.diff < 0.3 && Math.abs(last.b.rate - 1) <= 0.03);

  // 8. Different video → "Join them".
  await B.page.goto("https://www.youtube.com/watch?v=other999");
  await sleep(2500);
  await user(A, () => document.querySelector("video").pause());
  await sleep(1500);
  check("joiner offered to join the other video", (await toasts(B)).includes("watching something else"));

  await A.ctx.close();
  await B.ctx.close();
  web.close();
  await relay.close();
  const failed = results.filter(([, ok]) => !ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
