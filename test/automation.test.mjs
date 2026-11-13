import test from "node:test";
import assert from "node:assert/strict";
import { canMerge, mergeKey, pickMerge, pickReview, scopePulls } from "../src/worker/automation.mjs";

const HEAD = "a".repeat(40);
const OLD = "b".repeat(40);
const workspaces = [
  { id: "w1", path: "/a", hostId: null },
  { id: "w2", path: "/b", hostId: "local" },
  { id: "w3", path: "/c", hostId: null },
  { id: "w4", path: "/d", hostId: "ssh:1" },
];
const remotes = { "/a": "Acme/App", "/b": "acme/lib", "/d": "acme/remote", "/gone": "acme/gone" };
const pr = (number, repo, extra = {}) => ({ url: `https://github.com/${repo}/pull/${number}`, repo, number, isDraft: false, mine: false, requested: true, viewerReview: null, ...extra });
const items = [pr(1, "acme/app"), pr(2, "ACME/LIB"), pr(3, "acme/remote"), pr(4, "acme/gone"), pr(5, "other/x")];
const urls = (list) => list.map((item) => item.number);

function fakeStore(entries = {}) {
  return { has: (url) => url in entries, get: (url) => entries[url] ?? null };
}

test("scopePulls all keeps everything", () => {
  assert.deepEqual(scopePulls(items, { scope: "all", workspaces, remotes, focusedId: null }), { items, scope: { mode: "all", reason: null } });
});

test("scopePulls open keeps repos of open local workspaces case-insensitively", () => {
  const result = scopePulls(items, { scope: "open", workspaces, remotes, focusedId: null });
  assert.deepEqual(urls(result.items), [1, 2]);
  assert.deepEqual(result.scope, { mode: "open", reason: null });
  assert.deepEqual(scopePulls(items, { scope: "open", workspaces: [], remotes, focusedId: null }).items, []);
});

test("scopePulls workspace keeps only the focused repo", () => {
  const result = scopePulls(items, { scope: "workspace", workspaces, remotes, focusedId: "w2" });
  assert.deepEqual(urls(result.items), [2]);
  assert.deepEqual(result.scope, { mode: "workspace", reason: null });
});

test("scopePulls workspace without a GitHub remote is empty and says so", () => {
  assert.deepEqual(scopePulls(items, { scope: "workspace", workspaces, remotes, focusedId: "w3" }), { items: [], scope: { mode: "workspace", reason: "no-remote" } });
});

test("scopePulls workspace without focus is empty", () => {
  for (const focusedId of [null, "w4", "missing"]) {
    assert.deepEqual(scopePulls(items, { scope: "workspace", workspaces, remotes, focusedId }), { items: [], scope: { mode: "workspace", reason: "no-workspace" } });
  }
});

test("pickReview skips drafts, own, reviewed, unrequested, unmatched and stored PRs", () => {
  const list = [
    pr(1, "acme/app", { isDraft: true }),
    pr(2, "acme/app", { mine: true }),
    pr(3, "acme/app", { viewerReview: { state: "COMMENTED", oid: OLD } }),
    pr(4, "acme/app", { requested: false }),
    pr(5, "acme/remote"),
    pr(6, "other/x"),
    pr(7, "acme/app"),
  ];
  assert.equal(pickReview(list, { workspaces, remotes, store: fakeStore({ [list[6].url]: {} }) }), null);
  assert.equal(pickReview([], { workspaces, remotes, store: fakeStore() }), null);
});

test("pickReview returns one candidate", () => {
  const list = [pr(1, "acme/app", { isDraft: true }), pr(2, "ACME/app"), pr(3, "acme/lib")];
  assert.equal(pickReview(list, { workspaces, remotes, store: fakeStore() }).number, 2);
  assert.equal(pickReview(list, { workspaces, remotes, store: fakeStore({ [list[1].url]: {} }) }).number, 3);
});

const ready = (extra = {}) => pr(9, "acme/app", { headRefOid: HEAD, reviewDecision: "APPROVED", viewerReview: { state: "APPROVED", oid: HEAD }, mergeStateStatus: "CLEAN", checks: "SUCCESS", ...extra });
const entry = { startedAt: 1, lastSeen: 1 };

test("canMerge needs a Pulse review, approval on the head commit, CLEAN and green checks", () => {
  assert.equal(canMerge(ready(), entry, "squash"), true);
  assert.equal(canMerge(ready({ state: "OPEN" }), entry, "squash"), true);
  assert.equal(canMerge(ready(), null, "squash"), false);
  assert.equal(canMerge(ready(), { ...entry, launchError: "x" }, "squash"), false);
  assert.equal(canMerge(ready({ reviewDecision: "REVIEW_REQUIRED" }), entry, "squash"), false);
  assert.equal(canMerge(ready({ viewerReview: { state: "COMMENTED", oid: HEAD } }), entry, "squash"), false);
  assert.equal(canMerge(ready({ viewerReview: null }), entry, "squash"), false);
  assert.equal(canMerge(ready({ isDraft: true }), entry, "squash"), false);
  assert.equal(canMerge(ready({ state: "MERGED" }), entry, "squash"), false);
  assert.equal(canMerge(ready({ headRefOid: null, viewerReview: { state: "APPROVED", oid: null } }), entry, "squash"), false);
});

test("canMerge rejects a head newer than the approval", () => {
  assert.equal(canMerge(ready({ viewerReview: { state: "APPROVED", oid: OLD } }), entry, "squash"), false);
});

test("canMerge rejects missing or failing checks", () => {
  for (const checks of [null, undefined, "PENDING", "FAILURE", "ERROR", "EXPECTED"]) assert.equal(canMerge(ready({ checks }), entry, "squash"), false, String(checks));
});

test("canMerge rejects non-CLEAN merge states", () => {
  for (const status of ["BLOCKED", "BEHIND", "DIRTY", "UNSTABLE", "HAS_HOOKS", "UNKNOWN", null]) assert.equal(canMerge(ready({ mergeStateStatus: status }), entry, "squash"), false, String(status));
});

test("canMerge waits for the merge key to change after an attempt", () => {
  const key = mergeKey(ready(), "squash");
  assert.equal(key, `${HEAD}:CLEAN:squash`);
  assert.equal(canMerge(ready(), { ...entry, mergeError: "blocked", mergeKey: key }, "squash"), false);
  assert.equal(canMerge(ready(), { ...entry, mergeError: "blocked", mergeKey: key }, "rebase"), true);
  assert.equal(canMerge(ready(), { ...entry, mergeError: "blocked", mergeKey: `${OLD}:CLEAN:squash` }, "squash"), true);
});

test("pickMerge returns the first mergeable PR in the store", () => {
  const list = [ready({ number: 1, url: "https://github.com/acme/app/pull/1" }), ready({ number: 2, url: "https://github.com/acme/app/pull/2" })];
  assert.equal(pickMerge(list, fakeStore({ [list[1].url]: entry }), "squash").number, 2);
  assert.equal(pickMerge(list, fakeStore(), "squash"), null);
});
