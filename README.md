# Don't Start Without Me 🍿

A Chrome extension for watching together, in sync, from different countries.
Each of you streams from your own account; the extension just makes sure that
when one of you presses play, pauses, or jumps, the other one does too.

Supports **YouTube**, **Netflix** and **Apple TV** (tv.apple.com in Chrome). More sites are a small adapter away (see below).

```
 Berlin                         relay server                       Cairo
┌──────────┐   "paused at 12:34"  ┌────────┐  "paused at 12:34"  ┌──────────┐
│ YouTube  │ ───────────────────► │  tiny  │ ──────────────────► │ YouTube  │
│ + ext.   │ ◄─────────────────── │   WS   │ ◄────────────────── │ + ext.   │
└──────────┘      heartbeats      └────────┘     heartbeats      └──────────┘
```

No video ever goes through the server — only small messages.

## How it's meant to work

1. Install the extension.
2. Open a video on YouTube, Netflix or tv.apple.com, click the extension, **Start a party**.
3. Send the party code to the other person. They open the same video and
   paste it under **or join theirs**.
4. Press play. Don't start without them.

The relay server is built into the extension (`extension/config.js`), so
nobody ever has to type a server address.

## Deploying the relay

The relay is the Node app at the root of this repo (`server.js`,
`npm start`, listens on `PORT`, default 8787). It speaks two ways:

- **WebSocket**: used automatically when the host allows it (any VPS).
- **HTTP long-polling**: automatic fallback for hosts that block inbound
  WebSockets, such as Hostinger's managed Node.js web apps. Slightly more
  traffic, same sync quality.

**Hostinger managed Node.js (deploy from GitHub):** add a Node.js web app,
connect this repo, entry file `server.js`, start command `npm start`.
Use the HTTPS address Hostinger gives the app.

**Hostinger VPS (or any Linux server):**

```bash
git clone https://github.com/matteoriad/dont-start-without-me && cd dont-start-without-me
npm install --omit=dev
npx pm2 start server.js --name dswm && npx pm2 save   # keeps it running
```

Open port 8787 in the firewall. The address is then `http://<server-ip>:8787`.

**Then:** put that address in `extension/config.js` and reload the extension.

Check it's alive by opening the address in a browser: it says
`ok — don't start without me`.

## Developing locally

```bash
npm install && npm start                 # relay on http://localhost:8787
```

`chrome://extensions` → *Developer mode* → *Load unpacked* → `extension/`.
Use two Chrome profiles to be both people. To use your local relay instead of
the built-in one, enter `http://localhost:8787` in the popup's *Advanced* field.

## How the sync works

- **The host is the source of truth.** Whoever starts the party is the host
  (if they leave, the next person takes over). When someone joins, the host
  sends them where it is and they jump there. Joining never moves the host.
- **Only real actions are shared.** A play, pause or seek is sent to the
  others only if the person clicked or pressed a key just before. Autoplay,
  a player reloading or an ad ending is never broadcast.
- **Drift correction:** while playing, the host sends a heartbeat every 2 s.
  Everyone else compares against it:
  - more than 1.5 s apart → seek
  - 0.3 – 1.5 s → speed up / slow down slightly (max ±15%) until within 0.1 s
- **Ads:**
  - an ad while you're still joining holds nobody up; you catch up after it
  - an ad later on pauses everyone else ("Yasso got an ad. Waiting for
    them…") and they continue automatically when it's over
- **Different videos:** if your partner is watching something else, you get a
  "Join them" button instead of a hijacked player.
- **Connection:** WebSocket if possible, otherwise HTTP long-polling.
- **Clocks:** the background worker pings the relay (NTP-style, lowest
  round-trip wins) so "playing at 12:34, sent at T" means the same thing on
  both machines.

## Project layout

```
extension/
  manifest.json
  config.js              the built-in relay address
  transport.js           WebSocket, or HTTP long-polling fallback
  background.js          connection to the relay, room, clock offset
  popup.html/.css/.js    start / join / leave UI
  content/
    sync-math.js         pure functions: drift, clock offset (unit-tested)
    core.js              the sync engine (site-agnostic)
    adapters/
      registry.js        adapter interface + default <video> controls
      youtube.js         YouTube adapter
      netflix.js         Netflix adapter (seeks via netflix-main.js)
      netflix-main.js    runs in Netflix's page to reach its player API
      appletv.js         Apple TV adapter (video inside shadow DOM)
server.js                entry point (what the host runs)
lib/relay.js             the relay (Node + ws)
test/                    unit tests: `npm test`
e2e/
  run.js                 two real Chrome profiles + fake YouTube page + relay
```

## Adding a streaming service

Write `extension/content/adapters/<site>.js` that calls `DSWM.registerAdapter`
with:

| field | what it does |
|---|---|
| `name` | e.g. `"Netflix"` |
| `matches(location)` | is this page yours? |
| `getVideo()` | the `<video>` element (or `null`) |
| `getMediaId()` | id of what's playing, to detect "watching different things" |
| `getMediaUrl()` | link the partner can open |
| `isReady()` | `false` during ads / loading screens |
| `isAd()` *(optional)* | `true` while an ad plays, so the party can wait |
| `controls(video)` *(optional)* | custom `{play, pause, seek, getTime, isPaused, setRate}` for sites that break when you touch `<video>` directly |

Then add the site to `host_permissions` and `content_scripts` in the manifest,
and to the supported-site check in `popup.js`.

**Example of a tricky site:** Netflix errors out if you set
`video.currentTime` directly, so `netflix.js` provides `controls()` that send
seeks to `netflix-main.js`, which runs in the page's own context (manifest
`"world": "MAIN"`) and calls Netflix's player API.

## Tests

```bash
npm test                                   # relay (both transports) + sync math
cd e2e && npm install && npm test          # full browser test (needs Chrome, ffmpeg, openssl)
cd e2e && HTTP_ONLY=1 npm test             # same, with WebSockets blocked
node e2e/sites.js                          # Netflix + Apple TV adapters against mock pages
```

The e2e test maps `www.youtube.com` to a local HTTPS page with a test video,
loads the extension into two Chrome profiles and checks: joining mid-video
doesn't move the host, the joiner's autoplay isn't shared, real clicks are,
mid-video ads pause the other side, join-time ads don't, drift correction,
and the "watching something else" prompt.

## Known limitations / next ideas

- Netflix and Apple TV are tested against mock pages that copy their player
  structure, not the real sites. Ads on Netflix/Apple TV aren't detected yet
  (YouTube only).
- Netflix and Apple TV catalogs differ by country: both people need the title
  available in their region.
- Desktop Chrome/Edge only (no phones, no Fire TV — unless the laptop is on HDMI).
- If one side buffers, the other keeps playing and the laggard catches up via
  seek. A real "wait for me" (auto-pause while someone buffers) would suit the
  name.
- No chat or reactions yet. Some would argue that's what the phone call is for.

## License

MIT
