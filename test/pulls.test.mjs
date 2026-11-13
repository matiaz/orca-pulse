import test from "node:test";
import assert from "node:assert/strict";
import { actionOf, rankPulls, diffNotable, createPulls } from "../src/sources/pulls.mjs";

const base = {
  number: 1,
  title: "t",
  url: "https://github.com/o/r/pull/1",
  isDraft: false,
  updatedAt: "2026-11-10T10:00:00Z",
  reviewDecision: null,
  mergeable: "MERGEABLE",
  mergeStateStatus: "BLOCKED",
  author: { login: "me" },
  repository: { nameWithOwner: "o/r" },
  commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
};
const withChecks = (state, extra = {}) => ({ ...base, ...extra, commits: { nodes: [{ commit: { statusCheckRollup: { state } } }] } });

test("actionOf covers every action", () => {
  assert.equal(actionOf({ ...base, reviewRequested: true, author: { login: "bob" } }, "me"), "review");
  assert.equal(actionOf({ ...base, reviewRequested: true }, "me"), "waiting");
  assert.equal(actionOf({ ...base, isDraft: true }, "me"), "draft");
  assert.equal(actionOf({ ...base, mergeable: "CONFLICTING" }, "me"), "conflict");
  assert.equal(actionOf(withChecks("FAILURE"), "me"), "ci failed");
  assert.equal(actionOf(withChecks("ERROR"), "me"), "ci failed");
  assert.equal(actionOf({ ...base, reviewDecision: "CHANGES_REQUESTED" }, "me"), "changes");
  assert.equal(actionOf(withChecks("PENDING"), "me"), "ci running");
  assert.equal(actionOf(withChecks("EXPECTED"), "me"), "ci running");
  assert.equal(actionOf({ ...base, mergeStateStatus: "BEHIND" }, "me"), "update");
  assert.equal(actionOf({ ...base, mergeStateStatus: "CLEAN" }, "me"), "merge");
  assert.equal(actionOf({ ...base, mergeStateStatus: "UNSTABLE" }, "me"), "merge");
  assert.equal(actionOf(base, "me"), "waiting");
});

test("actionOf tolerates missing commit data", () => {
  assert.equal(actionOf({ ...base, commits: { nodes: [] } }, "me"), "waiting");
  assert.equal(actionOf({ ...base, commits: null }, "me"), "waiting");
});

const item = (url, action, updatedAt) => ({ url, action, updatedAt });

test("rankPulls orders by priority then updatedAt desc", () => {
  const order = ["merge", "ci failed", "conflict", "changes", "update", "review", "ci running", "waiting", "draft"];
  const shuffled = [...order].reverse().map((action, i) => item(`u${i}-${action}`, action, "2026-01-01T00:00:00Z"));
  assert.deepEqual(rankPulls(shuffled).map((p) => p.action), order);
  const ties = rankPulls([item("a", "merge", "2026-01-01T00:00:00Z"), item("b", "merge", "2026-03-01T00:00:00Z"), item("c", "merge", "2026-02-01T00:00:00Z")]);
  assert.deepEqual(ties.map((p) => p.url), ["b", "c", "a"]);
});

test("rankPulls does not mutate and tolerates unknown actions last", () => {
  const input = [item("x", "weird", "2026-01-01T00:00:00Z"), item("y", "draft", "2026-01-01T00:00:00Z")];
  const out = rankPulls(input);
  assert.equal(input[0].url, "x");
  assert.deepEqual(out.map((p) => p.url), ["y", "x"]);
});

test("diffNotable is empty when prev is null", () => {
  assert.deepEqual(diffNotable(null, [item("a", "merge", "")]), []);
});

test("diffNotable reports only new transitions into merge or ci failed", () => {
  const prev = [item("a", "waiting", ""), item("b", "merge", ""), item("c", "ci failed", ""), item("d", "waiting", "")];
  const next = [item("a", "merge", ""), item("b", "merge", ""), item("c", "ci failed", ""), item("d", "review", ""), item("e", "ci failed", ""), item("f", "draft", "")];
  assert.deepEqual(diffNotable(prev, next).map((p) => p.url), ["a", "e"]);
  assert.deepEqual(diffNotable([item("a", "merge", "")], [item("a", "ci failed", "")]).map((p) => p.url), ["a"]);
});

