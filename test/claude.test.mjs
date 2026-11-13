import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { costOf, parseLines, splitComplete, resolveConfigDir, createClaude } from "../src/sources/claude.mjs";

const OPT = { now: Date.UTC(2026, 10, 10, 12) };
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} vs ${b}`);

test("costOf prices input, output, cache read and 5m/1h writes", () => {
  const usage = { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 2000, cache_creation: { ephemeral_5m_input_tokens: 400, ephemeral_1h_input_tokens: 100 } };
  close(costOf(usage, "claude-sonnet-4-6", undefined), (1000 * 3 + 500 * 15 + 400 * 3.75 + 100 * 6 + 2000 * 0.3) / 1e6);
});

test("costOf treats legacy cache_creation_input_tokens as 5m writes", () => {
  close(costOf({ cache_creation_input_tokens: 1000 }, "claude-haiku-4-5-20251001"), (1000 * 1 * 1.25) / 1e6);
});

test("costOf doubles fast speed", () => {
  const usage = { input_tokens: 1000, output_tokens: 1000 };
  close(costOf(usage, "claude-opus-4-8", "fast"), 2 * costOf(usage, "claude-opus-4-8", "standard"));
});

test("costOf is zero for unknown models and tolerates junk", () => {
  assert.equal(costOf({ input_tokens: 1000 }, "gpt-9"), 0);
  assert.equal(costOf({ input_tokens: 1000 }, undefined), 0);
  assert.equal(costOf({ input_tokens: "x", output_tokens: null }, "claude-haiku-4-5"), 0);
});

test("costOf picks the most specific model prefix", () => {
  assert.notEqual(costOf({ cache_read_input_tokens: 1e6 }, "claude-fable-5-1"), costOf({ cache_read_input_tokens: 1e6 }, "claude-fable-5"));
  close(costOf({ cache_read_input_tokens: 1e6 }, "claude-fable-5-1-x"), 0.25);
});

const line = (id, req, usage, ts = "2026-11-10T10:00:00.000Z", extra = {}) =>
  JSON.stringify({ type: "assistant", timestamp: ts, requestId: req, message: { id, model: "claude-sonnet-4-6", usage, ...extra } });

test("parseLines sums cost per day", () => {
  const text = [line("m1", "r1", { input_tokens: 1e6 }), line("m2", "r2", { input_tokens: 1e6 }, "2026-11-11T10:00:00.000Z")].join("\n") + "\n";
  const { byDay } = parseLines(text, new Map(), OPT);
  assert.equal(Object.keys(byDay).length, 2);
  close(Object.values(byDay).reduce((a, b) => a + b, 0), 6);
  for (const cost of Object.values(byDay)) close(cost, 3);
});

test("parseLines dedupes on message id and request id", () => {
  const seen = new Map();
  const a = line("m1", "r1", { input_tokens: 1e6 });
  const first = parseLines(`${a}\n${a}\n`, seen, OPT);
  close(Object.values(first.byDay)[0], 3);
  const again = parseLines(`${a}\n`, seen, OPT);
  assert.deepEqual(again.byDay, {});
  const other = parseLines(`${line("m1", "r2", { input_tokens: 1e6 })}\n`, seen, OPT);
  close(Object.values(other.byDay)[0], 3);
});

test("parseLines counts only the growth of a streamed message", () => {
  const seen = new Map();
  const small = parseLines(`${line("m1", "r1", { output_tokens: 100 })}\n`, seen, OPT);
  const grown = parseLines(`${line("m1", "r1", { output_tokens: 300 })}\n`, seen, OPT);
  close(Object.values(small.byDay)[0] + Object.values(grown.byDay)[0], (300 * 15) / 1e6);
});

test("parseLines ignores malformed, irrelevant and incomplete records", () => {
  const text = [
    "{not json",
    "",
    JSON.stringify({ type: "user", timestamp: "2026-11-10T10:00:00Z", message: { id: "a", usage: { input_tokens: 5 } } }),
    JSON.stringify({ type: "assistant", message: { id: "a", usage: { input_tokens: 5 } } }),
    JSON.stringify({ type: "assistant", timestamp: "garbage", message: { id: "a", model: "claude-sonnet-4-6", usage: { input_tokens: 5 } } }),
    JSON.stringify({ type: "assistant", timestamp: "2026-11-10T10:00:00Z", message: { model: "claude-sonnet-4-6", usage: { input_tokens: 5 } } }),
    "null",
    "42",
    "[]",
  ].join("\n");
  assert.deepEqual(parseLines(text, new Map(), OPT).byDay, {});
});

test("parseLines reads speed from usage", () => {
  const slow = parseLines(`${line("a", "r", { input_tokens: 1e6 })}\n`, new Map(), OPT);
  const fast = parseLines(`${line("b", "r", { input_tokens: 1e6, speed: "fast" })}\n`, new Map(), OPT);
  close(Object.values(fast.byDay)[0], 2 * Object.values(slow.byDay)[0]);
});

test("parseLines skips lines over 2 MB", () => {
  const huge = line("h", "r", { input_tokens: 1 }, undefined, { pad: "x".repeat(2 * 1024 * 1024 + 10) });
  assert.deepEqual(parseLines(`${huge}\n`, new Map(), OPT).byDay, {});
});

test("parseLines survives __proto__ style keys", () => {
  const seen = new Map();
  parseLines(`${line("__proto__", "__proto__", { input_tokens: 1 })}\n`, seen, OPT);
  assert.equal(({}).input_tokens, undefined);
});

test("splitComplete keeps the partial trailing line", () => {
  const out = splitComplete(Buffer.from("a\nb\nc"));
  assert.equal(out.text, "a\nb\n");
  assert.equal(out.consumed, 4);
  assert.deepEqual(splitComplete(Buffer.from("abc")), { text: "", consumed: 0 });
  assert.deepEqual(splitComplete(Buffer.from("abc\n")), { text: "abc\n", consumed: 4 });
  assert.deepEqual(splitComplete(Buffer.alloc(0)), { text: "", consumed: 0 });
});

test("resolveConfigDir prefers the setting, then env, then ~/.claude", () => {
  const home = "/home/u";
  assert.equal(resolveConfigDir("/s/dir", { CLAUDE_CONFIG_DIR: "/e/dir" }, home), "/s/dir");
  assert.equal(resolveConfigDir("", { CLAUDE_CONFIG_DIR: "/e/dir" }, home), "/e/dir");
  assert.equal(resolveConfigDir("relative/dir", { CLAUDE_CONFIG_DIR: "/e/dir" }, home), "/e/dir");
  assert.equal(resolveConfigDir("  ", { CLAUDE_CONFIG_DIR: "rel" }, home), path.join(home, ".claude"));
  assert.equal(resolveConfigDir(undefined, {}, home), path.join(home, ".claude"));
  assert.equal(resolveConfigDir(5, {}, home), path.join(home, ".claude"));
});

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orca-pulse-claude-"));
  const projects = path.join(dir, "projects", "proj");
  fs.mkdirSync(projects, { recursive: true });
  const store = new Map();
  const nowRef = { t: Date.UTC(2026, 10, 10, 12) };
  const deps = {
    getConfigDir: () => dir,
    readJson: (name, fallback) => (store.has(name) ? structuredClone(store.get(name)) : fallback),
    writeJson: (name, value) => store.set(name, structuredClone(value)),
    now: () => nowRef.t,
  };
  return { dir, projects, store, nowRef, deps, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const total = (snap) => Object.values(snap.days).reduce((sum, [cost]) => sum + cost, 0);

test("integration: incremental scan reads only appended bytes", async (t) => {
  const env = setup();
  t.after(env.cleanup);
  const file = path.join(env.projects, "s.jsonl");
  fs.writeFileSync(file, `${line("m1", "r1", { input_tokens: 1e6 })}\n`);
  const claude = createClaude(env.deps);
  await claude.sync(false);
  close(total(claude.snapshot()), 3);
  const offset = env.store.get("claude-scan.json").files[file].o;
  assert.equal(offset, fs.statSync(file).size);

  fs.appendFileSync(file, `${line("m2", "r2", { input_tokens: 1e6 })}\n`);
  env.nowRef.t += 31_000;
  await claude.sync(false);
  close(total(claude.snapshot()), 6);

  env.nowRef.t += 31_000;
  await claude.sync(false);
  close(total(claude.snapshot()), 6);
});

test("integration: partial trailing line is kept for the next scan", async (t) => {
  const env = setup();
  t.after(env.cleanup);
  const file = path.join(env.projects, "s.jsonl");
  const full = line("m1", "r1", { input_tokens: 1e6 });
  fs.writeFileSync(file, full.slice(0, 30));
  const claude = createClaude(env.deps);
  await claude.sync(true);
  assert.equal(total(claude.snapshot()), 0);
  assert.equal(env.store.get("claude-scan.json").files[file].o, 0);
  fs.appendFileSync(file, `${full.slice(30)}\n`);
  await claude.sync(true);
  close(total(claude.snapshot()), 3);
});

test("integration: a shrunk file is rescanned from zero without double counting", async (t) => {
  const env = setup();
  t.after(env.cleanup);
  const file = path.join(env.projects, "s.jsonl");
  fs.writeFileSync(file, `${line("m1", "r1", { input_tokens: 1e6 })}\n${line("m2", "r2", { input_tokens: 1e6 })}\n`);
  const claude = createClaude(env.deps);
  await claude.sync(true);
  close(total(claude.snapshot()), 6);
  fs.writeFileSync(file, `${line("m1", "r1", { input_tokens: 1e6 })}\n`);
  await claude.sync(true);
  close(total(claude.snapshot()), 6);
  assert.equal(env.store.get("claude-scan.json").files[file].o, fs.statSync(file).size);
});

test("integration: honours the 30 second interval unless forced", async (t) => {
  const env = setup();
  t.after(env.cleanup);
  const file = path.join(env.projects, "s.jsonl");
  fs.writeFileSync(file, `${line("m1", "r1", { input_tokens: 1e6 })}\n`);
  const claude = createClaude(env.deps);
  await claude.sync(false);
  fs.appendFileSync(file, `${line("m2", "r2", { input_tokens: 1e6 })}\n`);
  env.nowRef.t += 10_000;
  await claude.sync(false);
  close(total(claude.snapshot()), 3);
  await claude.sync(true);
  close(total(claude.snapshot()), 6);
});

test("integration: symlinked files and directories are skipped", { skip: process.platform === "win32" }, async (t) => {
  const env = setup();
  t.after(env.cleanup);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "orca-pulse-outside-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, "x.jsonl"), `${line("o1", "r", { input_tokens: 1e6 })}\n`);
  fs.symlinkSync(path.join(outside, "x.jsonl"), path.join(env.projects, "link.jsonl"));
  fs.symlinkSync(outside, path.join(env.projects, "linkdir"));
  const claude = createClaude(env.deps);
  await claude.sync(true);
  assert.equal(total(claude.snapshot()), 0);
  assert.equal(claude.snapshot().error, null);
});

test("integration: file count and depth caps apply", async (t) => {
  const env = setup();
  t.after(env.cleanup);
  for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(env.projects, `f${i}.jsonl`), `${line(`m${i}`, "r", { input_tokens: 1e6 })}\n`);
  const deep = path.join(env.projects, "a", "b", "c");
  fs.mkdirSync(deep, { recursive: true });
  fs.writeFileSync(path.join(deep, "deep.jsonl"), `${line("deep", "r", { input_tokens: 1e6 })}\n`);
  const capped = createClaude({ ...env.deps, maxFiles: 2, maxDepth: 6 });
  await capped.sync(true);
  close(total(capped.snapshot()), 6);
  const shallow = createClaude({ ...env.deps, readJson: (n, f) => f, writeJson() {}, maxFiles: 100, maxDepth: 2 });
  await shallow.sync(true);
  close(total(shallow.snapshot()), 15);
});

test("integration: history keeps daily maxima and missing directory is not an error", async (t) => {
  const env = setup();
  t.after(env.cleanup);
  env.store.set("claude-history.json", { days: { "2020-01-01": 12 } });
  const claude = createClaude({ ...env.deps, getConfigDir: () => path.join(env.dir, "nope") });
  await claude.sync(true);
  const snap = claude.snapshot();
  assert.equal(snap.days["2020-01-01"][0], 12);
  assert.equal(snap.days["2020-01-01"][1], 1);
  assert.equal(snap.error, null);
  assert.deepEqual(JSON.parse(JSON.stringify(snap)), snap);
});

test("integration: an oversized line is skipped and scanning continues after it", async (t) => {
  const env = setup();
  t.after(env.cleanup);
  const file = path.join(env.projects, "s.jsonl");
  const huge = line("h", "r", { input_tokens: 1e6 }, undefined, { pad: "x".repeat(3 * 1024 * 1024) });
  fs.writeFileSync(file, `${huge}\n${line("m1", "r1", { input_tokens: 1e6 })}\n`);
  const claude = createClaude(env.deps);
  await claude.sync(true);
  close(total(claude.snapshot()), 3);
});

test("parseLines requires string ids and bounded key lengths", () => {
  const mk = (id, requestId) => `${JSON.stringify({ type: "assistant", timestamp: "2026-11-10T10:00:00Z", requestId, message: { id, model: "claude-sonnet-4-6", usage: { input_tokens: 1e6 } } })}\n`;
  const sum = (text) => Object.values(parseLines(text, new Map(), OPT).byDay).reduce((a, b) => a + b, 0);
  assert.equal(sum(mk(5, "r")), 0);
  assert.equal(sum(mk("m", 7)), 0);
  assert.equal(sum(mk("m".repeat(201), "r")), 0);
  assert.equal(sum(mk("m", "r".repeat(201))), 0);
  close(sum(mk("m", undefined)), 3);
  close(sum(mk("m".repeat(200), "r".repeat(200))), 3);
});

test("parseLines evicts the oldest seen entries past the cap", () => {
  const seen = new Map();
  const text = ["a", "b", "c"].map((id) => `${line(id, "r", { input_tokens: 1 })}\n`).join("");
  parseLines(text, seen, { ...OPT, maxSeen: 2 });
  assert.equal(seen.size, 2);
  assert.equal(seen.has("a:r"), false);
  assert.equal(seen.has("c:r"), true);
});

test("parseLines rejects timestamps before 2000 or beyond now plus a day", () => {
  const at = (ts) => Object.keys(parseLines(`${line("m", "r", { input_tokens: 1e6 }, ts)}\n`, new Map(), OPT).byDay).length;
  assert.equal(at("1999-12-31T23:00:00Z"), 0);
  assert.equal(at("2026-11-12T13:00:00Z"), 0);
  assert.equal(at("2026-11-11T00:00:00Z"), 1);
  assert.equal(at("2000-01-02T00:00:00Z"), 1);
});

test("costOf clamps token counts", () => {
  close(costOf({ input_tokens: 1e15 }, "claude-sonnet-4-6"), 30000);
  assert.equal(costOf({ input_tokens: Infinity, output_tokens: -5 }, "claude-sonnet-4-6"), 0);
});

test("parseLines measures the line limit in bytes", () => {
  const pad = "\u00e9".repeat(1.2 * 1024 * 1024);
  const text = `${line("h", "r", { input_tokens: 1e6 }, undefined, { pad })}\n`;
  assert.ok(text.length < 2 * 1024 * 1024);
  assert.deepEqual(parseLines(text, new Map(), OPT).byDay, {});
});

test("integration: files are chosen in name order under maxFiles and maxPerDir", async (t) => {
  const env = setup();
  t.after(env.cleanup);
  for (const [name, tokens] of [["c", 4e6], ["a", 1e6], ["b", 2e6]]) fs.writeFileSync(path.join(env.projects, `${name}.jsonl`), `${line(name, "r", { input_tokens: tokens })}\n`);
  const two = createClaude({ ...env.deps, maxFiles: 2 });
  await two.sync(true);
  close(total(two.snapshot()), 9);
  const one = createClaude({ ...env.deps, readJson: (n, f) => f, writeJson() {}, maxPerDir: 1 });
  await one.sync(true);
  close(total(one.snapshot()), 3);
});

test("integration: increments are kept when a later read fails", async (t) => {
  const env = setup();
  t.after(env.cleanup);
  const file = path.join(env.projects, "s.jsonl");
  fs.writeFileSync(file, "x\n");
  const data = Buffer.from(`${line("m1", "r1", { input_tokens: 1e6 })}\n`);
  let reads = 0;
  const openFile = async () => ({
    stat: async () => ({ isFile: () => true, size: data.length + 10 }),
    read: async (buffer, offset, length) => {
      reads++;
      if (reads > 1) throw new Error("io");
      return { bytesRead: data.copy(buffer, offset, 0, Math.min(length, data.length)) };
    },
    close: async () => {},
  });
  const claude = createClaude({ ...env.deps, openFile });
  await claude.sync(true);
  close(total(claude.snapshot()), 3);
  assert.ok(env.store.has("claude-history.json"));
});

test("integration: a failed history write is retried on the next sync", async (t) => {
  const env = setup();
  t.after(env.cleanup);
  fs.writeFileSync(path.join(env.projects, "s.jsonl"), `${line("m1", "r1", { input_tokens: 1e6 })}\n`);
  let failing = true;
  const claude = createClaude({
    ...env.deps,
    writeJson: (name, value) => {
      if (name === "claude-history.json" && failing) throw new Error("disk full");
      env.deps.writeJson(name, value);
    },
  });
  await claude.sync(true);
  assert.ok(claude.snapshot().error);
  assert.equal(env.store.has("claude-history.json"), false);
  failing = false;
  await claude.sync(true);
  assert.ok(env.store.has("claude-history.json"));
  assert.equal(claude.snapshot().error, null);
});

test("a throwing readJson does not break creation or sync", async (t) => {
  const env = setup();
  t.after(env.cleanup);
  const claude = createClaude({ ...env.deps, readJson: () => { throw new Error("corrupt"); } });
  assert.ok(claude.snapshot().error);
  await claude.sync(true);
  assert.ok(claude.snapshot());
});
