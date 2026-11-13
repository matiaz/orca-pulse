import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { parseLimits, resetLabel, createLimits, createTokenReader } from "../src/sources/limits.mjs";

const SECRET = "tok-SECRET";

test("parseLimits clamps and whitelists", () => {
  const out = parseLimits({
    five_hour: { utilization: 150, resets_at: "2026-11-10T14:00:00Z", extra: "x" },
    seven_day: { utilization: -5, resets_at: "nope" },
    other: { utilization: 1 },
  });
  assert.deepEqual(out, {
    fiveHour: { pct: 100, resetsAt: "2026-11-10T14:00:00.000Z" },
    sevenDay: { pct: 0, resetsAt: null },
  });
});

test("parseLimits ignores non-numbers and junk", () => {
  assert.deepEqual(parseLimits({ five_hour: { utilization: "40" }, seven_day: null }), { fiveHour: null, sevenDay: null });
  assert.deepEqual(parseLimits({ five_hour: { utilization: NaN } }), { fiveHour: null, sevenDay: null });
  assert.deepEqual(parseLimits(null), { fiveHour: null, sevenDay: null });
  assert.deepEqual(parseLimits("x"), { fiveHour: null, sevenDay: null });
  assert.deepEqual(parseLimits({ five_hour: { utilization: 42.5 } }).fiveHour, { pct: 42.5, resetsAt: null });
});

const NOW = new Date(2026, 10, 10, 12, 0).getTime();

test("resetLabel under 24h shows hours and minutes", () => {
  assert.equal(resetLabel(new Date(2026, 10, 10, 14, 38).toISOString(), NOW), "resets in 2h 38m");
  assert.equal(resetLabel(new Date(2026, 10, 10, 12, 38).toISOString(), NOW), "resets in 38m");
  assert.equal(resetLabel(new Date(NOW + 30_000).toISOString(), NOW), "resets in <1m");
  assert.equal(resetLabel(new Date(NOW + 23 * 3600_000 + 59 * 60_000).toISOString(), new Date(NOW)), "resets in 23h 59m");
});

test("resetLabel at 24h or more shows weekday and time", () => {
  assert.equal(resetLabel(new Date(2026, 10, 17, 14, 0).toISOString(), NOW), "resets Tue 14:00");
  assert.equal(resetLabel(new Date(2026, 10, 12, 9, 5).toISOString(), NOW), "resets Thu 09:05");
});

test("resetLabel handles past and invalid input", () => {
  assert.equal(resetLabel(new Date(NOW - 1000).toISOString(), NOW), "resets now");
  assert.equal(resetLabel("garbage", NOW), null);
  assert.equal(resetLabel(null, NOW), null);
});

function makeEnv({ enabled = true, token = SECRET, response } = {}) {
  const store = new Map();
  const nowRef = { t: NOW };
  const counts = { token: 0, fetch: 0 };
  const requests = [];
  const env = {
    store,
    nowRef,
    counts,
    requests,
    state: { enabled, response: response ?? { ok: true, status: 200, json: async () => ({ five_hour: { utilization: 41, resets_at: "2026-11-10T15:00:00Z", leak: SECRET }, seven_day: { utilization: 12.5, resets_at: "2026-11-14T15:00:00Z" } }) } },
    deps: {
      enabled: () => env.state.enabled,
      readToken: async () => {
        counts.token++;
        if (token instanceof Error) throw token;
        return token;
      },
      fetch: async (url, init) => {
        counts.fetch++;
        requests.push({ url, init });
        if (env.state.response instanceof Error) throw env.state.response;
        return env.state.response;
      },
      now: () => nowRef.t,
      readJson: (name, fallback) => (store.has(name) ? structuredClone(store.get(name)) : fallback),
      writeJson: (name, value) => store.set(name, structuredClone(value)),
    },
  };
  return env;
}

test("disabled sync makes no token read, no fetch, and returns enabled false", async () => {
  const env = makeEnv({ enabled: false });
  const limits = createLimits(env.deps);
  assert.deepEqual(await limits.sync(true), { enabled: false });
  assert.deepEqual(await limits.sync(false), { enabled: false });
  assert.deepEqual(limits.snapshot(), { enabled: false });
  assert.equal(env.counts.token, 0);
  assert.equal(env.counts.fetch, 0);
  assert.equal(env.store.size, 0);
});

