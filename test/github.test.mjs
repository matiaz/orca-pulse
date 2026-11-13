import test from "node:test";
import assert from "node:assert/strict";
import { chunkRanges, mergeDays, createGithub } from "../src/sources/github.mjs";
import { isoDay } from "../src/lib/days.mjs";

const d = (y, m, day) => new Date(y, m - 1, day);
const fmt = (ranges) => ranges.map((r) => [isoDay(r.from), isoDay(r.to)]);

test("chunkRanges returns one chunk for a short range", () => {
  assert.deepEqual(fmt(chunkRanges(d(2026, 1, 1), d(2026, 3, 1))), [["2026-01-01", "2026-03-01"]]);
});

test("chunkRanges splits long ranges into contiguous chunks", () => {
  const ranges = chunkRanges(d(2024, 1, 1), d(2026, 1, 1));
  assert.equal(isoDay(ranges[0].from), "2024-01-01");
  assert.equal(isoDay(ranges.at(-1).to), "2026-01-01");
  for (let i = 1; i < ranges.length; i++) {
    const gap = (ranges[i].from - ranges[i - 1].to) / 86400000;
    assert.ok(gap > 0.9 && gap < 1.1, `gap ${gap}`);
  }
  for (const range of ranges) assert.ok(Math.round((range.to - range.from) / 86400000) <= 364);
});

test("chunkRanges handles equal and inverted ranges", () => {
  assert.deepEqual(fmt(chunkRanges(d(2026, 1, 1), d(2026, 1, 1))), [["2026-01-01", "2026-01-01"]]);
  assert.deepEqual(chunkRanges(d(2026, 1, 2), d(2026, 1, 1)), []);
});

const weeks = [
  { contributionDays: [{ date: "2026-01-01", contributionCount: 3, contributionLevel: "SECOND_QUARTILE" }, { date: "2026-01-02", contributionCount: 0, contributionLevel: "NONE" }] },
  { contributionDays: [{ date: "2026-01-03", contributionCount: 9, contributionLevel: "FOURTH_QUARTILE" }] },
];

test("mergeDays maps levels and does not mutate the cache", () => {
  const cache = { "2025-12-31": [1, 1], "2026-01-01": [99, 4] };
  const merged = mergeDays(cache, weeks);
  assert.deepEqual(merged, { "2025-12-31": [1, 1], "2026-01-01": [3, 2], "2026-01-02": [0, 0], "2026-01-03": [9, 4] });
  assert.deepEqual(cache, { "2025-12-31": [1, 1], "2026-01-01": [99, 4] });
});

test("mergeDays ignores malformed entries and unknown levels", () => {
  const merged = mergeDays({}, [
    { contributionDays: [
      { date: "not-a-date", contributionCount: 1, contributionLevel: "NONE" },
      { date: "2026-01-04", contributionCount: -2, contributionLevel: "NONE" },
      { date: "2026-01-05", contributionCount: "x", contributionLevel: "NONE" },
      { date: "2026-01-06", contributionCount: 2, contributionLevel: "WEIRD" },
      { date: "__proto__", contributionCount: 2, contributionLevel: "NONE" },
      null,
    ] },
    null,
  ]);
  assert.deepEqual(merged, { "2026-01-06": [2, 0] });
});

function makeEnv(nowRef) {
  const store = new Map();
  const calls = [];
  const gh = async (args) => {
    calls.push(args);
    const from = args.find((a) => a.startsWith("from=")).slice(5, 15);
    const to = args.find((a) => a.startsWith("to=")).slice(3, 13);
    const contributionDays = [];
    for (let day = new Date(`${from}T00:00:00`); isoDay(day) <= to; day = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1)) {
      contributionDays.push({ date: isoDay(day), contributionCount: 2, contributionLevel: "FIRST_QUARTILE" });
    }
    const body = { data: { viewer: { login: "me\u202e", contributionsCollection: { contributionCalendar: { weeks: [{ contributionDays }] } } } } };
    return { code: 0, stdout: JSON.stringify(body), stderr: "" };
  };
  return {
    calls,
    store,
    deps: {
      gh,
      readJson: (name, fallback) => (store.has(name) ? structuredClone(store.get(name)) : fallback),
      writeJson: (name, value) => store.set(name, structuredClone(value)),
      now: () => nowRef.t,
    },
  };
}

test("sync fetches chunks via gh graphql and snapshots days", async () => {
  const nowRef = { t: new Date(2026, 9, 10, 12).getTime() };
  const env = makeEnv(nowRef);
  const github = createGithub(env.deps);
  await github.sync(false, { from: d(2026, 10, 1), to: d(2026, 10, 10) });
  assert.equal(env.calls.length, 1);
  assert.deepEqual(env.calls[0].slice(0, 3), ["api", "graphql", "-f"]);
  assert.ok(env.calls[0].includes("from=2026-10-01T00:00:00"));
  assert.ok(env.calls[0].includes("to=2026-10-10T23:59:59"));
  const snap = github.snapshot();
  assert.equal(snap.login, "me");
  assert.deepEqual(snap.days["2026-10-01"], [2, 1]);
  assert.equal(snap.error, null);
  assert.equal(snap.hint, null);
  assert.equal(typeof snap.updatedAt, "string");
  assert.ok(env.store.has("github.json"));
});

