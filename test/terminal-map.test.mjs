import test from "node:test";
import assert from "node:assert/strict";
import { createTerminalMap } from "../src/lib/terminal-map.mjs";

function setup({ stored = null, max, readThrows = false } = {}) {
  const clock = { now: 1000 };
  const writes = [];
  const timers = [];
  const map = createTerminalMap({
    readJson: (name, fallback) => {
      if (readThrows) throw new Error("boom");
      return stored ?? fallback;
    },
    writeJson: (name, value) => writes.push([name, value]),
    now: () => clock.now,
    max,
    timers: {
      setTimeout: (fn, ms) => {
        const handle = { fn, ms, unref() { handle.unrefd = true; } };
        timers.push(handle);
        return handle;
      },
      clearTimeout: (handle) => {
        handle.cleared = true;
      },
    },
  });
  return { map, clock, writes, timers };
}

test("resolve returns the most recently learned workspace", () => {
  const { map, clock } = setup();
  map.learn("t1", "w1");
  clock.now += 10;
  map.learn("t2", "w2");
  assert.equal(map.resolve(["t1", "t2"]), "w2");
  clock.now += 10;
  map.learn("t1", "w1");
  assert.equal(map.resolve(["t1", "t2"]), "w1");
  assert.equal(map.resolve(["t3"]), null);
  assert.equal(map.resolve([]), null);
  assert.equal(map.resolve(null), null);
});

test("learn ignores invalid ids", () => {
  const { map } = setup();
  map.learn("t 1", "w1");
  map.learn("t1", "w 1");
  map.learn("", "w1");
  map.learn("t1", "");
  map.learn(5, "w1");
  map.learn("t1", null);
  map.learn("a".repeat(201), "w1");
  map.learn("t1", "w".repeat(201));
  assert.equal(map.resolve(["t1", "5", "a".repeat(201)]), null);
  map.learn("a".repeat(200), "identity:wt2:local:abc.1-2");
  assert.equal(map.resolve(["a".repeat(200)]), "identity:wt2:local:abc.1-2");
});

test("resolve ignores non-string terminal ids", () => {
  const { map } = setup();
  map.learn("t1", "w1");
  assert.equal(map.resolve([1, null, {}, "t1"]), "w1");
});

test("entries are capped by least recently learned", () => {
  const { map, clock } = setup({ max: 3 });
  for (const id of ["a", "b", "c"]) {
    clock.now += 1;
    map.learn(id, `w-${id}`);
  }
  clock.now += 1;
  map.learn("a", "w-a");
  clock.now += 1;
  map.learn("d", "w-d");
  assert.equal(map.resolve(["b"]), null);
  assert.equal(map.resolve(["a"]), "w-a");
  assert.equal(map.resolve(["c"]), "w-c");
  assert.equal(map.resolve(["d"]), "w-d");
});

test("prune drops entries for missing workspaces", () => {
  const { map } = setup();
  map.learn("t1", "w1");
  map.learn("t2", "w2");
  map.prune(["w2"]);
  assert.equal(map.resolve(["t1"]), null);
  assert.equal(map.resolve(["t2"]), "w2");
  map.prune([]);
  assert.equal(map.resolve(["t2"]), null);
});

test("writes are debounced and unref'd, and flush writes immediately", () => {
  const { map, writes, timers } = setup();
  map.learn("t1", "w1");
  map.learn("t2", "w2");
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 2000);
  assert.equal(timers[0].unrefd, true);
  assert.equal(writes.length, 0);
  timers[0].fn();
  assert.equal(writes.length, 1);
  assert.equal(writes[0][0], "terminals.json");
  map.learn("t3", "w3");
  map.flush();
  assert.equal(writes.length, 2);
  assert.equal(timers.at(-1).cleared, true);
  map.flush();
  assert.equal(writes.length, 2);
});

test("a throwing write does not escape", () => {
  const timers = [];
  const map = createTerminalMap({
    readJson: (_n, fallback) => fallback,
    writeJson: () => {
      throw new Error("disk");
    },
    now: () => 1,
    timers: { setTimeout: (fn) => (timers.push(fn), { unref() {} }), clearTimeout() {} },
  });
  map.learn("t1", "w1");
  assert.doesNotThrow(() => map.flush());
});

test("persistence round-trips", () => {
  const first = setup();
  first.map.learn("t1", "w1");
  first.clock.now += 5;
  first.map.learn("t2", "w2");
  first.map.flush();
  const saved = first.writes.at(-1)[1];
  const second = setup({ stored: JSON.parse(JSON.stringify(saved)) });
  assert.equal(second.map.resolve(["t1"]), "w1");
  assert.equal(second.map.resolve(["t1", "t2"]), "w2");
});

test("corrupt or hostile files are tolerated", () => {
  for (const stored of ["garbage", 5, [], { entries: "x" }, { entries: [null, 3, "x", { terminalId: 1 }] }]) {
    const { map } = setup({ stored });
    assert.equal(map.resolve(["t1"]), null);
  }
  assert.equal(setup({ readThrows: true }).map.resolve(["t1"]), null);
  const mixed = setup({
    stored: {
      entries: [
        { terminalId: "ok", workspaceId: "w1", at: 5 },
        { terminalId: "bad id", workspaceId: "w1", at: 5 },
        { terminalId: "ok2", workspaceId: "w 2", at: 5 },
        { terminalId: "ok3", workspaceId: "w3", at: "x" },
      ],
    },
  });
  assert.equal(mixed.map.resolve(["ok"]), "w1");
  assert.equal(mixed.map.resolve(["bad id", "ok2", "ok3"]), null);
});

test("load respects the cap", () => {
  const entries = Array.from({ length: 10 }, (_, i) => ({ terminalId: `t${i}`, workspaceId: `w${i}`, at: i }));
  const { map } = setup({ stored: { entries }, max: 4 });
  assert.equal(map.resolve(["t0"]), null);
  assert.equal(map.resolve(["t5"]), null);
  assert.equal(map.resolve(["t6"]), "w6");
  assert.equal(map.resolve(["t9"]), "w9");
});