test("enabled sync sends the request with the expected hardening", async () => {
  const env = makeEnv();
  const limits = createLimits(env.deps);
  const snap = await limits.sync(false);
  assert.equal(env.requests.length, 1);
  const { url, init } = env.requests[0];
  assert.equal(url, "https://api.anthropic.com/api/oauth/usage");
  assert.deepEqual(init.headers, { Authorization: `Bearer ${SECRET}`, "anthropic-beta": "oauth-2025-04-20" });
  assert.equal(init.redirect, "error");
  assert.ok(init.signal instanceof AbortSignal);
  assert.equal(snap.enabled, true);
  assert.deepEqual(snap.fiveHour, { pct: 41, resetsAt: "2026-11-10T15:00:00.000Z" });
  assert.deepEqual(snap.sevenDay, { pct: 12.5, resetsAt: "2026-11-14T15:00:00.000Z" });
  assert.equal(snap.error, null);
  assert.equal(typeof snap.updatedAt, "string");
});

test("cache holds only whitelisted fields and no token", async () => {
  const env = makeEnv();
  await createLimits(env.deps).sync(false);
  const cached = env.store.get("claude-limits.json");
  assert.deepEqual(Object.keys(cached).sort(), ["backoffUntil", "error", "fetchedAt", "five_hour", "hint", "seven_day"]);
  assert.deepEqual(Object.keys(cached.five_hour).sort(), ["resets_at", "utilization"]);
  assert.equal(JSON.stringify(cached).includes(SECRET), false);
  assert.equal(JSON.stringify(cached).includes("leak"), false);
});

test("cache is used for the snapshot when enabled", () => {
  const env = makeEnv();
  env.store.set("claude-limits.json", { five_hour: { utilization: 70, resets_at: "2026-11-10T15:00:00Z" }, seven_day: null, fetchedAt: NOW - 1000 });
  const limits = createLimits(env.deps);
  assert.deepEqual(limits.snapshot().fiveHour, { pct: 70, resetsAt: "2026-11-10T15:00:00.000Z" });
  assert.equal(limits.snapshot().sevenDay, null);
});

test("sync respects the 2 minute interval unless forced", async () => {
  const env = makeEnv();
  const limits = createLimits(env.deps);
  await limits.sync(false);
  env.nowRef.t += 60_000;
  await limits.sync(false);
  assert.equal(env.counts.fetch, 1);
  await limits.sync(true);
  assert.equal(env.counts.fetch, 2);
  env.nowRef.t += 121_000;
  await limits.sync(false);
  assert.equal(env.counts.fetch, 3);
});

test("429 backs off for 10 minutes even when forced", async () => {
  const env = makeEnv({ response: { ok: false, status: 429, json: async () => ({}) } });
  const limits = createLimits(env.deps);
  const snap = await limits.sync(false);
  assert.equal(snap.error, "usage request failed (429)");
  env.nowRef.t += 5 * 60_000;
  await limits.sync(true);
  assert.equal(env.counts.fetch, 1);
  env.nowRef.t += 5 * 60_000 + 1000;
  await limits.sync(false);
  assert.equal(env.counts.fetch, 2);
});

test("errors never contain the token", async () => {
  const cases = [
    { token: new Error(`boom ${SECRET}`) },
    { response: new Error(`Bearer ${SECRET} failed`) },
    { response: Object.assign(new Error(`timeout ${SECRET}`), { name: "TimeoutError" }) },
    { response: { ok: false, status: 401, json: async () => ({ error: SECRET }) } },
    { response: { ok: false, status: 500, json: async () => ({ error: SECRET }) } },
    { response: { ok: true, status: 200, json: async () => { throw new Error(`bad ${SECRET}`); } } },
  ];
  for (const options of cases) {
    const env = makeEnv(options);
    const limits = createLimits(env.deps);
    const snap = await limits.sync(true);
    assert.ok(snap.error, JSON.stringify(Object.keys(options)));
    assert.equal(JSON.stringify(snap).includes(SECRET), false);
    assert.equal(JSON.stringify([...env.store.values()]).includes(SECRET), false);
  }
});