test("the chunk containing today is refetched only after 10 minutes", async () => {
  const nowRef = { t: new Date(2026, 9, 10, 12).getTime() };
  const env = makeEnv(nowRef);
  const github = createGithub(env.deps);
  const range = { from: d(2026, 10, 1), to: d(2026, 10, 10) };
  await github.sync(false, range);
  nowRef.t += 5 * 60 * 1000;
  await github.sync(false, range);
  assert.equal(env.calls.length, 1);
  nowRef.t += 6 * 60 * 1000;
  await github.sync(false, range);
  assert.equal(env.calls.length, 2);
  await github.sync(true, range);
  assert.equal(env.calls.length, 3);
});

test("past chunks that are fully cached are not refetched", async () => {
  const nowRef = { t: new Date(2026, 9, 10, 12).getTime() };
  const env = makeEnv(nowRef);
  const days = {};
  for (let day = d(2026, 1, 1); day <= d(2026, 1, 31); day = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1)) days[isoDay(day)] = [1, 1];
  env.store.set("github.json", { login: "me", days, recentAt: 0 });
  const cached = createGithub(env.deps);
  await cached.sync(false, { from: d(2026, 1, 1), to: d(2026, 1, 31) });
  assert.equal(env.calls.length, 0);
});

test("missing gh sets the install hint and keeps cached days", async () => {
  const nowRef = { t: new Date(2026, 9, 10, 12).getTime() };
  const env = makeEnv(nowRef);
  env.store.set("github.json", { login: "me", days: { "2026-10-01": [5, 2] }, recentAt: 0 });
  const github = createGithub({ ...env.deps, gh: async () => { throw Object.assign(new Error("x"), { code: "ENOENT" }); } });
  await github.sync(true, { from: d(2026, 10, 1), to: d(2026, 10, 10) });
  const snap = github.snapshot();
  assert.equal(snap.hint, "Install the GitHub CLI (gh) and run gh auth login");
  assert.deepEqual(snap.days["2026-10-01"], [5, 2]);
});

test("auth failure sets the login hint", async () => {
  const nowRef = { t: new Date(2026, 9, 10, 12).getTime() };
  const env = makeEnv(nowRef);
  const github = createGithub({ ...env.deps, gh: async () => ({ code: 1, stdout: "", stderr: "run gh auth login" }) });
  await github.sync(true, { from: d(2026, 10, 1), to: d(2026, 10, 10) });
  assert.equal(github.snapshot().hint, "Run gh auth login");
});

test("a throwing readJson does not break creation or sync", async () => {
  const env = makeEnv({ t: new Date(2026, 9, 10, 12).getTime() });
  const github = createGithub({ ...env.deps, readJson: () => { throw new Error("corrupt"); } });
  assert.ok(github.snapshot().error);
  await github.sync(true, { from: d(2026, 10, 1), to: d(2026, 10, 10) });
  assert.equal(github.snapshot().error, null);
  assert.deepEqual(github.snapshot().days["2026-10-01"], [2, 1]);
});

test("a caller-supplied from is clamped to five years before to", async () => {
  const env = makeEnv({ t: new Date(2026, 9, 10, 12).getTime() });
  const github = createGithub(env.deps);
  await github.sync(true, { from: d(2000, 1, 1), to: d(2026, 10, 10) });
  const firstFrom = env.calls[0].find((a) => a.startsWith("from=")).slice(5, 15);
  assert.equal(firstFrom, "2021-10-10");
});

test("a successful sync clears the failure cooldown", async () => {
  const env = makeEnv({ t: new Date(2026, 9, 10, 12).getTime() });
  let fail = true;
  const real = env.deps.gh;
  const github = createGithub({ ...env.deps, gh: (args) => (fail ? Promise.resolve({ code: 1, stdout: "", stderr: "boom" }) : real(args)) });
  const range = { from: d(2026, 10, 1), to: d(2026, 10, 10) };
  await github.sync(true, range);
  assert.ok(github.snapshot().error);
  fail = false;
  await github.sync(true, range);
  assert.equal(github.snapshot().error, null);
  const callsBefore = env.calls.length;
  fail = true;
  await github.sync(false, { from: d(2026, 9, 1), to: d(2026, 10, 10) });
  assert.ok(env.calls.length >= callsBefore);
});

test("a call with a different range during a pending sync runs afterwards", async () => {
  const env = makeEnv({ t: new Date(2026, 9, 10, 12).getTime() });
  const real = env.deps.gh;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let first = true;
  const github = createGithub({
    ...env.deps,
    gh: async (args) => {
      if (first) {
        first = false;
        await gate;
      }
      return real(args);
    },
  });
  const a = github.sync(true, { from: d(2026, 10, 5), to: d(2026, 10, 10) });
  const b = github.sync(false, { from: d(2026, 9, 1), to: d(2026, 10, 10) });
  release();
  await Promise.all([a, b]);
  const days = github.snapshot().days;
  assert.ok("2026-09-01" in days);
  assert.ok("2026-10-10" in days);
});

test("an identical call during a pending sync shares it", async () => {
  const env = makeEnv({ t: new Date(2026, 9, 10, 12).getTime() });
  const github = createGithub(env.deps);
  const range = { from: d(2026, 10, 1), to: d(2026, 10, 10) };
  await Promise.all([github.sync(true, range), github.sync(true, range)]);
  assert.equal(env.calls.length, 1);
});
