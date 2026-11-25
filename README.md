# Don't Start Without Me 🍿

A Chrome extension for watching together, in sync, from different countries.
Each of you streams from your own account; the extension just makes sure that
when one of you presses play, pauses, or jumps, the other one does too.

Currently supports **YouTube**. More sites are a small adapter away (see below).

```
 Berlin                         relay server                       Cairo
┌──────────┐   "paused at 12:34"  ┌────────┐  "paused at 12:34"  ┌──────────┐
│ YouTube  │ ───────────────────► │  tiny  │ ──────────────────► │ YouTube  │
│ + ext.   │ ◄─────────────────── │   WS   │ ◄────────────────── │ + ext.   │
└──────────┘      heartbeats      └────────┘     heartbeats      └──────────┘
```

No video ever goes through the server — only small messages.

## Quick start (local, two Chrome profiles)

1. **Run the relay**
   ```bash
   cd server
   npm install
   npm start            # relay listening on :8787
   ```
2. **Load the extension**: `chrome://extensions` → turn on *Developer mode* →
   *Load unpacked* → pick the `extension/` folder.
3. Open the **same YouTube video** in two Chrome profiles (or two machines).
4. Click the extension icon → enter your name → pick a room code (or 🎲) →
   **Start / join party in this tab**. Do the same with the same room code on
   the other side.
5. Press play. Don't start without them.

## Watching with someone in another country

Both of you need to reach the same relay, so it has to be on the internet.

**Fastest test (5 minutes, free):** keep the relay running on your machine and
expose it with a Cloudflare quick tunnel:

```bash
cd server && npm start
# in another terminal:
npx cloudflared tunnel --url http://localhost:8787
# → prints https://something-random.trycloudflare.com
```

In the popup's *Server* field, both of you enter
`wss://something-random.trycloudflare.com`. The URL changes every time you
restart the tunnel.

**Permanent (free tier):** deploy `server/` to any Node host that supports
WebSockets (e.g. Render, Fly.io, Railway). Start command: `npm start`; the
server reads `PORT` from the environment. Then use `wss://your-app-host` in
the popup. Free tiers often sleep when idle, so the first connection of the
evening can take a moment.

## How the sync works

- **Events:** play, pause and seek in the party tab are sent to the room.
  Commands coming *from* the room are applied and their echo is suppressed,
  so you don't ping-pong.
- **Leader:** whoever acted last is the leader. While playing, the leader
  sends a heartbeat every 2 s with its position.
- **Drift correction:** everyone else compares against the heartbeat.
  - more than 1.5 s apart → seek
  - 0.3 – 1.5 s → speed up / slow down slightly (max ±15%) until within 0.1 s
- **Clocks:** the background worker pings the relay (NTP-style, lowest
  round-trip wins) so "playing at 12:34, sent at T" means the same thing on
  both machines.
- **Ads:** while YouTube shows an ad, that side neither sends nor applies
  anything; it catches up afterwards.
- **Different videos:** if your partner is watching something else, you get a
  "Join them" button instead of a hijacked player.

## Project layout

```
extension/
  manifest.json
  background.js          WebSocket to the relay, room, clock offset
  popup.html/.css/.js    join / leave UI
  content/
    sync-math.js         pure functions: drift, clock offset (unit-tested)
    core.js              the sync engine (site-agnostic)
    adapters/
      registry.js        adapter interface + default <video> controls
      youtube.js         YouTube adapter
server/
  server.js              the relay (Node + ws)
  test/                  unit tests: `npm test`
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
| `controls(video)` *(optional)* | custom `{play, pause, seek, getTime, isPaused, setRate}` for sites that break when you touch `<video>` directly |

Then add the site to `host_permissions` and `content_scripts` in the manifest,
and to the supported-site check in `popup.js`.

**Netflix heads-up:** setting `video.currentTime` directly triggers a playback
error. Its adapter needs a `controls()` that talks to Netflix's own player API
from a script injected into the page's main world.

## Tests

```bash
cd server && npm test                  # relay + sync math
cd e2e && npm install && npm test      # full browser test (needs Chrome, ffmpeg, openssl)
```

The e2e test maps `www.youtube.com` to a local HTTPS page with a test video,
loads the extension into two Chrome profiles and checks play, seek, pause,
drift correction and the "watching something else" prompt.

## Known limitations / next ideas

- Only YouTube so far.
- Desktop Chrome/Edge only (no phones, no Fire TV — unless the laptop is on HDMI).
- If one side buffers, the other keeps playing and the laggard catches up via
  seek. A real "wait for me" (auto-pause while someone buffers) would suit the
  name.
- No chat or reactions yet. Some would argue that's what the phone call is for.

## License

MIT
