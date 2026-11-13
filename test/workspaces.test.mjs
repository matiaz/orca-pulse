import test from "node:test";
import assert from "node:assert/strict";
import { matchFocused, parseRemote, matchRepo, isLocal } from "../src/lib/workspaces.mjs";

const ws = (id, name, branch, extra = {}) => ({ id, kind: "worktree", name, project: "p", path: `/w/${id}`, branch, hostId: null, ...extra });

test("matchFocused returns null for null context", () => {
  assert.equal(matchFocused(null, [ws("1", "a", "b")]), null);
});

test("matchFocused prefers exact name and branch", () => {
  const list = [ws("1", "feat", "x"), ws("2", "feat", "feat"), ws("3", "other", "feat")];
  assert.equal(matchFocused({ branch: "feat", displayName: "feat", terminals: [] }, list).workspace.id, "2");
});

test("matchFocused falls back to unique name", () => {
  const list = [ws("1", "feat", "x"), ws("2", "other", "y")];
  assert.equal(matchFocused({ branch: "zzz", displayName: "feat", terminals: [] }, list).workspace.id, "1");
});

test("matchFocused ambiguous name falls to unique branch", () => {
  const list = [ws("1", "feat", "x"), ws("2", "feat", "y"), ws("3", "o", "zzz")];
  assert.equal(matchFocused({ branch: "zzz", displayName: "feat", terminals: [] }, list).workspace.id, "3");
});

test("matchFocused ambiguity returns null", () => {
  const list = [ws("1", "feat", "x"), ws("2", "feat", "y")];
  assert.equal(matchFocused({ branch: "q", displayName: "feat", terminals: [] }, list), null);
  const byBranch = [ws("1", "a", "b"), ws("2", "c", "b")];
  assert.equal(matchFocused({ branch: "b", displayName: "zz", terminals: [] }, byBranch), null);
});

test("matchFocused ignores empty branch", () => {
  const list = [ws("1", "a", ""), ws("2", "b", "")];
  assert.equal(matchFocused({ branch: "", displayName: "zz", terminals: [] }, list), null);
});

test("matchFocused ignores remote hosts", () => {
  const list = [ws("1", "feat", "feat", { hostId: "ssh1" })];
  assert.equal(matchFocused({ branch: "feat", displayName: "feat", terminals: [] }, list), null);
  const mixed = [ws("1", "feat", "feat", { hostId: "ssh1" }), ws("2", "feat", "feat")];
  assert.equal(matchFocused({ branch: "feat", displayName: "feat", terminals: [] }, mixed).workspace.id, "2");
});

test("parseRemote accepts github forms", () => {
  for (const url of [
    "git@github.com:o/r.git", "https://github.com/o/r", "https://github.com/o/r.git",
    "ssh://git@github.com/o/r.git", "https://user@github.com/o/r.git",
  ]) assert.equal(parseRemote(url), "o/r", url);
  assert.equal(parseRemote("git@github.com:o-1/r.x.git"), "o-1/r.x");
});

test("parseRemote rejects others", () => {
  for (const url of ["git@gitlab.com:o/r.git", "https://example.com/o/r", "garbage", "", null, undefined, "https://github.com.evil.com/o/r", "https://github.com/o"]) {
    assert.equal(parseRemote(url), null, String(url));
  }
});

test("matchRepo prefers focused, then first, else null", () => {
  const list = [ws("1", "a", "a"), ws("2", "b", "b"), ws("3", "c", "c"), ws("4", "d", "d", { hostId: "h" })];
  const remotes = { "/w/1": "O/R", "/w/2": "o/r", "/w/3": "x/y", "/w/4": "o/r" };
  assert.equal(matchRepo("o/r", list, remotes, "2").id, "2");
  assert.equal(matchRepo("o/r", list, remotes, "3").id, "1");
  assert.equal(matchRepo("o/r", list, remotes, null).id, "1");
  assert.equal(matchRepo("n/n", list, remotes, "1"), null);
  assert.equal(matchRepo("o/r", [list[3]], remotes, "4"), null);
});

test("matchFocused returns null when several workspaces match name and branch", () => {
  const list = [ws("1", "feat", "feat"), ws("2", "feat", "feat")];
  assert.equal(matchFocused({ branch: "feat", displayName: "feat", terminals: [] }, list), null);
});

test("parseRemote validates owner and repo shapes", () => {
  assert.equal(parseRemote("git@github.com:-x/y.git"), null);
  assert.equal(parseRemote("https://github.com/o/.."), null);
  assert.equal(parseRemote("https://github.com/o/."), null);
  assert.equal(parseRemote("https://github.com/o/..git"), null);
  assert.equal(parseRemote("https://github.com/.o/r"), null);
  assert.equal(parseRemote("https://github.com/o_x/r"), null);
  assert.equal(parseRemote("https://github.com/o/_r.x-y"), "o/_r.x-y");
  assert.equal(parseRemote("https://github.com/o/-r"), null);
});

test("isLocal accepts null and local only", () => {
  assert.equal(isLocal({ hostId: null }), true);
  assert.equal(isLocal({ hostId: "local" }), true);
  assert.equal(isLocal({ hostId: "ssh:abc" }), false);
  assert.equal(isLocal({}), false);
  assert.equal(isLocal(null), false);
});

test("matchFocused and matchRepo keep hostId local workspaces", () => {
  const list = [ws("1", "feat", "feat", { hostId: "local" })];
  assert.equal(matchFocused({ branch: "feat", displayName: "feat", terminals: [] }, list).workspace.id, "1");
  assert.equal(matchRepo("o/r", list, { "/w/1": "o/r" }, null).id, "1");
});

test("matchFocused reports how it matched", () => {
  const list = [ws("1", "main", "main", { hostId: "local" }), ws("2", "main", "main", { hostId: "local" }), ws("3", "x", "y")];
  assert.deepEqual(matchFocused({ branch: "y", displayName: "x", terminals: [] }, list), { workspace: list[2], via: "name" });
  assert.equal(matchFocused({ branch: "main", displayName: "main", terminals: [{ id: "t" }] }, list), null);
});

test("matchFocused prefers the terminal map", () => {
  const list = [ws("1", "main", "main", { hostId: "local" }), ws("2", "main", "main", { hostId: "local" })];
  const seen = [];
  const terminalMap = { resolve: (ids) => (seen.push(ids), "2") };
  const result = matchFocused({ branch: "main", displayName: "main", terminals: [{ id: "t1" }, { id: "t2" }] }, list, terminalMap);
  assert.deepEqual(seen, [["t1", "t2"]]);
  assert.equal(result.workspace.id, "2");
  assert.equal(result.via, "terminal");
});

test("matchFocused ignores map answers that are not local workspaces", () => {
  const list = [ws("1", "a", "a"), ws("2", "z", "z", { hostId: "ssh:1" })];
  const context = { branch: "a", displayName: "a", terminals: [{ id: "t" }] };
  assert.deepEqual(matchFocused(context, list, { resolve: () => "2" }), { workspace: list[0], via: "name" });
  assert.deepEqual(matchFocused(context, list, { resolve: () => "gone" }), { workspace: list[0], via: "name" });
  assert.deepEqual(matchFocused(context, list, { resolve: () => null }), { workspace: list[0], via: "name" });
});