test("failed requests use generic messages and keep last good data", async () => {
  const env = makeEnv();
  const limits = createLimits(env.deps);
  await limits.sync(false);
  env.state.response = { ok: false, status: 401, json: async () => ({}) };
  env.nowRef.t += 121_000;
  const snap = await limits.sync(false);
  assert.equal(snap.error, "usage request failed (401)");
  assert.equal(snap.fiveHour.pct, 41);
});

test("missing or malformed tokens never reach fetch", async () => {
  for (const token of [null, "", "bad token with spaces", "line\nbreak", 42]) {
    const env = makeEnv({ token });
    const snap = await createLimits(env.deps).sync(true);
    assert.equal(env.counts.fetch, 0);
    assert.ok(snap.error);
  }
});

test("token reader on darwin uses the keychain and returns the access token", async () => {
  const calls = [];
  const read = createTokenReader({
    platform: "darwin",
    run: async (bin, args) => {
      calls.push([bin, args]);
      return { code: 0, stdout: JSON.stringify({ claudeAiOauth: { accessToken: SECRET } }), stderr: "" };
    },
    readFile: async () => {
      throw new Error("must not read file");
    },
    getConfigDir: () => "/cfg",
    userName: () => "me",
  });
  assert.deepEqual(await read(), { accessToken: SECRET, expiresAt: null });
  assert.deepEqual(calls, [["security", ["find-generic-password", "-s", "Claude Code-credentials", "-a", "me", "-w"]]]);
});

test("token reader falls back to the unscoped item when the account item has no login", async () => {
  const calls = [];
  const read = createTokenReader({
    platform: "darwin",
    run: async (bin, args) => {
      calls.push(args);
      if (args.includes("-a")) return { code: 0, stdout: JSON.stringify({ mcpOAuth: { x: { accessToken: "mcp" } } }), stderr: "" };
      return { code: 0, stdout: JSON.stringify({ claudeAiOauth: { accessToken: SECRET } }), stderr: "" };
    },
    readFile: async () => "",
    getConfigDir: () => "/cfg",
    userName: () => "me",
  });
  assert.deepEqual(await read(), { accessToken: SECRET, expiresAt: null });
  assert.deepEqual(calls, [
    ["find-generic-password", "-s", "Claude Code-credentials", "-a", "me", "-w"],
    ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
  ]);
});

test("token reader skips the account lookup when the user name is unknown", async () => {
  const calls = [];
  const read = createTokenReader({
    platform: "darwin",
    run: async (bin, args) => {
      calls.push(args);
      return { code: 0, stdout: JSON.stringify({ claudeAiOauth: { accessToken: SECRET } }), stderr: "" };
    },
    readFile: async () => "",
    getConfigDir: () => "/cfg",
    userName: () => null,
  });
  assert.deepEqual(await read(), { accessToken: SECRET, expiresAt: null });
  assert.deepEqual(calls, [["find-generic-password", "-s", "Claude Code-credentials", "-w"]]);
});

test("token reader returns null on keychain failure or bad json", async () => {
  const make = (result) => createTokenReader({ platform: "darwin", run: async () => result, readFile: async () => "", getConfigDir: () => "/cfg" });
  assert.equal(await make({ code: 44, stdout: "", stderr: "not found" })(), null);
  assert.equal(await make({ code: 0, stdout: "garbage", stderr: "" })(), null);
  assert.equal(await make({ code: 0, stdout: "{}", stderr: "" })(), null);
});

test("token reader elsewhere reads .credentials.json from the config dir", async () => {
  let readPath;
  const read = createTokenReader({
    platform: "linux",
    run: async () => {
      throw new Error("must not run");
    },
    readFile: async (file) => {
      readPath = file;
      return JSON.stringify({ claudeAiOauth: { accessToken: SECRET } });
    },
    getConfigDir: () => "/cfg",
  });
  assert.deepEqual(await read(), { accessToken: SECRET, expiresAt: null });
  assert.equal(readPath, path.join("/cfg", ".credentials.json"));
});

