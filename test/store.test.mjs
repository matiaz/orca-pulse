import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let root;
let store;

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "orca-pulse-store-"));
  process.env.XDG_STATE_HOME = root;
  store = await import("../src/lib/store.mjs");
});

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

test("stateDir honours XDG_STATE_HOME lazily", () => {
  assert.equal(store.stateDir(), path.join(root, "orca-pulse"));
});

test("round-trip", () => {
  store.writeJson("a.json", { x: [1, 2] });
  assert.deepEqual(store.readJson("a.json", null), { x: [1, 2] });
});

test("file mode 0600 and dir mode 0700", () => {
  store.writeJson("b.json", {});
  assert.equal(fs.statSync(path.join(store.stateDir(), "b.json")).mode & 0o777, 0o600);
  assert.equal(fs.statSync(store.stateDir()).mode & 0o777, 0o700);
});

test("no tmp files left behind", () => {
  store.writeJson("c.json", {});
  assert.equal(fs.readdirSync(store.stateDir()).some((name) => name.endsWith(".tmp")), false);
});

test("tmp file is cleaned up when the write fails", () => {
  const circular = {};
  circular.self = circular;
  assert.throws(() => store.writeJson("e.json", circular));
  assert.equal(fs.readdirSync(store.stateDir()).some((name) => name.endsWith(".tmp")), false);
  assert.equal(fs.existsSync(path.join(store.stateDir(), "e.json")), false);
});

test("missing file returns fallback", () => {
  assert.deepEqual(store.readJson("missing.json", { f: 1 }), { f: 1 });
});

test("corrupt file returns fallback", () => {
  store.writeJson("d.json", {});
  fs.writeFileSync(path.join(store.stateDir(), "d.json"), "{nope");
  assert.equal(store.readJson("d.json", "fb"), "fb");
});

test("invalid names throw", () => {
  for (const name of ["", "../x.json", "a/b.json", "a\\b.json", "..", "a", "a.txt", ".json", ".hidden.json", "a b.json", "a.json\n", 5, null]) {
    assert.throws(() => store.writeJson(name, {}), /invalid/, String(name));
    assert.throws(() => store.readJson(name, null), /invalid/, String(name));
  }
});

test("valid names are accepted", () => {
  for (const name of ["a.json", "pulls-cache.json", "x_y.v2.json", "-a.json"]) {
    store.writeJson(name, 1);
    assert.equal(store.readJson(name, 0), 1);
  }
});

test("relative XDG_STATE_HOME is ignored", () => {
  const saved = process.env.XDG_STATE_HOME;
  const savedHome = process.env.HOME;
  const home = fs.mkdtempSync(path.join(root, "home-"));
  try {
    process.env.XDG_STATE_HOME = "relative/dir";
    process.env.HOME = home;
    assert.equal(store.stateDir(), path.join(home, ".local", "state", "orca-pulse"));
  } finally {
    process.env.XDG_STATE_HOME = saved;
    process.env.HOME = savedHome;
  }
});

test("stateDir refuses a symlinked directory", () => {
  const base = fs.mkdtempSync(path.join(root, "link-"));
  const target = fs.mkdtempSync(path.join(root, "target-"));
  fs.symlinkSync(target, path.join(base, "orca-pulse"));
  const saved = process.env.XDG_STATE_HOME;
  try {
    process.env.XDG_STATE_HOME = base;
    assert.throws(() => store.stateDir(), /symlink/);
  } finally {
    process.env.XDG_STATE_HOME = saved;
  }
});

test("stateDir refuses a directory owned by someone else", { skip: typeof process.getuid !== "function" }, (t) => {
  const base = fs.mkdtempSync(path.join(root, "owner-"));
  fs.mkdirSync(path.join(base, "orca-pulse"), { mode: 0o700 });
  const saved = process.env.XDG_STATE_HOME;
  const realUid = process.getuid;
  t.after(() => {
    process.getuid = realUid;
    process.env.XDG_STATE_HOME = saved;
  });
  process.getuid = () => realUid.call(process) + 1;
  process.env.XDG_STATE_HOME = base;
  assert.throws(() => store.stateDir(), /owned/);
});

test("quartileLevels basic case", () => {
  const level = store.quartileLevels([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(level(0), 0);
  assert.equal(level(1), 1);
  assert.equal(level(8), 4);
  assert.ok(level(4) >= 2 && level(4) <= 3);
  const empty = store.quartileLevels([]);
  assert.equal(empty(0), 0);
});
