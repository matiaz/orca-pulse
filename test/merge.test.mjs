import test from "node:test";
import assert from "node:assert/strict";
import { createMerge } from "../src/sources/merge.mjs";

const URL = "https://github.com/acme/app/pull/7";
const HEAD = "a".repeat(40);
const item = { url: URL, repo: "acme/app", number: 7, title: "t", requested: true, headRefOid: "b".repeat(40) };

function fakeGh(reply) {
  const calls = [];
  const gh = async (args) => {
    calls.push(args);
    return typeof reply === "function" ? reply(args) : reply;
  };
  return { calls, gh };
}

const data = (pull, repo = {}) => ({
  code: 0,
  stdout: JSON.stringify({ data: { repository: { squashMergeAllowed: true, mergeCommitAllowed: false, rebaseMergeAllowed: true, ...repo, pullRequest: pull } } }),
  stderr: "",
});
const fresh = {
  url: URL,
  state: "OPEN",
  isDraft: false,
  headRefOid: HEAD,
  reviewDecision: "APPROVED",
  mergeStateStatus: "CLEAN",
  viewerLatestReview: { state: "APPROVED", commit: { oid: HEAD } },
  commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
};

test("check passes owner, name and number as variables", async () => {
  const { calls, gh } = fakeGh(data(fresh));
  await createMerge({ gh }).check(item);
  const args = calls[0];
  assert.deepEqual(args.slice(0, 2), ["api", "graphql"]);
  const query = args[args.indexOf("-f") + 1];
  assert.match(query, /^query=query\(\$owner: String!, \$name: String!, \$number: Int!\)/);
  assert.match(query, /squashMergeAllowed mergeCommitAllowed rebaseMergeAllowed/);
  assert.equal(query.includes("acme"), false);
  assert.ok(args.includes("owner=acme"));
  assert.ok(args.includes("name=app"));
  assert.equal(args[args.indexOf("number=7") - 1], "-F");
  assert.equal(args[args.indexOf("owner=acme") - 1], "-f");
});

test("check normalizes the PR and the allowed methods", async () => {
  const { gh } = fakeGh(data(fresh));
  const result = await createMerge({ gh }).check(item);
  assert.deepEqual(result.allowed, { squash: true, merge: false, rebase: true });
  assert.equal(result.pr.url, URL);
  assert.equal(result.pr.repo, "acme/app");
  assert.equal(result.pr.number, 7);
  assert.equal(result.pr.state, "OPEN");
  assert.equal(result.pr.isDraft, false);
  assert.equal(result.pr.headRefOid, HEAD);
  assert.equal(result.pr.reviewDecision, "APPROVED");
  assert.equal(result.pr.mergeStateStatus, "CLEAN");
  assert.equal(result.pr.checks, "SUCCESS");
  assert.deepEqual(result.pr.viewerReview, { state: "APPROVED", oid: HEAD });
});

test("check rejects a missing PR, a different url and invalid input", async () => {
  await assert.rejects(createMerge({ gh: fakeGh(data(null)).gh }).check(item));
  await assert.rejects(createMerge({ gh: fakeGh(data({ ...fresh, url: "https://github.com/evil/app/pull/7" })).gh }).check(item));
  const { calls, gh } = fakeGh(data(fresh));
  await assert.rejects(createMerge({ gh }).check({ ...item, url: "https://evil.example/acme/app/pull/7" }));
  assert.equal(calls.length, 0);
  await assert.rejects(createMerge({ gh: fakeGh({ code: 1, stdout: "", stderr: "rate limited" }).gh }).check(item), /rate limited/);
});

test("merge never passes --admin or --delete-branch and pins the head commit", async () => {
  for (const method of ["squash", "merge", "rebase"]) {
    const { calls, gh } = fakeGh({ code: 0, stdout: "", stderr: "" });
    await createMerge({ gh }).merge({ url: URL, headRefOid: HEAD }, method);
    assert.deepEqual(calls[0], ["pr", "merge", URL, `--${method}`, "--match-head-commit", HEAD]);
    assert.equal(calls[0].some((arg) => /admin|delete|auto/.test(arg)), false);
  }
});

test("merge rejects unknown methods and bad input without calling gh", async () => {
  const { calls, gh } = fakeGh({ code: 0, stdout: "", stderr: "" });
  const merge = createMerge({ gh });
  await assert.rejects(merge.merge({ url: URL, headRefOid: HEAD }, "admin"));
  await assert.rejects(merge.merge({ url: URL, headRefOid: "nope" }, "squash"));
  await assert.rejects(merge.merge({ url: "https://evil.example/a/b/pull/1", headRefOid: HEAD }, "squash"));
  assert.equal(calls.length, 0);
});

test("merge reports gh failures", async () => {
  const { gh } = fakeGh({ code: 1, stdout: "", stderr: "Pull request is not mergeable: \u001b[31mbase branch policy prohibits the merge" });
  await assert.rejects(createMerge({ gh }).merge({ url: URL, headRefOid: HEAD }, "squash"), (error) => error.message === "Pull request is not mergeable: base branch policy prohibits the merge");
});