function fixture() {
  const mine = withChecks("SUCCESS", { mergeStateStatus: "CLEAN" });
  const assigned = { ...base, number: 2, url: "https://github.com/o/r/pull/2", title: "evil\u202e\x1b[31m title", author: { login: "bob" }, isDraft: true };
  const review = { ...base, number: 3, url: "https://github.com/o/r/pull/3", author: { login: "bob" } };
  const bad = { ...base, number: 4, url: "https://evil.example.com/o/r/pull/4" };
  const badScheme = { ...base, number: 5, url: "javascript:alert(1)" };
  return {
    viewer: { login: "me" },
    authored: { nodes: [mine, bad, badScheme, null] },
    assigned: { nodes: [assigned, review] },
    review: { nodes: [review] },
  };
}

function makeEnv(data, nowRef = { t: 1_000_000 }) {
  const store = new Map();
  const calls = [];
  const gh = async (args) => {
    calls.push(args);
    return typeof data === "function" ? data() : { code: 0, stdout: JSON.stringify({ data }), stderr: "" };
  };
  return {
    store,
    calls,
    nowRef,
    deps: {
      gh,
      readJson: (name, fallback) => (store.has(name) ? structuredClone(store.get(name)) : fallback),
      writeJson: (name, value) => store.set(name, structuredClone(value)),
      now: () => nowRef.t,
    },
  };
}

test("sync merges the searches by url, cleans strings and drops bad urls", async () => {
  const env = makeEnv(fixture());
  const pulls = createPulls(env.deps);
  await pulls.sync(false);
  const snap = pulls.snapshot();
  assert.equal(snap.error, null);
  assert.equal(snap.hint, null);
  assert.deepEqual(snap.items.map((p) => p.url), [
    "https://github.com/o/r/pull/1",
    "https://github.com/o/r/pull/3",
    "https://github.com/o/r/pull/2",
  ]);
  const [one, three, two] = snap.items;
  assert.deepEqual(one, {
    listed: true,
    url: "https://github.com/o/r/pull/1",
    repo: "o/r",
    number: 1,
    title: "t",
    action: "merge",
    isDraft: false,
    author: "me",
    updatedAt: "2026-11-10T10:00:00Z",
    mine: true,
    requested: false,
    headRefOid: null,
    reviewDecision: null,
    mergeStateStatus: "CLEAN",
    checks: "SUCCESS",
    viewerReview: null,
  });
  assert.equal(three.action, "review");
  assert.equal(three.mine, false);
  assert.equal(two.title, "evil title");
  assert.equal(two.action, "draft");
  assert.equal(typeof snap.updatedAt, "string");
  assert.deepEqual(JSON.parse(JSON.stringify(snap)), snap);
  assert.deepEqual(env.calls[0].slice(0, 3), ["api", "graphql", "-f"]);
  assert.match(env.calls[0][3], /^query=/);
  assert.match(env.calls[0][3], /author:@me/);
  assert.match(env.calls[0][3], /assignee:@me/);
  assert.match(env.calls[0][3], /review-requested:@me/);
  assert.ok(env.store.has("pulls.json"));
});

test("first sync is silent, later sync reports transitions", async () => {
  const data = fixture();
  const env = makeEnv(() => ({ code: 0, stdout: JSON.stringify({ data }), stderr: "" }));
  const pulls = createPulls(env.deps);
  assert.deepEqual((await pulls.sync(false)).notable, []);
  data.assigned.nodes[0].isDraft = false;
  data.assigned.nodes[0].mergeStateStatus = "CLEAN";
  env.nowRef.t += 3 * 60 * 1000;
  const result = await pulls.sync(false);
  assert.deepEqual(result.notable.map((p) => p.url), ["https://github.com/o/r/pull/2"]);
});

