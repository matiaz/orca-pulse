import test from "node:test";
import assert from "node:assert/strict";
import { createReviewStore } from "../src/lib/review-store.mjs";

const A = "https://github.com/o/r/pull/1";
const B = "https://github.com/o/r/pull/2";
const DAY = 24 * 60 * 60 * 1000;

function setup({ stored = null, readThrows = false, writeThrows = false, max } = {}) {
  const clock = { now: 1_000_000 };
  const writes = [];
  const store = createReviewStore({
    readJson: (name, fallback) => {
      if (readThrows) throw new Error("boom");
      return stored ?? fallback;
    },
    writeJson: (name, value) => {
      if (writeThrows) throw new Error("disk");
      writes.push([name, structuredClone(value)]);
    },
    now: () => clock.now,
    max,
  });
  return { store, clock, writes };
}

test("record dedupes by url and persists to reviews.json", () => {
  const { store, writes, clock } = setup();
  assert.equal(store.has(A), false);
  assert.equal(store.get(A), null);
  store.record(A);
  clock.now += 5;
  store.record(A);
  assert.equal(store.has(A), true);
  assert.deepEqual(store.get(A), { startedAt: 1_000_005, lastSeen: 1_000_005 });
  assert.equal(writes.at(-1)[0], "reviews.json");
  assert.deepEqual(writes.at(-1)[1], { entries: { [A]: { startedAt: 1_000_005, lastSeen: 1_000_005 } } });
  store.record("https://evil.example/o/r/pull/1");
  assert.equal(Object.keys(writes.at(-1)[1].entries).length, 1);
});

test("update merges launchError, mergeError and mergeKey", () => {
  const { store } = setup();
  store.update(A, { launchError: "x" });
  assert.equal(store.has(A), false);
  store.record(A);
  store.update(A, { launchError: "no \u001b[31mworkspace", other: "dropped" });
  assert.deepEqual(store.get(A), { startedAt: 1_000_000, lastSeen: 1_000_000, launchError: "no workspace" });
  store.update(A, { mergeError: "blocked", mergeKey: "abc:CLEAN:squash" });
  store.update(A, { launchError: null });
  assert.deepEqual(store.get(A), { startedAt: 1_000_000, lastSeen: 1_000_000, mergeError: "blocked", mergeKey: "abc:CLEAN:squash" });
  store.get(A).mergeError = "mutated";
  assert.equal(store.get(A).mergeError, "blocked");
  store.record(A);
  assert.deepEqual(store.get(A), { startedAt: 1_000_000, lastSeen: 1_000_000 });
});

test("seen refreshes lastSeen and prunes entries unseen for 14 days", () => {
  const { store, clock } = setup();
  store.record(A);
  store.record(B);
  clock.now += 10 * DAY;
  store.seen([A]);
  assert.equal(store.get(A).lastSeen, clock.now);
  clock.now += 5 * DAY;
  store.seen([A]);
  assert.equal(store.has(A), true);
  assert.equal(store.has(B), false);
  store.seen("nope");
  assert.equal(store.has(A), true);
});

test("persistence round-trips and the entry count is capped", () => {
  const first = setup();
  first.store.record(A);
  first.store.update(A, { mergeError: "nope", mergeKey: "k" });
  const second = setup({ stored: first.writes.at(-1)[1] });
  assert.deepEqual(second.store.get(A), first.store.get(A));
  const capped = setup({ max: 2 });
  for (let i = 1; i <= 3; i++) {
    capped.clock.now += 1;
    capped.store.record(`https://github.com/o/r/pull/${i}`);
  }
  assert.equal(capped.store.has("https://github.com/o/r/pull/1"), false);
  assert.equal(capped.store.has("https://github.com/o/r/pull/3"), true);
});

test("corrupt or hostile files are tolerated", () => {
  for (const stored of ["garbage", 5, [], { entries: "x" }, { entries: [1, 2] }, { entries: { [A]: null } }]) {
    assert.equal(setup({ stored }).store.has(A), false);
  }
  assert.equal(setup({ readThrows: true }).store.has(A), false);
  const mixed = setup({
    stored: {
      entries: {
        [A]: { startedAt: 1, lastSeen: 2, mergeError: "a\u202eb", mergeKey: "bad key!" },
        [B]: { startedAt: "x", lastSeen: 2 },
        "https://evil.example/x/y/pull/1": { startedAt: 1, lastSeen: 2 },
        __proto__: { startedAt: 1, lastSeen: 2 },
      },
    },
  });
  assert.deepEqual(mixed.store.get(A), { startedAt: 1, lastSeen: 2, mergeError: "ab" });
  assert.equal(mixed.store.has(B), false);
  assert.equal(mixed.store.has("https://evil.example/x/y/pull/1"), false);
  const failing = setup({ writeThrows: true });
  assert.doesNotThrow(() => failing.store.record(A));
  assert.equal(failing.store.has(A), true);
});
