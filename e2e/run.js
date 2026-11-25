// End-to-end test: two real Chrome profiles with the extension, a fake "YouTube"
// page served over HTTPS (www.youtube.com mapped to localhost), the real relay.
const path = require("path");
const fs = require("fs");
const https = require("https");
const { execSync } = require("child_process");
const { chromium } = require("playwright");
const { createRelay } = require("../server.js");

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
    execSync(`ffmpeg -loglevel error -y -f lavfi -i testsrc=duration=120:size=320x180:rate=25 -c:v libx264 -pix_fmt yuv420p -movflags +faststart "${FIX}/video.mp4"`);
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
    await page.goto("https://www.youtube.com/watch?v=abc123");
    let sw = ctx.serviceWorkers()[0];
    if (!sw) sw = await ctx.waitForEvent("serviceworker");
    return { ctx, page, sw, name };
  }

  const A = await launch("A");
  const B = await launch("B");
  await sleep(1500);

  for (const p of [A, B]) {
    const res = await p.sw.evaluate(async ([name, serverUrl]) => {
      const [t] = await chrome.tabs.query({ url: "https://www.youtube.com/*" });
      return join({ room: "e2e-room", name, serverUrl, tabId: t.id });
    }, [p.name === "A" ? "Matteo" : "Yasso", SERVER_URL]);
    console.log(p.name, "join ->", JSON.stringify(res));
  }
  await sleep(HTTP_ONLY ? 7000 : 2000); // HTTP mode first tries the WebSocket for up to 4 s

  const kinds = await Promise.all([A, B].map((p) => p.sw.evaluate(() => (conn ? conn.kind : null))));
  console.log("transports:", kinds.join(", "));

  const v = (p) =>
    p.page.evaluate(() => {
      const el = document.querySelector("video");
      return { t: +el.currentTime.toFixed(2), paused: el.paused, rate: el.playbackRate };
    });
  const toasts = (p) => p.page.evaluate(() => document.querySelector("#dswm-root")?.innerText || "");
  const report = async (label) => {
    const [a, b] = await Promise.all([v(A), v(B)]);
    console.log(`${label}: A=${JSON.stringify(a)} B=${JSON.stringify(b)} diff=${Math.abs(a.t - b.t).toFixed(2)}`);
    return { a, b, diff: Math.abs(a.t - b.t) };
  };
  const results = [];
  const check = (name, ok) => {
    results.push([name, ok]);
    console.log(ok ? "PASS" : "FAIL", name);
  };

  check(`using ${HTTP_ONLY ? "http" : "ws"} transport`, kinds.every((k) => k === (HTTP_ONLY ? "http" : "ws")));
  console.log("pill B:", JSON.stringify(await toasts(B)));
  check("pill shows partner", (await toasts(B)).includes("Watching with Matteo"));

  // 1. A presses play
  await A.page.evaluate(() => document.querySelector("video").play());
  await sleep(3000);
  let r = await report("after A play");
  check("B started playing", !r.b.paused);
  check("in sync after play (<0.5s)", r.diff < 0.5);

  // 2. A seeks
  await A.page.evaluate(() => (document.querySelector("video").currentTime = 60));
  await sleep(2500);
  r = await report("after A seek to 60");
  check("B followed seek", r.b.t > 58 && r.diff < 0.6);

  // 3. B pauses
  await B.page.evaluate(() => document.querySelector("video").pause());
  await sleep(2000);
  r = await report("after B pause");
  check("A paused", r.a.paused);
  check("paused at same position (<0.3s)", r.diff < 0.3);
  const ta = await toasts(A);
  console.log("A toasts:", JSON.stringify(ta));
  check("A got a pause toast from Yasso", ta.includes("Yasso paused"));

  // 4. B plays, then we artificially make A drift ahead by 0.8s; heartbeat should nudge it back
  await B.page.evaluate(() => document.querySelector("video").play());
  await sleep(2500);
  // Drift without firing a user seek: speed A up for a bit (ratechange isn't synced)
  await A.page.evaluate(() => (document.querySelector("video").playbackRate = 1.4));
  await sleep(2000);
  r = await report("after making A drift");
  let maxDiff = 0;
  for (let i = 0; i < 12; i++) {
    await sleep(1000);
    r = await report(`  correcting ${i}`);
    maxDiff = r.diff;
  }
  check("drift corrected (<0.3s)", maxDiff < 0.3);
  check("rates back to ~1", Math.abs(r.a.rate - 1) < 0.001);

  // 5. B goes to a different video; A's next action should show a mismatch toast on B
  await B.page.goto("https://www.youtube.com/watch?v=other999");
  await sleep(2500);
  await A.page.evaluate(() => document.querySelector("video").pause());
  await sleep(1500);
  const tb = await toasts(B);
  console.log("B toasts:", JSON.stringify(tb));
  check("B told partner is watching something else", tb.includes("watching something else"));

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
