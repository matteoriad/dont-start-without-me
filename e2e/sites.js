// End-to-end test for the Netflix and Apple TV adapters, against mock pages
// that copy the parts that matter:
//   - Netflix: seeking must go through window.netflix's player API; setting
//     <video>.currentTime directly is counted as a failure (real Netflix errors).
//   - Apple TV: the <video> lives inside a web component's shadow root, and
//     the two people are on different country URLs (/de/ vs /eg/) of the same title.
//
// Usage: CHROME=/path/to/chrome node e2e/sites.js
const path = require("path");
const fs = require("fs");
const os = require("os");
const https = require("https");
const { execSync } = require("child_process");
const { chromium } = require("playwright");
const { createRelay } = require("../lib/relay.js");

const EXT = path.resolve(__dirname, "../extension");
const FIX = path.join(__dirname, ".fixtures");
const CHROME = process.env.CHROME || "/usr/bin/google-chrome";
const SERVER_URL = "http://relay.test:8787";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fixtures() {
  fs.mkdirSync(FIX, { recursive: true });
  if (!fs.existsSync(path.join(FIX, "video.mp4"))) {
    execSync(`ffmpeg -loglevel error -y -f lavfi -i testsrc=duration=300:size=320x180:rate=25 -c:v libx264 -pix_fmt yuv420p -movflags +faststart "${FIX}/video.mp4"`);
  }
  if (!fs.existsSync(path.join(FIX, "cert.pem"))) {
    execSync(`openssl req -x509 -newkey rsa:2048 -nodes -keyout "${FIX}/key.pem" -out "${FIX}/cert.pem" -days 30 -subj "/CN=localhost"`, { stdio: "ignore" });
  }
}

const NETFLIX_PAGE = `<!doctype html><html><body>
<div class="watch-video"><video src="/video.mp4" muted playsinline width="320"></video></div>
<script>
  // Count direct currentTime writes from anyone except Netflix's own player.
  window.__directSets = 0;
  window.__apiSeeks = 0;
  const desc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "currentTime");
  let internal = false;
  Object.defineProperty(HTMLMediaElement.prototype, "currentTime", {
    get() { return desc.get.call(this); },
    set(v) { if (!internal) window.__directSets++; desc.set.call(this, v); },
    configurable: true,
  });
  const video = () => document.querySelector("video");
  const player = {
    seek(ms) { window.__apiSeeks++; internal = true; video().currentTime = ms / 1000; internal = false; },
    play() { return video().play(); },
    pause() { video().pause(); },
  };
  window.netflix = { appContext: { state: { playerApp: { getAPI: () => ({ videoPlayer: {
    getAllPlayerSessionIds: () => ["watch-123"],
    getVideoPlayerBySessionId: () => player,
  } }) } } } };
</script>
</body></html>`;

const APPLE_PAGE = `<!doctype html><html><body>
<apple-tv-plus-player></apple-tv-plus-player>
<script>
  customElements.define("apple-tv-plus-player", class extends HTMLElement {
    connectedCallback() {
      // Closed, so ordinary page code (and the test) can't look inside; only
      // extensions can, via chrome.dom.openOrClosedShadowRoot.
      const root = this.attachShadow({ mode: "closed" });
      root.innerHTML = '<div class="wrapper"><video src="/video.mp4" muted playsinline width="320"></video></div>';
      window.__appleVideo = root.querySelector("video"); // test-only handle
    }
  });
</script>
</body></html>`;

