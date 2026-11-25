// End-to-end test for the awkward real-world cases:
//   a) host starts the party before opening a video (e.g. YouTube home page)
//   b) the extension is updated/reloaded while video tabs are already open
// Relay on http://localhost:8787 (serves the invite page), fake YouTube over HTTPS.
//
// Usage: CHROME=/path/to/chrome node e2e/robust.js   (SHOTS=dir to save screenshots)
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
const SHOTS = process.env.SHOTS || null;
const SERVER = "http://localhost:8787";
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

const YT_PAGE = `<!doctype html><html><head><title>Big Buck Bunny - YouTube</title></head><body>
<div id="movie_player" class="html5-video-player"><video class="html5-main-video" src="/video.mp4" muted playsinline width="320"></video></div>
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
      // The home page has a player element but no video id, like the real one.
      res.end(req.url.startsWith("/watch") ? YT_PAGE : "<!doctype html><title>YouTube</title><div id=movie_player></div><p>home</p>");
    })
    .listen(8443);

  const results = [];
  const check = (name, ok) => {
    results.push([name, ok]);
    console.log(ok ? "PASS" : "FAIL", name);
  };

  async function launch(name, { extension = true } = {}) {
    const args = [
      "--headless=new",
      "--host-resolver-rules=MAP www.youtube.com 127.0.0.1:8443",
      "--ignore-certificate-errors",
      "--autoplay-policy=no-user-gesture-required",
      "--no-proxy-server",
    ];
    if (extension) args.push(`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`);
    const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), `dswm-${name}-`)), {
      executablePath: CHROME,
      headless: false,
      viewport: { width: 1100, height: 820 },
      args,
    });
    await ctx.addInitScript(() => {
      window.__toasts = [];
      new MutationObserver((muts) => {
        for (const m of muts)
          for (const n of m.addedNodes)
            if (n.parentElement && n.parentElement.id === "dswm-root") window.__toasts.push(n.textContent);
      }).observe(document, { childList: true, subtree: true });
    });
    let sw = null;
    if (extension) sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker"));
    return { ctx, sw, name };
  }
  const shot = async (page, file) => {
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, file), fullPage: true });
  };
  const vid = (page) =>
    page.evaluate(() => {
      const el = document.querySelector("video");
      return el ? { t: +el.currentTime.toFixed(2), paused: el.paused } : null;
    });

  const joinViaInvite = async (ctx, room, name) => {
    const page = await ctx.newPage();
    await page.goto(`${SERVER}/join/${room}`);
    await page.waitForSelector("#v-join:not([hidden])", { timeout: 5000 });
    if (await page.isVisible("#name")) await page.fill("#name", name);
    await page.click("#join");
    return page;
  };

  // ===== a) Host starts on the YouTube home page, picks a video later =====
  console.log("\n--- host starts before picking a video ---");
  const A = await launch("host");
  const aPage = await A.ctx.newPage();
  await aPage.goto("https://www.youtube.com/");
  await A.sw.evaluate(() => setName("Meeto"));
  const room1 = "blanket-party-31";
  const tabA = await A.sw.evaluate(async () => (await chrome.tabs.query({ url: "https://www.youtube.com/*" }))[0].id);
  await A.sw.evaluate(([room, server, tabId]) => join({ room, serverUrl: server, tabId }), [room1, SERVER, tabA]);
  await sleep(1500);

  const B = await launch("joiner");
  await B.sw.evaluate(() => setName("Yasso"));
  const bPage = await joinViaInvite(B.ctx, room1, "Yasso");
  await bPage.waitForSelector("#v-joined:not([hidden])", { timeout: 5000 }).catch(() => {});
  await sleep(1500);
  const waitingMsg = await bPage.textContent("#joined-msg");
  console.log("  joiner sees:", JSON.stringify(waitingMsg));
  check("joiner told the host hasn't picked yet", /Waiting for Meeto to pick something/.test(waitingMsg));
  await shot(bPage, "robust-waiting.png");

  // Host now opens a video and presses play.
  await aPage.goto("https://www.youtube.com/watch?v=abc123");
  await sleep(1500);
  await aPage.click("video");
  await aPage.evaluate(() => {
    const v = document.querySelector("video");
    v.currentTime = 30;
    return v.play();
  });
  await bPage.waitForURL("https://www.youtube.com/watch?v=abc123", { timeout: 10000 }).catch(() => {});
  check("joiner's tab followed once the host picked a video", bPage.url() === "https://www.youtube.com/watch?v=abc123");
  await sleep(4000);
  let a = await vid(aPage);
  let b = await vid(bPage);
  console.log(`  A=${JSON.stringify(a)} B=${JSON.stringify(b)}`);
  check("then in sync", a && b && !b.paused && Math.abs(a.t - b.t) < 0.5);

  // Host switches video → joiner gets a "Join them" offer.
  await aPage.goto("https://www.youtube.com/watch?v=second456");
  await sleep(3000);
  const toastsB = await bPage.evaluate(() => (window.__toasts || []).join("\n"));
  check("joiner offered to follow when host switches video", toastsB.includes("switched to something else"));

  // ===== b) Re-injection (what the extension does after an update) =====
  // A real extension reload can't be simulated in this test browser (Chrome
  // disables command-line extensions on reload), so we exercise the part we
  // can: injecting fresh copies into tabs must not double up or break sync.
  console.log("\n--- fresh copies injected into an open tab ---");
  await A.sw.evaluate(() => leave());
  await aPage.goto("https://www.youtube.com/watch?v=abc123");
  await sleep(1000);
  await A.sw.evaluate(async () => {
    const [t] = await chrome.tabs.query({ url: "https://www.youtube.com/*" });
    await injectContent(t.id, t.url);
    await injectContent(t.id, t.url);
  });
  await sleep(800);
  // The page was NOT reloaded. Start a new party on it straight away.
  const room2 = "after-update-77";
  const tabA2 = await A.sw.evaluate(async () => (await chrome.tabs.query({ url: "https://www.youtube.com/*" }))[0].id);
  const r2 = await A.sw.evaluate(([room, server, tabId]) => join({ room, serverUrl: server, tabId }), [room2, SERVER, tabA2]);
  console.log("  host join:", JSON.stringify(r2));
  check("host's tab answers after re-injection", r2.ok && r2.tabReady);
  await sleep(1000);
  await aPage.click("video");
  await aPage.evaluate(() => {
    const v = document.querySelector("video");
    v.currentTime = 60;
    return v.play();
  });
  await sleep(1000);
  const info = await (await fetch(`${SERVER}/api/room/${room2}`)).json();
  check("room knows what the host is watching", info.service === "YouTube" && info.mediaUrl && info.mediaUrl.includes("abc123"));
  const pills = await aPage.evaluate(() => document.querySelectorAll("#dswm-root").length);
  check("no duplicate overlay after re-injection", pills === 1);

  await B.sw.evaluate(() => leave());
  const bPage2 = await joinViaInvite(B.ctx, room2, "Yasso");
  await bPage2.waitForURL("https://www.youtube.com/watch?v=abc123", { timeout: 10000 }).catch(() => {});
  await sleep(4000);
  a = await vid(aPage);
  b = await vid(bPage2);
  console.log(`  A=${JSON.stringify(a)} B=${JSON.stringify(b)}`);
  check("joiner synced to host (no double reactions)", a && b && a.t > 60 && Math.abs(a.t - b.t) < 0.5);

  await Promise.all([A.ctx.close(), B.ctx.close()]);
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