test("token reader returns null when the file is missing", async () => {
  const read = createTokenReader({
    platform: "linux",
    run: async () => ({ code: 0, stdout: "", stderr: "" }),
    readFile: async () => {
      throw Object.assign(new Error("nope"), { code: "ENOENT" });
    },
    getConfigDir: () => "/cfg",
  });
  assert.equal(await read(), null);
});

test("token reader passes expiresAt through", async () => {
  const read = createTokenReader({
    platform: "linux",
    run: async () => ({ code: 0, stdout: "", stderr: "" }),
    readFile: async () => JSON.stringify({ claudeAiOauth: { accessToken: SECRET, expiresAt: 123 } }),
    getConfigDir: () => "/cfg",
  });
  assert.deepEqual(await read(), { accessToken: SECRET, expiresAt: 123 });
});

test("401 and missing credentials back off for 10 minutes", async () => {
  const denied = makeEnv({ response: { ok: false, status: 401, json: async () => ({}) } });
  const a = createLimits(denied.deps);
  const snap = await a.sync(false);
  assert.equal(snap.hint, "Open Claude Code to refresh your sign-in");
  assert.equal(typeof snap.backoffUntil, "string");
  denied.nowRef.t += 5 * 60_000;
  await a.sync(false);
  assert.equal(denied.counts.fetch, 1);
  denied.nowRef.t += 5 * 60_000 + 1000;
  await a.sync(false);
  assert.equal(denied.counts.fetch, 2);

  const missing = makeEnv({ token: null });
  const b = createLimits(missing.deps);
  await b.sync(false);
  missing.nowRef.t += 3 * 60_000;
  await b.sync(true);
  assert.equal(missing.counts.token, 1);
  missing.nowRef.t += 8 * 60_000;
  await b.sync(false);
  assert.equal(missing.counts.token, 2);
});

test("backoffUntil is persisted and honoured after restart", async () => {
  const env = makeEnv({ response: { ok: false, status: 429, json: async () => ({}) } });
  await createLimits(env.deps).sync(false);
  assert.ok(env.store.get("claude-limits.json").backoffUntil > NOW);
  const again = createLimits(env.deps);
  await again.sync(true);
  assert.equal(env.counts.fetch, 1);
  assert.equal(again.snapshot().backoffUntil, new Date(NOW + 10 * 60_000).toISOString());
  assert.equal(again.snapshot().error, "usage request failed (429)");
});

test("the failure reason survives a restart during backoff", async () => {
  const env = makeEnv({ token: null });
  await createLimits(env.deps).sync(false);
  const again = createLimits(env.deps).snapshot();
  assert.equal(again.error, "no Claude credentials found");
  assert.equal(again.hint, "Open Claude Code to refresh your sign-in");
});

test("an expired token skips the fetch and sets the sign-in hint", async () => {
  const env = makeEnv({ token: { accessToken: SECRET, expiresAt: NOW - 1000 } });
  const snap = await createLimits(env.deps).sync(true);
  assert.equal(env.counts.fetch, 0);
  assert.equal(snap.hint, "Open Claude Code to refresh your sign-in");
  assert.ok(snap.error);
  const fresh = makeEnv({ token: { accessToken: SECRET, expiresAt: NOW + 60_000 } });
  await createLimits(fresh.deps).sync(true);
  assert.equal(fresh.counts.fetch, 1);
});

test("a throwing readJson does not break creation, snapshot or sync", async () => {
  const env = makeEnv({ response: new Error("net") });
  const limits = createLimits({ ...env.deps, readJson: () => { throw new Error("corrupt"); } });
  assert.deepEqual(limits.snapshot().fiveHour, null);
  assert.ok(limits.snapshot().error);
  const snap = await limits.sync(true);
  assert.ok(snap.error);
});

test("a throwing enabled getter is treated as disabled", async () => {
  const env = makeEnv();
  const limits = createLimits({ ...env.deps, enabled: () => { throw new Error("x"); } });
  assert.deepEqual(await limits.sync(true), { enabled: false });
});