test("sync respects the 2 minute interval unless forced", async () => {
  const env = makeEnv(fixture());
  const pulls = createPulls(env.deps);
  await pulls.sync(false);
  env.nowRef.t += 60 * 1000;
  await pulls.sync(false);
  assert.equal(env.calls.length, 1);
  await pulls.sync(true);
  assert.equal(env.calls.length, 2);
  env.nowRef.t += 2 * 60 * 1000;
  await pulls.sync(false);
  assert.equal(env.calls.length, 3);
});

test("cache is loaded at creation", () => {
  const env = makeEnv(fixture());
  env.store.set("pulls.json", { items: [{ url: "https://github.com/o/r/pull/9", repo: "o/r", number: 9, title: "cached", action: "waiting", isDraft: false, author: "me", updatedAt: "x", mine: true }], fetchedAt: 999_000 });
  const pulls = createPulls(env.deps);
  assert.equal(pulls.snapshot().items[0].title, "cached");
});

test("missing gh yields the install hint and keeps data", async () => {
  const env = makeEnv(fixture());
  const pulls = createPulls(env.deps);
  await pulls.sync(false);
  const good = pulls.snapshot().items;
  const failing = makeEnv(() => {
    throw Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" });
  });
  const second = createPulls({ ...env.deps, gh: failing.deps.gh });
  const result = await second.sync(true);
  assert.deepEqual(result.notable, []);
  const snap = second.snapshot();
  assert.equal(snap.hint, "Install the GitHub CLI (gh) and run gh auth login");
  assert.deepEqual(snap.items, good);
});

test("auth failure yields the login hint and never throws", async () => {
  const env = makeEnv(() => ({ code: 4, stdout: "", stderr: "To get started with GitHub CLI, please run:  gh auth login" }));
  const pulls = createPulls(env.deps);
  await pulls.sync(false);
  const snap = pulls.snapshot();
  assert.equal(snap.hint, "Run gh auth login");
  assert.ok(snap.error);
  assert.deepEqual(snap.items, []);
});

test("a later success clears error and hint", async () => {
  let fail = true;
  const data = fixture();
  const env = makeEnv(() => (fail ? { code: 1, stdout: "", stderr: "boom" } : { code: 0, stdout: JSON.stringify({ data }), stderr: "" }));
  const pulls = createPulls(env.deps);
  await pulls.sync(false);
  assert.ok(pulls.snapshot().error);
  fail = false;
  await pulls.sync(true);
  assert.equal(pulls.snapshot().error, null);
  assert.equal(pulls.snapshot().items.length, 3);
});

test("cached items are re-sanitized on load", () => {
  const env = makeEnv(fixture());
  env.store.set("pulls.json", { items: [{ url: "https://evil.example/x", number: 1 }, { url: "https://github.com/o/r/pull/9", repo: "o/r", number: 9, title: "a\u202eb", action: "bogus", author: "me", updatedAt: "x", mine: true }], fetchedAt: 1 });
  const items = createPulls(env.deps).snapshot().items;
  assert.equal(items.length, 1);
  assert.equal(items[0].title, "ab");
  assert.equal(items[0].action, "waiting");
});

test("a throwing readJson does not break creation or sync", async () => {
  const env = makeEnv(fixture());
  const pulls = createPulls({ ...env.deps, readJson: () => { throw new Error("corrupt"); } });
  assert.ok(pulls.snapshot().error);
  assert.deepEqual(pulls.snapshot().items, []);
  const result = await pulls.sync(true);
  assert.deepEqual(result.notable, []);
  assert.equal(pulls.snapshot().items.length, 3);
});

const HEAD = "a".repeat(40);
const OLD = "b".repeat(40);

