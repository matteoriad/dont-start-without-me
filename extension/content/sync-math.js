// Pure sync math, shared by the content script, the background worker and
// the Node tests. No DOM, no chrome.* — keep it that way.
(function (root) {
  // Further apart than this: just jump.
  const SEEK_THRESHOLD = 1.5; // seconds
  // Between NUDGE and SEEK: speed up / slow down slightly until we match.
  const NUDGE_THRESHOLD = 0.3; // seconds
  // While nudging, keep going until we're this close.
  const SETTLE_THRESHOLD = 0.1; // seconds
  // Nudge speed is proportional to the gap: close it in roughly NUDGE_SECONDS,
  // but never change speed by more than MAX_NUDGE (keeps audio natural).
  const NUDGE_SECONDS = 4;
  const MAX_NUDGE = 0.15;

  /**
   * Where the sender's video should be *now*, given a state message.
   * state.sentAt and serverNow are both in server time (ms).
   */
  function expectedPosition(state, serverNow) {
    if (!state.playing) return state.position;
    const elapsed = Math.max(0, serverNow - state.sentAt) / 1000;
    return state.position + elapsed;
  }

  /**
   * Decide how to correct drift.
   * @returns {{action: "seek"|"rate"|"none", to?: number, rate: number, diff: number}}
   */
  function correction(localPos, targetPos, currentlyNudging) {
    const diff = targetPos - localPos; // > 0 means we're behind
    const abs = Math.abs(diff);
    if (abs >= SEEK_THRESHOLD) return { action: "seek", to: targetPos, rate: 1, diff };
    if (abs >= NUDGE_THRESHOLD || (currentlyNudging && abs > SETTLE_THRESHOLD)) {
      const delta = Math.max(-MAX_NUDGE, Math.min(MAX_NUDGE, diff / NUDGE_SECONDS));
      const minDelta = 0.03; // tiny gaps still need *some* push
      const rate = 1 + (Math.abs(delta) < minDelta ? Math.sign(diff) * minDelta : delta);
      return { action: "rate", rate: Math.round(rate * 1000) / 1000, diff };
    }
    return { action: "none", rate: 1, diff };
  }

  /**
   * NTP-style clock offset from ping samples: offset = serverTime - local midpoint.
   * Uses the sample with the lowest round-trip time (least noisy).
   * @param {{t0: number, t1: number, serverTime: number}[]} samples
   * @returns {number|null} serverTime - localTime, in ms
   */
  function estimateOffset(samples) {
    if (!samples || samples.length === 0) return null;
    let best = null;
    for (const s of samples) {
      const rtt = s.t1 - s.t0;
      if (rtt < 0) continue;
      if (!best || rtt < best.rtt) best = { rtt, s };
    }
    if (!best) return null;
    return Math.round(best.s.serverTime - (best.s.t0 + best.s.t1) / 2);
  }

  function formatTime(seconds) {
    const s = Math.max(0, Math.floor(seconds));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = String(s % 60).padStart(2, "0");
    return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
  }

  const api = {
    SEEK_THRESHOLD,
    NUDGE_THRESHOLD,
    SETTLE_THRESHOLD,
    expectedPosition,
    correction,
    estimateOffset,
    formatTime,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else (root.DSWM = root.DSWM || {}).math = api;
})(typeof self !== "undefined" ? self : this);