async function main() {
  fixtures();
  const relay = createRelay({ port: 8787, log: () => {} });
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
      res.end(req.headers.host.includes("netflix") ? NETFLIX_PAGE : APPLE_PAGE);
    })
    .listen(8443);

  const results = [];
  const check = (name, ok) => {
    results.push([name, ok]);
    console.log(ok ? "PASS" : "FAIL", name);
  };

  async function launch(name, url) {
    const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), `dswm-${name}-`)), {
      executablePath: CHROME,
      headless: false,
      args: [
        "--headless=new",
        `--disable-extensions-except=${EXT}`,
        `--load-extension=${EXT}`,
        "--host-resolver-rules=MAP www.netflix.com 127.0.0.1:8443, MAP tv.apple.com 127.0.0.1:8443, MAP relay.test 127.0.0.1",
        "--ignore-certificate-errors",
        "--autoplay-policy=no-user-gesture-required",
        "--no-proxy-server",
      ],
    });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => console.log(`[${name} pageerror]`, e.message));
    await page.addInitScript(() => {
      window.__toasts = [];
      new MutationObserver((muts) => {
        for (const m of muts)
          for (const n of m.addedNodes)
            if (n.parentElement && n.parentElement.id === "dswm-root") window.__toasts.push(n.textContent);
      }).observe(document, { childList: true, subtree: true });
    });
    await page.goto(url);
    let sw = ctx.serviceWorkers()[0];
    if (!sw) sw = await ctx.waitForEvent("serviceworker");
    return { ctx, page, sw, name };
  }

  async function runSite({ label, urlA, urlB, room, getVideo, userSeek, beforeClose }) {
    console.log(`\n=== ${label} ===`);
    const A = await launch(`${label}-A`, urlA);
    const B = await launch(`${label}-B`, urlB);
    await sleep(1000);
    const join = (p, name) =>
      p.sw.evaluate(
        async ([name, serverUrl, room]) => {
          const [t] = await chrome.tabs.query({ active: true });
          return join({ room, name, serverUrl, tabId: t.id });
        },
        [name, SERVER_URL, room],
      );
    const v = (p) =>
      p.page.evaluate((getVideo) => {
        const el = eval(getVideo)();
        return { t: +el.currentTime.toFixed(2), paused: el.paused, rate: el.playbackRate };
      }, getVideo);
    const toasts = (p) => p.page.evaluate(() => (window.__toasts || []).join("\n"));
    const user = async (p, fn, arg) => {
      await p.page.mouse.click(5, 5);
      await p.page.evaluate(fn, arg);
    };
    const auto = (p, fn, arg) => p.page.evaluate(fn, arg);
    const report = async (l) => {
      const [a, b] = await Promise.all([v(A), v(B)]);
      const diff = Math.abs(a.t - b.t);
      console.log(`  ${l}: A=${JSON.stringify(a)} B=${JSON.stringify(b)} diff=${diff.toFixed(2)}`);
      return { a, b, diff };
    };
    const play = (getVideo) => eval(getVideo)().play();
    const pause = (getVideo) => eval(getVideo)().pause();

    await join(A, "Matteo");
    await sleep(2000);
    await user(A, play, getVideo);
    await user(A, userSeek, 40);
    await auto(B, play, getVideo); // joiner's player autoplays from 0
    await sleep(2000);
    await join(B, "Yasso");
    await sleep(3000);
    let r = await report("after join");
    check(`${label}: host not moved by joiner`, r.a.t > 42 && !r.a.paused);
    check(`${label}: joiner jumped to host`, r.diff < 0.5 && !r.b.paused);

    await user(B, userSeek, 100);
    await sleep(2000);
    r = await report("after joiner seek to 100");
    check(`${label}: host followed joiner's seek`, r.a.t > 100 && r.diff < 0.5);

    await user(B, pause, getVideo);
    await sleep(1500);
    r = await report("after joiner pause");
    check(`${label}: host followed joiner's pause`, r.a.paused && r.diff < 0.3);
    check(`${label}: pause toast`, (await toasts(A)).includes("Yasso paused"));

    await user(A, play, getVideo);
    await sleep(1500);
    await auto(B, (g) => (eval(g)().playbackRate = 1.4), getVideo);
    await sleep(2500);
    let last;
    for (let i = 0; i < 12; i++) {
      await sleep(1000);
      last = await report(`correcting ${i}`);
    }
    check(`${label}: drift corrected`, last.diff < 0.3 && !last.a.paused && !last.b.paused);

    const extra = beforeClose ? await beforeClose(A, B) : null;
    await A.ctx.close();
    await B.ctx.close();
    return extra;
  }

  // Netflix: seeks must go through Netflix's player API, never <video>.currentTime.
  const nf = await runSite({
    label: "Netflix",
    urlA: "https://www.netflix.com/watch/81234567?trackId=1",
    urlB: "https://www.netflix.com/watch/81234567",
    room: "nf-room",
    getVideo: '() => document.querySelector("video")',
    // A person seeking on Netflix = Netflix's own UI calling its player.
    userSeek: (t) =>
      window.netflix.appContext.state.playerApp.getAPI().videoPlayer.getVideoPlayerBySessionId("x").seek(t * 1000),
    beforeClose: async (A, B) => {
      const counts = await Promise.all(
        [A, B].map((p) => p.page.evaluate(() => ({ direct: window.__directSets, api: window.__apiSeeks, bridge: window.__dswmNetflixBridge === true }))),
      );
      return counts;
    },
  });
  console.log("  Netflix counters:", JSON.stringify(nf));
  check("Netflix: page-context bridge loaded", nf.every((c) => c.bridge));
  check("Netflix: extension never set currentTime directly", nf.every((c) => c.direct === 0));
  // A followed 1 seek (B's), B made its own 1 + the join jump (and maybe drift seeks): extension-driven
  // seeks are any beyond the 2 the test itself made (A's seek to 40, B's seek to 100).
  check("Netflix: extension seeked through Netflix's player", nf[0].api + nf[1].api >= 4);

  // Apple TV: video in shadow DOM, different country URLs.
  const atGetVideo = "() => window.__appleVideo";
  await runSite({
    label: "Apple TV",
    urlA: "https://tv.apple.com/de/movie/some-film/umc.cmc.5abc123def",
    urlB: "https://tv.apple.com/eg/movie/some-film/umc.cmc.5abc123def",
    room: "at-room",
    getVideo: atGetVideo,
    userSeek: (t) => (window.__appleVideo.currentTime = t),
  });

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
