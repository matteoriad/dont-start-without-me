const test = require("node:test");
const assert = require("node:assert");
const math = require("../../extension/content/sync-math.js");

test("expectedPosition adds elapsed time only while playing", () => {
  assert.equal(math.expectedPosition({ playing: false, position: 10, sentAt: 0 }, 5000), 10);
  assert.equal(math.expectedPosition({ playing: true, position: 10, sentAt: 1000 }, 3500), 12.5);
  // Clock skew can make "now" look earlier than sentAt — never go backwards.
  assert.equal(math.expectedPosition({ playing: true, position: 10, sentAt: 5000 }, 4000), 10);
});

test("correction: seek when far, nudge when close, settle while nudging", () => {
  assert.equal(math.correction(10, 13, false).action, "seek");
  assert.equal(math.correction(13, 10, false).action, "seek");

  const behind = math.correction(10, 10.5, false);
  assert.equal(behind.action, "rate");
  assert.ok(behind.rate > 1);

  const ahead = math.correction(10.5, 10, false);
  assert.equal(ahead.action, "rate");
  assert.ok(ahead.rate < 1);

  // Proportional, but capped.
  assert.ok(math.correction(10, 11.2, false).rate <= 1.15);
  assert.ok(math.correction(10, 10.5, false).rate > math.correction(10, 10.35, false).rate);

  assert.equal(math.correction(10, 10.2, false).action, "none");
  assert.equal(math.correction(10, 10.2, true).action, "rate"); // keep nudging until settled
  assert.equal(math.correction(10, 10.05, true).action, "none");
});

test("estimateOffset picks the lowest-RTT sample", () => {
  const samples = [
    { t0: 0, t1: 400, serverTime: 5300 }, // noisy
    { t0: 1000, t1: 1040, serverTime: 6020 }, // clean: offset = 6020 - 1020 = 5000
  ];
  assert.equal(math.estimateOffset(samples), 5000);
  assert.equal(math.estimateOffset([]), null);
});

test("formatTime", () => {
  assert.equal(math.formatTime(5), "0:05");
  assert.equal(math.formatTime(754), "12:34");
  assert.equal(math.formatTime(3725), "1:02:05");
});
