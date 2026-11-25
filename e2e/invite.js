// End-to-end test for names, invite links and joining from any tab.
// Relay on http://localhost:8787 (serves the invite page), fake YouTube over HTTPS.
//
// Usage: CHROME=/path/to/chrome node e2e/invite.js   (SHOTS=dir to save screenshots)
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
      res.end(YT_PAGE);
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

  // ---- Host: Matteo starts a party on YouTube ----
  const A = await launch("host");
  const aPage = await A.ctx.newPage();
  await aPage.goto("https://www.youtube.com/watch?v=abc123");
  await A.sw.evaluate(() => setName("Matteo"));
  const room = "popcorn-night-42";
  const aj = await A.sw.evaluate(
    async ([room, server]) => {
      const [t] = await chrome.tabs.query({ url: "https://www.youtube.com/*" });
      return join({ room, serverUrl: server, tabId: t.id });
    },
    [room, SERVER],
  );
  check("host joined", aj.ok);
  await sleep(1500);
  await aPage.click("video");
  await aPage.evaluate(() => {
    const v = document.querySelector("video");
    v.currentTime = 40;
    return v.play();
  });
  await sleep(1500);

  // ---- Room info API ----
  const info = await (await fetch(`${SERVER}/api/room/${room}`)).json();
  console.log("  room info:", JSON.stringify(info));
  check("room info: host name", info.hostName === "Matteo");
  check("room info: title + service", info.title === "Big Buck Bunny" && info.service === "YouTube");
  check("room info: playing near 40s", info.playing === true && info.position > 40);

  // ---- Joiner without a name opens the invite link ----
  const B = await launch("joiner");
  const bPage = await B.ctx.newPage();
  await bPage.goto(`${SERVER}/join/${room}`);
  await bPage.waitForSelector("#v-join:not([hidden])", { timeout: 5000 }).catch(() => {});
  check("invite page detected the extension", await bPage.isVisible("#v-join"));
  check("invite page asks for a name (none saved)", await bPage.isVisible("#name"));
  await bPage.waitForFunction(() => document.querySelector("#headline").textContent.includes("Matteo"), null, { timeout: 5000 }).catch(() => {});
  check("invite page shows host name", (await bPage.textContent("#headline")).includes("Matteo"));
  check("invite page shows what's playing", (await bPage.textContent("#title")).includes("Big Buck Bunny"));
  await shot(bPage, "invite-join.png");

  // Try without a name first
  await bPage.click("#join");
  check("name is required on invite page", (await bPage.textContent("#error")).length > 0);
  await bPage.fill("#name", "Yasso");
  await bPage.click("#join");
  await bPage.waitForURL("https://www.youtube.com/watch?v=abc123", { timeout: 10000 }).catch(() => {});
  check("joiner's tab opened the host's video", bPage.url() === "https://www.youtube.com/watch?v=abc123");
  await sleep(3500);
  let a = await vid(aPage);
  let b = await vid(bPage);
  console.log(`  after invite join: A=${JSON.stringify(a)} B=${JSON.stringify(b)}`);
  check("joiner synced to host", b && !b.paused && Math.abs(a.t - b.t) < 0.5);
  check("host not moved", a.t > 44 && !a.paused);
  const bName = await B.sw.evaluate(async () => (await chrome.storage.local.get("name")).name);
  check("joiner's name saved for next time", bName === "Yasso");

  // ---- Rename mid-party ----
  await B.sw.evaluate(() => setName("Yasso the Late"));
  await sleep(1000);
  const aPeers = await A.sw.evaluate(() => peers.map((p) => p.name));
  console.log("  host sees:", aPeers);
  check("rename reaches the host", aPeers.includes("Yasso the Late"));

  // ---- Join by code from a non-video tab ----
  await B.sw.evaluate(() => leave());
  await sleep(500);
  const bTabId = await B.sw.evaluate(async () => (await chrome.tabs.query({ url: "https://www.youtube.com/*" }))[0].id);
  await bPage.goto(`${SERVER}/`); // some random page, not a video site
  const bj = await B.sw.evaluate(
    async ([room, server, tabId]) => join({ room, serverUrl: server, tabId, follow: true }),
    [room, SERVER, bTabId],
  );
  check("join by code from any tab accepted", bj.ok);
  await bPage.waitForURL("https://www.youtube.com/watch?v=abc123", { timeout: 10000 }).catch(() => {});
  check("code-join navigated to host's video", bPage.url() === "https://www.youtube.com/watch?v=abc123");
  await sleep(3500);
  a = await vid(aPage);
  b = await vid(bPage);
  console.log(`  after code join: A=${JSON.stringify(a)} B=${JSON.stringify(b)}`);
  check("code-joiner synced", b && Math.abs(a.t - b.t) < 0.5);

  // ---- Joiner already has a name: invite page offers "Take your seat as …" ----
  await B.sw.evaluate(() => leave());
  const bPage2 = await B.ctx.newPage();
  await bPage2.goto(`${SERVER}/join/${room}`);
  await bPage2.waitForSelector("#v-join:not([hidden])", { timeout: 5000 }).catch(() => {});
  check("returning joiner offered their saved name", (await bPage2.textContent("#join")).includes("Yasso the Late"));
  await shot(bPage2, "invite-returning.png");

  // ---- Someone without the extension ----
  const C = await launch("no-ext", { extension: false });
  const cPage = await C.ctx.newPage();
  await cPage.goto(`${SERVER}/join/${room}`);
  await cPage.waitForSelector("#v-install:not([hidden])", { timeout: 5000 }).catch(() => {});
  check("no extension → install instructions", await cPage.isVisible("#v-install"));
  await shot(cPage, "invite-install.png");

  // ---- Expired party ----
  await cPage.goto(`${SERVER}/join/nobody-here-99`);
  await cPage.waitForSelector("#v-gone:not([hidden])", { timeout: 5000 }).catch(() => {});
  check("unknown party → 'party's over'", await cPage.isVisible("#v-gone"));
  await shot(cPage, "invite-gone.png");

  // Mobile-width look
  await cPage.setViewportSize({ width: 390, height: 844 });
  await cPage.goto(`${SERVER}/join/${room}`);
  await sleep(2000);
  await shot(cPage, "invite-mobile.png");

  await Promise.all([A.ctx.close(), B.ctx.close(), C.ctx.close()]);
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