test("normalized items carry requested, head, review and checks fields", async () => {
  const data = fixture();
  data.review.nodes[0] = { ...data.review.nodes[0], headRefOid: HEAD, reviewDecision: "APPROVED", mergeStateStatus: "CLEAN", viewerLatestReview: { state: "APPROVED", commit: { oid: OLD } } };
  data.assigned.nodes[1] = data.review.nodes[0];
  const env = makeEnv(data);
  const pulls = createPulls(env.deps);
  await pulls.sync(false);
  const three = pulls.snapshot().items.find((item) => item.number === 3);
  assert.equal(three.requested, true);
  assert.equal(three.headRefOid, HEAD);
  assert.equal(three.reviewDecision, "APPROVED");
  assert.equal(three.mergeStateStatus, "CLEAN");
  assert.equal(three.checks, null);
  assert.deepEqual(three.viewerReview, { state: "APPROVED", oid: OLD });
  assert.equal(pulls.snapshot().items.find((item) => item.number === 2).requested, false);
});

test("the query asks for headRefOid and viewerLatestReview", async () => {
  const env = makeEnv(fixture());
  await createPulls(env.deps).sync(false);
  assert.match(env.calls[0][3], /headRefOid/);
  assert.match(env.calls[0][3], /viewerLatestReview \{ state commit \{ oid \} \}/);
});

test("cached merge fields are re-validated on load", () => {
  const env = makeEnv(fixture());
  const good = { listed: true, url: "https://github.com/o/r/pull/9", repo: "o/r", number: 9, title: "x", action: "waiting", isDraft: false, author: "bob", updatedAt: "x", mine: false, requested: true, headRefOid: HEAD, reviewDecision: "APPROVED", mergeStateStatus: "CLEAN", checks: "SUCCESS", viewerReview: { state: "APPROVED", oid: HEAD } };
  const bad = { ...good, url: "https://github.com/o/r/pull/10", number: 10, requested: "yes", headRefOid: "zz", reviewDecision: "approved; rm", mergeStateStatus: 5, checks: {}, viewerReview: { state: "APPROVED", oid: "nope" } };
  env.store.set("pulls.json", { items: [good, bad], fetchedAt: 1 });
  const [first, second] = createPulls(env.deps).snapshot().items;
  assert.deepEqual(first, good);
  assert.equal(second.requested, false);
  assert.equal(second.headRefOid, null);
  assert.equal(second.reviewDecision, null);
  assert.equal(second.mergeStateStatus, null);
  assert.equal(second.checks, null);
  assert.deepEqual(second.viewerReview, { state: "APPROVED", oid: null });
});

test("PRs found only by reviewed-by are kept but not listed", async () => {
  const data = fixture();
  const approved = { ...base, number: 8, url: "https://github.com/o/r/pull/8", author: { login: "bob" } };
  data.reviewed = { nodes: [approved, data.review.nodes[0]] };
  const env = makeEnv(data);
  const pulls = createPulls(env.deps);
  await pulls.sync(false);
  assert.match(env.calls[0][3], /reviewed-by:@me/);
  const items = pulls.snapshot().items;
  assert.equal(items.find((item) => item.number === 8).listed, false);
  assert.equal(items.find((item) => item.number === 3).listed, true);
  assert.equal(items.find((item) => item.number === 1).listed, true);
});

test("a review without a commit still counts as reviewed", async () => {
  const data = fixture();
  data.review.nodes[0] = { ...data.review.nodes[0], viewerLatestReview: { state: "COMMENTED", commit: null } };
  const env = makeEnv(data);
  const pulls = createPulls(env.deps);
  await pulls.sync(false);
  assert.deepEqual(pulls.snapshot().items.find((item) => item.number === 3).viewerReview, { state: "COMMENTED", oid: null });
});

test("sync reports fetched only after a successful request", async () => {
  let fail = false;
  const data = fixture();
  const env = makeEnv(() => (fail ? { code: 1, stdout: "", stderr: "boom" } : { code: 0, stdout: JSON.stringify({ data }), stderr: "" }));
  const pulls = createPulls(env.deps);
  assert.equal((await pulls.sync(false)).fetched, true);
  assert.equal((await pulls.sync(false)).fetched, false);
  fail = true;
  assert.equal((await pulls.sync(true)).fetched, false);
});
