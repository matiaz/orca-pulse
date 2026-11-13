import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { git as realGit } from "../src/lib/exec.mjs";
import { removePrivateTmpDir } from "../src/lib/env.mjs";
import {
  createGit,
  fetchAllowed,
  findPrTemplate,
  findRepoDirs,
  isSafeBranchName,
  kindOf,
  parsePorcelain,
  parsePullRequest,
  prArgs,
  stagedMark,
  statusAllowed,
} from "../src/sources/git.mjs";

const out = (stdout = "", code = 0, stderr = "") => ({ code, stdout, stderr });

async function tmp() {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "orca-pulse-git-")));
}

test("parsePorcelain reads the branch header and counts", () => {
  const parsed = parsePorcelain("## main...origin/main [ahead 2, behind 3]\0 M a.txt\0");
  assert.equal(parsed.branch, "main");
  assert.equal(parsed.upstream, "origin/main");
  assert.equal(parsed.ahead, 2);
  assert.equal(parsed.behind, 3);
  assert.equal(parsePorcelain("## main...origin/main [ahead 1]\0").behind, 0);
  assert.equal(parsePorcelain("## feat\0").upstream, null);
  assert.equal(parsePorcelain("## main...origin/main [gone]\0").ahead, 0);
  assert.equal(parsePorcelain("## No commits yet on main\0").branch, "main");
  assert.equal(parsePorcelain("## HEAD (no branch)\0").branch, null);
});

test("parsePorcelain consumes the extra field of renames and copies", () => {
  const parsed = parsePorcelain("## main\0R  new name.txt\0old name.txt\0C  copy.txt\0orig.txt\0 M after.txt\0");
  assert.deepEqual(
    parsed.files.map((f) => [f.path, f.kind, f.staged]),
    [
      ["new name.txt", "renamed", "staged"],
      ["copy.txt", "added", "staged"],
      ["after.txt", "modified", "unstaged"],
    ],
  );
});

test("parsePorcelain keeps newlines in file names and ignores empty NUL fields", () => {
  const parsed = parsePorcelain("## main\0?? we\nird.txt\0\0\0 D gone.txt\0");
  assert.deepEqual(parsed.files.map((f) => [f.path, f.kind]), [["we\nird.txt", "new"], ["gone.txt", "deleted"]]);
  assert.deepEqual(parsePorcelain("").files, []);
  assert.deepEqual(parsePorcelain("\0\0").files, []);
});

test("parsePorcelain handles every unmerged combination and partial staging", () => {
  for (const code of ["DD", "AU", "UD", "UA", "DU", "AA", "UU"]) {
    const [file] = parsePorcelain(`## main\0${code} c.txt\0`).files;
    assert.equal(file.kind, "conflict", code);
    assert.equal(file.staged, "unstaged", code);
  }
  const files = parsePorcelain("## main\0MM both.txt\0M  staged.txt\0 M work.txt\0A  added.txt\0AM partial-new.txt\0!! ignored.txt\0").files;
  assert.deepEqual(files.map((f) => f.staged), ["partial", "staged", "unstaged", "staged", "partial"]);
  assert.equal(files[3].kind, "added");
});

test("kindOf and stagedMark basics", () => {
  assert.equal(kindOf("?", "?"), "new");
  assert.equal(kindOf(" ", "M"), "modified");
  assert.equal(kindOf("T", " "), "modified");
  assert.equal(stagedMark("?", "?"), "unstaged");
});

test("isSafeBranchName rejects option-like and malformed names", () => {
  for (const bad of ["-x", "--force", "a..b", "a b", "a~1", "a^", "a:b", "a?", "a*", "a[", "a\\b", "a@{u}", "/a", "a/", "a//b", "a.", "a.lock", "", "@", "a\nb"]) {
    assert.equal(isSafeBranchName(bad), false, JSON.stringify(bad));
  }
  for (const good of ["main", "feature/x-1", "release_1.2", "a.b"]) assert.equal(isSafeBranchName(good), true, good);
  assert.equal(isSafeBranchName(undefined), false);
});

test("findRepoDirs skips symlinks, node_modules, dot-dirs and respects the depth cap", async () => {
  const root = await tmp();
  const outside = await tmp();
  const mk = (p) => fs.mkdir(path.join(root, p), { recursive: true });
  await mk("a/.git");
  await mk("group/b/.git");
  await mk("g1/g2/c/.git");
  await mk("g1/g2/g3/d/.git");
  await mk("node_modules/n/.git");
  await mk("vendor/v/.git");
  await mk(".hidden/h/.git");
  await mk("Pods/p/.git");
  await mk("build/x/.git");
  await mk("dist/x/.git");
  await mk("plain/readme");
  await mk("e/.git");
  await fs.mkdir(path.join(outside, "linked/.git"), { recursive: true });
  await fs.symlink(path.join(outside, "linked"), path.join(root, "link"));
  await fs.symlink(outside, path.join(root, "link-dir"));
  await mk("symgit");
  await fs.symlink(outside, path.join(root, "symgit/.git"));
  const found = (await findRepoDirs(root)).map((p) => path.relative(root, p));
  assert.deepEqual(found, ["a", "e", "group/b", "g1/g2/c"]);
});

test("findRepoDirs caps repos and visited directories", async () => {
  const root = await tmp();
  for (let i = 0; i < 20; i++) await fs.mkdir(path.join(root, `r${String(i).padStart(2, "0")}/.git`), { recursive: true });
  assert.equal((await findRepoDirs(root)).length, 12);
  assert.equal((await findRepoDirs(root, { maxDirs: 5 })).length, 5);
  assert.deepEqual(await findRepoDirs(path.join(root, "missing")), []);
});

test("findPrTemplate finds templates in the supported places", async () => {
  const root = await tmp();
  await fs.mkdir(path.join(root, ".github"));
  await fs.writeFile(path.join(root, ".github", "Pull_Request_Template.md"), "## Summary\n\u001b[31mred");
  assert.equal(await findPrTemplate(root), "## Summary\nred");
  const other = await tmp();
  await fs.mkdir(path.join(other, "docs", "PULL_REQUEST_TEMPLATE"), { recursive: true });
  await fs.writeFile(path.join(other, "docs", "PULL_REQUEST_TEMPLATE", "z.md"), "z");
  await fs.writeFile(path.join(other, "docs", "PULL_REQUEST_TEMPLATE", "default.md"), "default");
  assert.equal(await findPrTemplate(other), "default");
  assert.equal(await findPrTemplate(await tmp()), null);
});

test("findPrTemplate caps the size at 8 KB", async () => {
  const root = await tmp();
  await fs.writeFile(path.join(root, "pull_request_template.md"), "x".repeat(20000));
  assert.equal((await findPrTemplate(root)).length, 8000);
});

test("findPrTemplate refuses symlinked files and directories", async () => {
  const root = await tmp();
  const outside = await tmp();
  await fs.writeFile(path.join(outside, "secret.md"), "TOP SECRET");
  await fs.symlink(path.join(outside, "secret.md"), path.join(root, "pull_request_template.md"));
  await fs.mkdir(path.join(outside, "gh"));
  await fs.writeFile(path.join(outside, "gh", "pull_request_template.md"), "TOP SECRET");
  await fs.symlink(path.join(outside, "gh"), path.join(root, ".github"));
  await fs.mkdir(path.join(root, "docs"));
  await fs.symlink(path.join(outside, "secret.md"), path.join(root, "docs", "pull_request_template.md"));
  assert.equal(await findPrTemplate(root), null);
});

test("parsePullRequest builds a capped title and body", () => {
  const parsed = parsePullRequest("# feat/x: add thing\n\n- one\n\u001b[1m- two\n", "feat/x");
  assert.equal(parsed.title, "Add thing");
  assert.equal(parsed.body, "- one\n- two");
  assert.equal(parsePullRequest(`${"a".repeat(200)}\n\nbody`, "b").title.length, 72);
  assert.equal(parsePullRequest("--force\n\nb", "b").title, "Force");
  assert.equal(parsePullRequest("t\n\n" + "y".repeat(20000), "b").body.length, 8000);
  assert.throws(() => parsePullRequest("  \n\n", "b"), /empty/);
});

test("prArgs marks stdin as untrusted data", () => {
  const args = prArgs(false);
  assert.match(args[args.indexOf("--system-prompt") + 1], /untrusted data/);
  assert.match(prArgs(true)[prArgs(true).indexOf("--system-prompt") + 1], /template/);
});

const STATUS_OFF_HINT = "Automatic status is paused because this repo's local git config can run filter commands. Stage, commit, pull and push still work.";
const FETCH_OFF_HINT = (key) => `Background fetch is off for this repo: its local git config sets ${key.toLowerCase()}, which Pulse does not treat as safe. Pull and push still work.`;

function fakeGit({ roots = ["/r"], status = "## main...origin/main\0", remoteUrl = "https://github.com/o/r.git", localKeys = ["core.bare", "remote.origin.url"], worktreeKeys = [], configFails = false, respond } = {}) {
  const calls = [];
  const state = { status, remoteUrl, branchRemote: null, localKeys, worktreeKeys, configFails };
  const fn = async (cwd, args, opts = {}) => {
    calls.push({ cwd, args, opts });
    const custom = respond?.(cwd, args, opts, state);
    if (custom) return custom;
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return roots.includes(cwd) ? out(`${cwd}\n`) : out("", 128, "fatal");
    if (args[0] === "config" && args.includes("--list")) {
      if (state.configFails) return out("", 128, "fatal: bad config");
      return out((args.includes("--worktree") ? state.worktreeKeys : state.localKeys).map((key) => `${key}\0`).join(""));
    }
    if (args[0] === "config" && args[1] === "--get") return state.branchRemote ? out(`${state.branchRemote}\n`) : out("", 1);
    if (args[0] === "remote") return out(`${state.remoteUrl}\n`);
    if (args[0] === "status") return out(state.status);
    return out();
  };
  return { fn, calls, state };
}

const graphql = (pr = null, defaultBranch = "main") =>
  out(JSON.stringify({ data: { repository: { defaultBranchRef: { name: defaultBranch }, ref: { associatedPullRequests: { nodes: pr ? [pr] : [] } } } } }));

function make(overrides = {}) {
  const fake = fakeGit(overrides.git);
  const ghCalls = [];
  const claudeCalls = [];
  const clock = { t: Date.now() };
  const source = createGit({
    git: fake.fn,
    gh: overrides.gh ?? (async (args, opts) => (ghCalls.push({ args, opts }), args[0] === "api" ? graphql() : out("https://github.com/o/r/pull/9\n"))),
    claude: overrides.claude ?? (async (args, opts) => (claudeCalls.push({ args, opts }), out(args.some((a) => /pull request/.test(a)) ? "feat: Do the thing\n\n- a\n- b" : "Do the thing"))),
    now: () => clock.t,
    aiEnabled: overrides.ai ?? (() => true),
    tmpdir: "tmpdir" in overrides ? overrides.tmpdir : "/tmp-claude",
  });
  source.setRoot("root" in overrides ? overrides.root : "/r");
  return { source, fake, ghCalls, claudeCalls, clock };
}

test("not visible without a GitHub remote or a root", async () => {
  const none = make({ git: { remoteUrl: "https://gitlab.com/o/r.git" } });
  await none.source.sync();
  assert.equal(none.source.snapshot().visible, false);
  assert.equal(none.source.snapshot().selected, null);
  const unset = make({ root: null });
  await unset.source.sync();
  assert.equal(unset.source.snapshot().visible, false);
});

test("snapshot exposes the selected repo with sanitized fields", async () => {
  const { source } = make({ git: { status: "## feat...origin/feat [ahead 1, behind 2]\0 M a\u001b[31m.txt\0R  new.txt\0old.txt\0" } });
  await source.sync();
  await source.idle();
  const snap = source.snapshot();
  assert.equal(snap.visible, true);
  assert.deepEqual(snap.repos, []);
  assert.equal(snap.selected.nameWithOwner, "o/r");
  assert.equal(snap.selected.branch, "feat");
  assert.equal(snap.selected.ahead, 1);
  assert.equal(snap.selected.behind, 2);
  assert.deepEqual(snap.selected.files, [
    { path: "a.txt", kind: "modified", staged: "unstaged" },
    { path: "new.txt", kind: "renamed", staged: "staged" },
  ]);
  assert.equal(snap.selected.more, 0);
  assert.equal(snap.selected.defaultBranch, "main");
  assert.equal(snap.selected.pr, null);
  assert.equal(snap.busy, null);
  assert.equal(snap.notice, null);
  assert.equal(snap.ai, true);
  assert.equal(snap.error, null);
  assert.ok(snap.updatedAt);
});

test("snapshot caps the file list at 500 entries", async () => {
  const entries = Array.from({ length: 520 }, (_, i) => `?? f${i}.txt`).join("\0");
  const { source } = make({ git: { status: `## main\0${entries}\0` } });
  await source.sync();
  const snap = source.snapshot();
  assert.equal(snap.selected.files.length, 500);
  assert.equal(snap.selected.more, 20);
});

test("remote info carries the PR and its checks", async () => {
  const pr = { number: 4, url: "https://github.com/o/r/pull/4", commits: { nodes: [{ commit: { statusCheckRollup: { state: "FAILURE" } } }] } };
  const { source, ghCalls } = make({ gh: async (args, opts) => (ghCalls.push({ args, opts }), graphql(pr)), git: { status: "## feat...origin/feat\0" } });
  await source.sync();
  await source.idle();
  assert.deepEqual(source.snapshot().selected.pr, { number: 4, url: "https://github.com/o/r/pull/4", checks: "failed" });
  assert.deepEqual(await source.openPrUrl(), { url: "https://github.com/o/r/pull/4" });
  const args = ghCalls[0].args;
  assert.deepEqual(args.slice(0, 2), ["api", "graphql"]);
  assert.ok(args.includes("owner=o") && args.includes("name=r") && args.includes("ref=refs/heads/feat"));
  assert.ok(args.every((a, i) => a !== "-f" || args[i + 1]));
});

test("openPrUrl rejects without a pull request and refuses non-pull urls", async () => {
  const none = make();
  await none.source.sync();
  await none.source.idle();
  await assert.rejects(none.source.openPrUrl(), (e) => e.code === "no_pr");
  const bad = make({ gh: async () => graphql({ number: 1, url: "https://evil.com/o/r/pull/1" }) });
  await bad.source.sync();
  await bad.source.idle();
  assert.equal(bad.source.snapshot().selected.pr, null);
});

test("gh failures are recorded without hiding git state", async () => {
  const { source } = make({ gh: async () => out("", 1, "gh auth login required") });
  await source.sync();
  await source.idle();
  const snap = source.snapshot();
  assert.equal(snap.visible, true);
  assert.match(snap.error, /gh auth login/);
  assert.equal(snap.hint, "Run gh auth login");
});

test("background fetch uses the pinned arguments and is throttled", async () => {
  const { source, fake, clock } = make();
  await source.sync();
  await source.idle();
  const fetches = () => fake.calls.filter((c) => c.args[0] === "fetch");
  assert.deepEqual(fetches()[0].args, ["fetch", "--quiet", "--no-tags", "--no-recurse-submodules", "--prune", "origin"]);
  await source.sync(true);
  await source.idle();
  assert.equal(fetches().length, 1);
  clock.t += 121000;
  await source.sync();
  await source.idle();
  assert.equal(fetches().length, 2);
});

test("fetch failures never break the poll", async () => {
  const { source } = make({ git: { respond: (cwd, args) => (args[0] === "fetch" ? out("", 128, "fatal: unable to access") : null) } });
  await source.sync();
  await source.idle();
  const snap = source.snapshot();
  assert.equal(snap.visible, true);
  assert.match(snap.error, /fetch failed/);
});

test("push uses set-upstream with fully qualified refs on the first push and never forces", async () => {
  const first = make({ git: { status: "## feat\0" } });
  await first.source.sync();
  await first.source.push();
  const pushFirst = first.fake.calls.find((c) => c.args[0] === "push").args;
  assert.deepEqual(pushFirst, ["push", "--set-upstream", "origin", "refs/heads/feat:refs/heads/feat"]);

  const next = make({ git: { status: "## feat...origin/feat [ahead 2]\0" } });
  await next.source.sync();
  await next.source.push();
  const pushNext = next.fake.calls.find((c) => c.args[0] === "push").args;
  assert.deepEqual(pushNext, ["push", "origin", "refs/heads/feat:refs/heads/feat"]);

  for (const args of [pushFirst, pushNext]) {
    assert.ok(!args.some((a) => /^(--force|-f|--force-with-lease.*|--mirror|--delete)$/.test(a) || a.startsWith("+")));
  }
});

test("push refuses invalid branch names and nothing-to-push", async () => {
  const bad = make({ git: { status: "## -x...origin/x [ahead 1]\0" } });
  await bad.source.sync();
  await assert.rejects(bad.source.push(), /invalid branch/);
  assert.equal(bad.fake.calls.filter((c) => c.args[0] === "push").length, 0);
  const dots = make({ git: { status: "## a..b\0" } });
  await dots.source.sync();
  await assert.rejects(dots.source.push(), /invalid branch/);
  const rejectedByGit = make({ git: { status: "## weird\0", respond: (c, args) => (args[0] === "check-ref-format" ? out("", 1) : null) } });
  await rejectedByGit.source.sync();
  await assert.rejects(rejectedByGit.source.push(), /invalid branch/);
  const synced = make({ git: { status: "## feat...origin/feat\0" } });
  await synced.source.sync();
  await assert.rejects(synced.source.push(), /nothing to push/);
  const detached = make({ git: { status: "## HEAD (no branch)\0" } });
  await detached.source.sync();
  await assert.rejects(detached.source.push(), /detached/);
});

test("push error surfaces a notice with a 4 second lifetime and clears busy", async () => {
  const { source, clock } = make({
    git: { status: "## feat...origin/feat [ahead 1]\0", respond: (c, args) => (args[0] === "push" ? out("", 1, "! [rejected] feat -> feat") : null) },
  });
  await source.sync();
  await assert.rejects(source.push(), /rejected/);
  const snap = source.snapshot();
  assert.equal(snap.busy, null);
  assert.equal(snap.notice.tone, "error");
  assert.match(snap.notice.text, /push failed/);
  assert.equal(snap.notice.until, clock.t + 4000);
  clock.t += 4001;
  assert.equal(source.snapshot().notice, null);
});

test("one action at a time", async () => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const { source } = make({
    git: { status: "## feat...origin/feat [ahead 1]\0", respond: (c, args) => (args[0] === "push" ? gate.then(() => out()) : null) },
  });
  await source.sync();
  const first = source.push();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(source.snapshot().busy, "push");
  await assert.rejects(source.pull(), (e) => e.code === "busy");
  release();
  await first;
  assert.equal(source.snapshot().busy, null);
});

test("pull fetches then fast-forwards only", async () => {
  const { source, fake } = make({
    git: {
      respond: (c, args, o, state) => {
        if (args[0] === "fetch") state.status = "## main...origin/main [behind 3]\0";
        return null;
      },
    },
  });
  await source.sync();
  await source.idle();
  fake.calls.length = 0;
  const result = await source.pull();
  assert.equal(result.pulled, 3);
  const subs = fake.calls.map((c) => c.args);
  const fetchAt = subs.findIndex((a) => a[0] === "fetch");
  const mergeAt = subs.findIndex((a) => a[0] === "merge");
  assert.ok(fetchAt >= 0 && mergeAt > fetchAt);
  assert.deepEqual(subs[fetchAt], ["fetch", "--quiet", "--no-tags", "--no-recurse-submodules"]);
  assert.deepEqual(subs[mergeAt], ["merge", "--ff-only", "@{upstream}"]);
});

test("message is rejected without calling claude when AI is off", async () => {
  const { source, claudeCalls } = make({ ai: () => false, git: { status: "## main\0 M a.txt\0" } });
  await source.sync();
  await assert.rejects(source.message(), (e) => e.code === "ai_disabled");
  assert.equal(source.snapshot().ai, false);
  assert.equal(claudeCalls.length, 0);
});

test("message calls claude with hardened flags, cwd tmpdir and a filtered staged diff", async () => {
  const { source, fake, claudeCalls } = make({
    git: {
      status: "## feat...origin/feat\0M  src/a.js\0A  .env\0A  config/secrets.json\0 M extra.js\0",
      respond: (c, args) => (args[0] === "diff" ? out("DIFF-BODY") : null),
    },
  });
  await source.sync();
  const result = await source.message();
  assert.equal(result.message, "feat: Do the thing");
  assert.equal(claudeCalls.length, 1);
  const { args, opts } = claudeCalls[0];
  assert.deepEqual(args.slice(0, 13), [
    "-p", "--model", "haiku", "--tools", "", "--setting-sources", "", "--strict-mcp-config", "--no-session-persistence", "--disable-slash-commands",
    "--system-prompt", args[11], "Write the commit message for the changes on stdin.",
  ]);
  assert.match(args[11], /untrusted data/);
  assert.equal(opts.cwd, "/tmp-claude");
  assert.equal(opts.timeoutMs, 90000);
  assert.match(opts.input, /DIFF-BODY/);
  assert.ok(!opts.input.includes(".env") && !opts.input.includes("secrets"));
  const diff = fake.calls.find((c) => c.args[0] === "diff");
  assert.deepEqual(diff.args, ["diff", "--cached", "--no-ext-diff", "--no-textconv", "--no-color", "--no-renames", "--", "src/a.js"]);
  assert.equal(diff.opts.env.GIT_LITERAL_PATHSPECS, "1");
});

test("message caps the diff fed to claude at 24 KB and strips hostile output", async () => {
  const { source, claudeCalls } = make({
    claude: async (args, opts) => (claudeCalls.push({ args, opts }), out("  \u001b[31m\"fix\u001b[0m the \u202ething\"  ")),
    git: { status: "## main\0M  a.js\0", respond: (c, args) => (args[0] === "diff" ? out("x".repeat(100000)) : null) },
  });
  await source.sync();
  const result = await source.message();
  assert.equal(result.message, "main: fix the thing");
  assert.ok(claudeCalls[0].opts.input.length < 25000);
});

test("createPr with AI off uses --fill and never calls claude", async () => {
  const { source, ghCalls, claudeCalls } = make({ ai: () => false, git: { status: "## feat...origin/feat\0" } });
  await source.sync();
  const result = await source.createPr();
  assert.deepEqual(result, { url: "https://github.com/o/r/pull/9", number: 9, existing: false });
  assert.equal(claudeCalls.length, 0);
  const create = ghCalls.find((c) => c.args[0] === "pr");
  assert.deepEqual(create.args, ["pr", "create", "--fill", "--base", "main", "--head", "feat", "--repo", "o/r"]);
});

test("createPr with AI writes title and body from the branch and sends the body on stdin", async () => {
  const { source, ghCalls, claudeCalls } = make({
    git: {
      status: "## feat...origin/feat\0",
      respond: (c, args) => {
        if (args[0] === "log") return out("- first commit\n");
        if (args[0] === "diff" && args.includes("--name-only")) return out("a.js\0.env\0keys/id_rsa\0");
        if (args[0] === "diff" && args.includes("--stat")) return out(" a.js | 1 +\n");
        if (args[0] === "diff") return out("DIFF");
        return null;
      },
    },
  });
  await source.sync();
  const result = await source.createPr();
  assert.equal(result.url, "https://github.com/o/r/pull/9");
  assert.equal(claudeCalls.length, 1);
  assert.match(claudeCalls[0].opts.input, /Commits:\n- first commit/);
  assert.match(claudeCalls[0].opts.input, /Base: main/);
  const create = ghCalls.find((c) => c.args[0] === "pr");
  assert.deepEqual(create.args, ["pr", "create", "--title", "Do the thing", "--body-file", "-", "--base", "main", "--head", "feat", "--repo", "o/r"]);
  assert.equal(create.opts.input, "- a\n- b");
  assert.equal(source.snapshot().notice.text, "created PR #9");
});

test("createPr returns the existing PR without creating another", async () => {
  const pr = { number: 3, url: "https://github.com/o/r/pull/3", commits: { nodes: [] } };
  const { source, ghCalls } = make({ gh: async (args, opts) => (ghCalls.push({ args, opts }), graphql(pr)), git: { status: "## feat...origin/feat\0" } });
  await source.sync();
  const result = await source.createPr();
  assert.deepEqual(result, { url: "https://github.com/o/r/pull/3", number: 3, existing: true });
  assert.ok(!ghCalls.some((c) => c.args[0] === "pr"));
});

test("createPr requires a pushed branch that is not the default", async () => {
  const unpushed = make({ git: { status: "## feat\0" } });
  await unpushed.source.sync();
  await assert.rejects(unpushed.source.createPr(), /push the branch first/);
  const onMain = make({ git: { status: "## main...origin/main\0" } });
  await onMain.source.sync();
  await assert.rejects(onMain.source.createPr(), /default branch/);
});

test("commit validates and sanitizes the message", async () => {
  const { source, fake } = make({ git: { status: "## feat\0M  a.js\0" } });
  await source.sync();
  await assert.rejects(source.commit(""), (e) => e.code === "invalid_params");
  await assert.rejects(source.commit("\u202e\u0001 \u200b"), (e) => e.code === "invalid_params");
  await assert.rejects(source.commit(42), (e) => e.code === "invalid_params");
  await source.commit("line one\r\n\u001b[31mline\u0007 two\ttab\u202e");
  const commit = fake.calls.find((c) => c.args[0] === "commit");
  assert.deepEqual(commit.args, ["commit", "-m", "line one\nline two\ttab", "--"]);
  assert.ok(!commit.args.includes("--no-verify"));
  await source.commit("y".repeat(9000));
  const long = fake.calls.filter((c) => c.args[0] === "commit").at(-1).args[2];
  assert.equal(long.length, 5000);
  await source.commit();
  assert.equal(fake.calls.filter((c) => c.args[0] === "commit").at(-1).args[2], "feat");
});

test("commit refuses when nothing is staged", async () => {
  const { source } = make({ git: { status: "## feat\0 M a.js\0" } });
  await source.sync();
  await assert.rejects(source.commit("x"), /nothing staged/);
});

async function isolatedEnv() {
  const home = await tmp();
  return { HOME: home, XDG_CONFIG_HOME: home, GIT_CONFIG_NOSYSTEM: "1" };
}

async function realRepo() {
  const dir = await tmp();
  const env = await isolatedEnv();
  const run = async (...args) => {
    const result = await realGit(dir, args, { env });
    assert.equal(result.code, 0, result.stderr);
    return result.stdout;
  };
  await run("init", "-b", "main");
  await run("config", "user.name", "Test");
  await run("config", "user.email", "test@example.com");
  await run("config", "commit.gpgsign", "false");
  await run("remote", "add", "origin", "https://github.com/o/r.git");
  return { dir, run, env };
}

function realSource(dir, env, fetches = []) {
  const guarded = (cwd, args, opts) => {
    if (args[0] === "fetch") {
      fetches.push(args);
      return Promise.resolve(out());
    }
    return realGit(cwd, args, { ...opts, env: { ...opts?.env, ...env } });
  };
  const source = createGit({
    git: guarded,
    gh: async () => out("", 1, "offline"),
    claude: async () => assert.fail("claude must not be called"),
    aiEnabled: () => false,
  });
  source.setRoot(dir);
  return source;
}

test("stageAll and commit work against a real temporary repo", async () => {
  const { dir, run, env } = await realRepo();
  const source = realSource(dir, env);
  await fs.writeFile(path.join(dir, "a.txt"), "one\n");
  await fs.writeFile(path.join(dir, "-weird.txt"), "two\n");
  await source.sync();
  let snap = source.snapshot();
  assert.equal(snap.visible, true);
  assert.equal(snap.selected.branch, "main");
  assert.deepEqual(snap.selected.files.map((f) => [f.path, f.kind, f.staged]), [
    ["-weird.txt", "new", "unstaged"],
    ["a.txt", "new", "unstaged"],
  ]);
  await assert.rejects(source.commit("early"), /nothing staged/);
  await source.stageAll();
  snap = source.snapshot();
  assert.ok(snap.selected.files.every((f) => f.staged === "staged" && f.kind === "added"));
  const { sha } = await source.commit("first: hello\n\nbody line");
  assert.match(sha, /^[0-9a-f]+$/);
  assert.equal((await run("log", "-1", "--format=%B")).trim(), "first: hello\n\nbody line");
  assert.equal(source.snapshot().selected.files.length, 0);
  assert.equal(source.snapshot().notice.text, `committed ${sha}`);

  await fs.writeFile(path.join(dir, "a.txt"), "changed\n");
  await source.sync(true);
  await source.stageAll();
  await fs.writeFile(path.join(dir, "a.txt"), "changed again\n");
  await source.sync(true);
  assert.equal(source.snapshot().selected.files[0].staged, "partial");
  await source.stageAll();
  await source.commit();
  assert.equal((await run("log", "-1", "--format=%s")).trim(), "main");
  await assert.rejects(source.stageAll(), /nothing to stage/);
});

test("a repo without an origin is not visible", async () => {
  const dir = await tmp();
  const env = await isolatedEnv();
  await realGit(dir, ["init", "-b", "main"], { env });
  const source = realSource(dir, env);
  await source.sync();
  assert.equal(source.snapshot().visible, false);
});

async function workspaceTree() {
  const root = await tmp();
  const repos = {};
  for (const name of ["alpha", "beta", "gamma", "nogh"]) {
    repos[name] = path.join(root, name);
    await fs.mkdir(path.join(repos[name], ".git"), { recursive: true });
    await fs.writeFile(path.join(repos[name], "f.txt"), name);
  }
  return { root, repos };
}

function workspaceSource(root) {
  const calls = [];
  const clock = { t: Date.now() };
  const fn = async (cwd, args) => {
    calls.push({ cwd, args });
    if (args[0] === "rev-parse") return cwd === root ? out("", 128, "fatal") : out(`${cwd}\n`);
    if (args[0] === "remote") return out(cwd.endsWith("nogh") ? "https://gitlab.com/o/x.git\n" : `https://github.com/o/${path.basename(cwd)}.git\n`);
    if (args[0] === "status") return out("## main\0?? f.txt\0");
    return out();
  };
  const source = createGit({ git: fn, gh: async () => graphql(), claude: async () => out("x"), now: () => clock.t, aiEnabled: () => true });
  source.setRoot(root);
  return { source, clock, calls };
}

test("workspace mode discovers repos, keeps only GitHub ones and auto-selects the newest", async () => {
  const { root, repos } = await workspaceTree();
  const base = Date.now() / 1000;
  await fs.utimes(path.join(repos.alpha, "f.txt"), base - 300, base - 300);
  await fs.utimes(path.join(repos.beta, "f.txt"), base - 100, base - 100);
  await fs.utimes(path.join(repos.gamma, "f.txt"), base - 200, base - 200);
  const { source } = workspaceSource(root);
  await source.sync();
  const snap = source.snapshot();
  assert.deepEqual(snap.repos.map((r) => r.name), ["alpha", "beta", "gamma"]);
  assert.equal(snap.selected.name, "beta");
  assert.equal(snap.selected.nameWithOwner, "o/beta");
});

test("select accepts only discovered paths and holds the choice for 5 seconds", async () => {
  const { root, repos } = await workspaceTree();
  const base = Date.now() / 1000;
  for (const name of ["alpha", "beta", "gamma"]) await fs.utimes(path.join(repos[name], "f.txt"), base - 100, base - 100);
  await fs.utimes(path.join(repos.gamma, "f.txt"), base - 50, base - 50);
  const { source, clock } = workspaceSource(root);
  await source.sync();
  assert.equal(source.snapshot().selected.name, "gamma");
  await assert.rejects(source.select("/etc"), (e) => e.code === "invalid_params");
  await assert.rejects(source.select(repos.nogh), (e) => e.code === "invalid_params");
  await assert.rejects(source.select(undefined), (e) => e.code === "invalid_params");
  const snap = await source.select(repos.alpha);
  assert.equal(snap.selected.name, "alpha");
  const later = (Date.now() + 2000) / 1000;
  await fs.utimes(path.join(repos.gamma, "f.txt"), later, later);
  await source.sync(true);
  assert.equal(source.snapshot().selected.name, "alpha");
  clock.t += 6000;
  await source.sync(true);
  assert.equal(source.snapshot().selected.name, "gamma");
});

test("workspace discovery is cached for 30 seconds and summaries for 6", async () => {
  const { root } = await workspaceTree();
  const { source, clock, calls } = workspaceSource(root);
  await source.sync();
  const remotes = () => calls.filter((c) => c.args[0] === "remote").length;
  const statuses = () => calls.filter((c) => c.args[0] === "status").length;
  const r0 = remotes();
  const s0 = statuses();
  clock.t += 3000;
  await source.sync();
  assert.equal(remotes(), r0);
  assert.equal(statuses(), s0 + 1);
  clock.t += 4000;
  await source.sync();
  assert.ok(statuses() > s0 + 1 + 1);
  clock.t += 31000;
  await source.sync();
  assert.ok(remotes() > r0);
});

test("setRoot ignores relative paths and resets state on change", async () => {
  const { source } = make();
  await source.sync();
  assert.equal(source.snapshot().visible, true);
  source.setRoot("relative/path");
  await source.sync();
  assert.equal(source.snapshot().visible, false);
});

test("push takes the remote from branch config and always uses an explicit refspec", async () => {
  const configured = make({ git: { status: "## feat...upstream/feat [ahead 1]\0" } });
  configured.fake.state.branchRemote = "upstream";
  await configured.source.sync();
  await configured.source.push();
  const args = configured.fake.calls.find((c) => c.args[0] === "push").args;
  assert.deepEqual(args, ["push", "upstream", "refs/heads/feat:refs/heads/feat"]);
  const lookup = configured.fake.calls.find((c) => c.args[0] === "config" && c.args[1] === "--get");
  assert.deepEqual(lookup.args, ["config", "--get", "branch.feat.remote"]);
  assert.ok(!args.some((a) => a === "-f" || a.startsWith("--force") || a.startsWith("+") || a === "--no-verify"));
  for (const bad of ["-evil", "a b", ".", "--receive-pack=x", "a/b"]) {
    const ctx = make({ git: { status: "## feat...origin/feat [ahead 1]\0" } });
    ctx.fake.state.branchRemote = bad;
    await ctx.source.sync();
    await assert.rejects(ctx.source.push(), /invalid remote/, bad);
    assert.equal(ctx.fake.calls.filter((c) => c.args[0] === "push").length, 0);
  }
  const first = make({ git: { status: "## feat\0" } });
  await first.source.sync();
  await first.source.push();
  assert.deepEqual(first.fake.calls.find((c) => c.args[0] === "push").args, ["push", "--set-upstream", "origin", "refs/heads/feat:refs/heads/feat"]);
});

test("pull waits for a pending background fetch before its own fetch", async () => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  let fetches = 0;
  const { source, fake } = make({
    git: {
      status: "## main...origin/main [behind 1]\0",
      respond: (c, args) => {
        if (args[0] !== "fetch") return null;
        fetches++;
        return fetches === 1 ? gate.then(() => out()) : out();
      },
    },
  });
  await source.sync();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(fetches, 1);
  const pulling = source.pull();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(fetches, 1);
  assert.ok(!fake.calls.some((c) => c.args[0] === "merge"));
  release();
  await pulling;
  assert.equal(fetches, 2);
  assert.ok(fake.calls.some((c) => c.args[0] === "merge"));
});

test("background fetch is skipped while an action is running", async () => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const { source, fake, clock } = make({
    git: { status: "## feat...origin/feat [ahead 1]\0", respond: (c, args) => (args[0] === "push" ? gate.then(() => out()) : null) },
  });
  await source.sync();
  await source.idle();
  const fetches = () => fake.calls.filter((c) => c.args[0] === "fetch").length;
  assert.equal(fetches(), 1);
  const pushing = source.push();
  await new Promise((r) => setTimeout(r, 5));
  clock.t += 300000;
  await source.sync();
  await source.idle();
  assert.equal(fetches(), 1);
  release();
  await pushing;
  await source.idle();
});

test("setRoot(null) during an action drops its notice and leaves nothing behind", async () => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const { source } = make({
    git: { status: "## feat...origin/feat [ahead 1]\0", respond: (c, args) => (args[0] === "push" ? gate.then(() => out("", 1, "fatal: boom")) : null) },
  });
  await source.sync();
  const pushing = source.push();
  await new Promise((r) => setTimeout(r, 5));
  source.setRoot(null);
  release();
  await assert.rejects(pushing, /boom/);
  const snap = source.snapshot();
  assert.equal(snap.visible, false);
  assert.equal(snap.notice, null);
  assert.equal(snap.busy, null);
  assert.equal(snap.error, null);
});

test("select is blocked while an action is running", async () => {
  const { root, repos } = await workspaceTree();
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const clock = { t: Date.now() };
  const fn = async (cwd, args) => {
    if (args[0] === "rev-parse") return cwd === root ? out("", 128, "fatal") : out(`${cwd}\n`);
    if (args[0] === "remote") return out(`https://github.com/o/${path.basename(cwd)}.git\n`);
    if (args[0] === "status") return out("## main\0M  f.txt\0");
    if (args[0] === "commit") return gate.then(() => out());
    return out();
  };
  const source = createGit({ git: fn, gh: async () => graphql(), claude: async () => out("x"), now: () => clock.t, aiEnabled: () => true });
  source.setRoot(root);
  await source.sync();
  const committing = source.commit("x");
  await new Promise((r) => setTimeout(r, 5));
  await assert.rejects(source.select(repos.alpha), (e) => e.code === "busy");
  release();
  await committing;
});

test("a stale remote result from an older root is dropped", async () => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const pr = { number: 8, url: "https://github.com/o/r/pull/8", commits: { nodes: [] } };
  let calls = 0;
  const { source } = make({
    git: { roots: ["/r", "/r2"] },
    gh: async () => (++calls === 1 ? gate.then(() => graphql(pr)) : graphql()),
  });
  await source.sync();
  source.setRoot("/r2");
  source.setRoot("/r");
  await source.sync();
  await new Promise((r) => setTimeout(r, 5));
  release();
  await source.idle();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(calls, 2);
  assert.equal(source.snapshot().selected.pr, null);
});

test("a stale failure from an older root is dropped and errors do not carry over", async () => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  let calls = 0;
  const { source } = make({
    git: { roots: ["/r", "/r2"] },
    gh: async () => (++calls === 1 ? gate.then(() => out("", 1, "gh auth login")) : graphql()),
  });
  await source.sync();
  source.setRoot("/r2");
  assert.equal(source.snapshot().error, null);
  await source.sync();
  release();
  await new Promise((r) => setTimeout(r, 10));
  await source.idle();
  const snap = source.snapshot();
  assert.equal(snap.error, null);
  assert.equal(snap.hint, null);
  assert.equal(snap.visible, true);
});

test("errors and notices do not survive a root change", async () => {
  const failing = make({
    git: { roots: ["/r", "/r2"], status: "## feat...origin/feat [ahead 1]\0", respond: (c, args) => (args[0] === "push" ? out("", 1, "fatal: nope") : args[0] === "fetch" ? out("", 1, "fatal: offline") : null) },
    gh: async () => out("", 1, "gh auth login"),
  });
  await failing.source.sync();
  await failing.source.idle();
  await assert.rejects(failing.source.push());
  const before = failing.source.snapshot();
  assert.ok(before.error && before.notice);
  failing.source.setRoot("/r2");
  const after = failing.source.snapshot();
  assert.equal(after.error, null);
  assert.equal(after.hint, null);
  assert.equal(after.notice, null);
});

test("an invalid branch clears an earlier gh failure", async () => {
  let ok = false;
  const { source, fake } = make({ gh: async () => (ok ? graphql() : out("", 1, "gh auth login")) });
  await source.sync();
  await source.idle();
  assert.ok(source.snapshot().error);
  fake.state.status = "## a..b\0";
  await source.sync(true);
  source.setRoot("/r");
  await source.idle();
  ok = true;
  await source.sync(true);
  await source.idle();
  assert.equal(source.snapshot().error, null);
});

test("createPr runs gh from the temp dir on the AI path and from the repo with --fill", async () => {
  const ai = make({ git: { status: "## feat...origin/feat\0", respond: (c, args) => (args[0] === "log" ? out("- c\n") : null) } });
  await ai.source.sync();
  await ai.source.createPr();
  assert.equal(ai.ghCalls.find((c) => c.args[0] === "pr").opts.cwd, "/tmp-claude");
  const fill = make({ ai: () => false, git: { status: "## feat...origin/feat\0" } });
  await fill.source.sync();
  await fill.source.createPr();
  assert.equal(fill.ghCalls.find((c) => c.args[0] === "pr").opts.cwd, "/r");
});

test("AI inputs are built with --no-renames and without dangling surrogates", async () => {
  const { source, fake, claudeCalls } = make({
    git: {
      status: "## feat...origin/feat\0",
      respond: (c, args) => {
        if (args[0] === "log") return out("- c\n");
        if (args[0] === "diff" && args.includes("--name-only")) return out("a.js\0");
        if (args[0] === "diff") return out(`${"x".repeat(23999)}\u{1F600}tail`);
        return null;
      },
    },
  });
  await source.sync();
  await source.createPr();
  for (const call of fake.calls.filter((c) => c.args[0] === "diff")) assert.ok(call.args.includes("--no-renames"), call.args.join(" "));
  assert.doesNotMatch(claudeCalls[0].opts.input, /[\ud800-\udbff](?![\udc00-\udfff])/);
  assert.ok(!claudeCalls[0].opts.input.endsWith("\ud83d"));
});

test("the PR template comes from the remote default branch ref first", async () => {
  const tree = [
    "100644 blob aaaa\tpull_request_template.md",
    "120000 blob bbbb\tdocs/pull_request_template.md",
    "040000 tree cccc\t.github",
  ].join("\0");
  const { source, fake, claudeCalls } = make({
    git: {
      status: "## feat...origin/feat\0",
      respond: (c, args) => {
        if (args[0] === "log") return out("- c\n");
        if (args[0] === "ls-tree") return out(args.includes("-r") ? "" : tree);
        if (args[0] === "cat-file") return out("## From ref\n" + "z".repeat(20000));
        return null;
      },
    },
  });
  await source.sync();
  await source.createPr();
  const cat = fake.calls.find((c) => c.args[0] === "cat-file");
  assert.deepEqual(cat.args, ["cat-file", "-p", "refs/remotes/origin/main:pull_request_template.md"]);
  assert.match(claudeCalls[0].opts.input, /Template:\n## From ref/);
  assert.ok(claudeCalls[0].opts.input.length < 12000);
  assert.ok(!fake.calls.some((c) => c.args[0] === "cat-file" && c.args[2].includes("docs/")));
});

test("the PR template falls back to the working tree when the ref has none", async () => {
  const root = await tmp();
  await fs.writeFile(path.join(root, "pull_request_template.md"), "## From disk");
  const { source, claudeCalls } = make({
    root,
    git: { roots: [root], status: "## feat...origin/feat\0", respond: (c, args) => (args[0] === "log" ? out("- c\n") : null) },
  });
  await source.sync();
  await source.createPr();
  assert.match(claudeCalls[0].opts.input, /Template:\n## From disk/);
});

test("parsePullRequest only strips hashes followed by a space", () => {
  assert.equal(parsePullRequest("#123 fix the thing\n\nb", "x").title, "#123 fix the thing");
  assert.equal(parsePullRequest("## Heading title\n\nb", "x").title, "Heading title");
});

test("findRepoDirs stops reading a directory after the entry limit", async () => {
  const root = await tmp();
  for (let i = 0; i < 10; i++) await fs.mkdir(path.join(root, `r${i}/.git`), { recursive: true });
  assert.equal((await findRepoDirs(root, { maxEntries: 3 })).length, 3);
  assert.equal((await findRepoDirs(root)).length, 10);
});

test("the background fetch is skipped when local git config has anything outside the safe keys", async () => {
  const keys = [
    ["core.sshCommand", "touch /tmp/pwned"], ["credential.helper", "!x"], ["url.https://evil/.pushInsteadOf", "https://github.com/"],
    ["core.gitProxy", "x"], ["core.askPass", "x"], ["include.path", "other"], ["remote.origin.uploadpack", "x"],
    ["remote.origin.receivepack", "x"], ["gpg.program", "x"], ["protocol.allow", "always"], ["http.proxy", "http://x"],
  ];
  for (const [key, value] of keys) {
    const { dir, run, env } = await realRepo();
    await run("config", "--local", key, value);
    const fetches = [];
    const source = realSource(dir, env, fetches);
    await source.sync();
    await source.idle();
    assert.equal(fetches.length, 0, key);
    const snap = source.snapshot();
    assert.equal(snap.visible, true, key);
    assert.equal(snap.hint, key.startsWith("include") ? STATUS_OFF_HINT : FETCH_OFF_HINT(key), key);
  }
});

test("the background fetch runs for a clean repo and manual pull still works for a flagged one", async () => {
  const clean = await realRepo();
  const fetches = [];
  const source = realSource(clean.dir, clean.env, fetches);
  await source.sync();
  await source.idle();
  assert.deepEqual(fetches[0], ["fetch", "--quiet", "--no-tags", "--no-recurse-submodules", "--prune", "origin"]);
  assert.equal(source.snapshot().hint, null);

  const flagged = await realRepo();
  await flagged.run("config", "--local", "core.sshCommand", "ssh -v");
  const manualFetches = [];
  const manual = realSource(flagged.dir, flagged.env, manualFetches);
  await manual.sync();
  await manual.idle();
  assert.equal(manualFetches.length, 0);
  await assert.rejects(manual.pull(), /no upstream/);
});

test("statusAllowed refuses filters, includes and unreadable config", () => {
  assert.equal(statusAllowed(["core.bare", "remote.origin.url", "user.name"]), true);
  assert.equal(statusAllowed([]), true);
  for (const key of ["filter.lfs.clean", "Filter.X.smudge", "include.path", "includeif.gitdir:/x/.path"]) {
    assert.equal(statusAllowed(["core.bare", key]), false, key);
  }
  assert.equal(statusAllowed(null), false);
});

test("fetchAllowed accepts only the safe keys", () => {
  const safe = [
    "core.repositoryformatversion", "core.filemode", "core.bare", "core.logallrefupdates", "core.ignorecase", "core.precomposeunicode",
    "core.symlinks", "remote.origin.url", "remote.origin.fetch", "remote.my.fork.prune", "remote.origin.tagopt", "branch.feat/x.remote",
    "branch.main.merge", "branch.main.rebase", "user.name", "user.email", "pull.rebase", "pull.ff", "push.default", "init.defaultbranch",
    "gc.auto", "submodule.lib.url", "submodule.lib.active", "submodule.active", "lfs.repositoryformatversion", "commit.gpgsign",
    "extensions.objectformat", "extensions.refstorage", "Core.Bare",
  ];
  assert.equal(fetchAllowed(safe), true);
  for (const key of [
    "core.worktree", "core.sshcommand", "core.hookspath", "extensions.worktreeconfig", "remote.origin.uploadpack", "remote.origin.pushurl",
    "branch.main.description.x", "submodule.lib.update", "filter.lfs.clean", "include.path", "gpg.program", "credential.helper", "x",
  ]) {
    assert.equal(fetchAllowed([...safe, key]), false, key);
  }
  assert.equal(fetchAllowed(null), false);
});

test("automatic status ignores dirty submodules while user actions run the full status", async () => {
  const { source, fake } = make({ git: { status: "## feat\0 M a.js\0" } });
  await source.sync();
  await source.idle();
  const statuses = () => fake.calls.filter((c) => c.args[0] === "status").map((c) => c.args);
  assert.deepEqual(statuses(), [["status", "--porcelain=v1", "-z", "--branch", "--ignore-submodules=dirty"]]);
  await source.stageAll();
  assert.deepEqual(statuses()[1], ["status", "--porcelain=v1", "-z", "--branch"]);
  assert.deepEqual(statuses()[2], ["status", "--porcelain=v1", "-z", "--branch", "--ignore-submodules=dirty"]);
});

test("automatic status is paused when local config can run filters", async () => {
  for (const key of ["filter.lfs.clean", "include.path", "includeif.gitdir:/x/.path"]) {
    const { source, fake } = make({
      git: { status: "## feat\0 M a.js\0", localKeys: ["core.bare", key], respond: (c, args) => (args[0] === "symbolic-ref" ? out("feat\n") : null) },
    });
    await source.sync();
    await source.idle();
    assert.equal(fake.calls.some((c) => c.args[0] === "status"), false, key);
    assert.equal(fake.calls.some((c) => c.args[0] === "fetch"), false, key);
    assert.deepEqual(fake.calls.find((c) => c.args[0] === "symbolic-ref").args, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
    const snap = source.snapshot();
    assert.equal(snap.visible, true, key);
    assert.equal(snap.selected.branch, "feat", key);
    assert.deepEqual(snap.selected.files, [], key);
    assert.equal(snap.hint, STATUS_OFF_HINT, key);
    assert.equal(snap.error, null, key);
  }
});

test("user actions still run while automatic status is paused", async () => {
  const { source, fake } = make({ git: { status: "## feat\0 M a.js\0", localKeys: ["filter.x.clean"] } });
  await source.sync();
  await source.stageAll();
  assert.equal(fake.calls.filter((c) => c.args[0] === "status").length, 1);
  assert.ok(fake.calls.some((c) => c.args[0] === "add"));
  assert.equal(source.snapshot().hint, STATUS_OFF_HINT);
});

test("a failing config check pauses automatic status and background fetch", async () => {
  const { source, fake } = make({ git: { configFails: true } });
  await source.sync();
  await source.idle();
  assert.equal(fake.calls.some((c) => c.args[0] === "status" || c.args[0] === "fetch"), false);
  assert.equal(source.snapshot().hint, STATUS_OFF_HINT);
});

test("worktree config is read only when the worktree extension is on and the file exists", async () => {
  const worktreeCalls = (fake) => fake.calls.filter((c) => c.args[0] === "config" && c.args.includes("--worktree"));
  const plain = make({ git: { worktreeKeys: ["filter.x.clean"] } });
  await plain.source.sync();
  assert.equal(worktreeCalls(plain.fake).length, 0);
  assert.equal(plain.fake.calls.filter((c) => c.args[0] === "status").length, 1);

  const dirs = (gitDir) => (c, args) => (args[0] === "rev-parse" && args.includes("--git-common-dir") ? out(`${gitDir}\n${gitDir}\n`) : null);
  const missing = make({ git: { localKeys: ["extensions.worktreeconfig"], worktreeKeys: ["filter.x.clean"], respond: dirs("/nonexistent-git-dir") } });
  await missing.source.sync();
  assert.equal(worktreeCalls(missing.fake).length, 0);
  assert.equal(missing.fake.calls.filter((c) => c.args[0] === "status").length, 1);

  const gitDir = await tmp();
  await fs.writeFile(path.join(gitDir, "config.worktree"), "[filter \"x\"]\n\tclean = x\n");
  const present = make({ git: { localKeys: ["extensions.worktreeconfig"], worktreeKeys: ["filter.x.clean"], respond: dirs(gitDir) } });
  await present.source.sync();
  assert.deepEqual(worktreeCalls(present.fake)[0].args, ["config", "--worktree", "--name-only", "-z", "--list"]);
  assert.equal(present.fake.calls.some((c) => c.args[0] === "status"), false);
  assert.equal(present.source.snapshot().hint, STATUS_OFF_HINT);
});

test("the config check is cached and repeated after a minute", async () => {
  const { source, fake, clock } = make();
  const checks = () => fake.calls.filter((c) => c.args[0] === "config" && c.args.includes("--local")).length;
  await source.sync();
  await source.idle();
  assert.deepEqual(fake.calls.find((c) => c.args[0] === "config" && c.args.includes("--local")).args, ["config", "--local", "--name-only", "-z", "--list"]);
  const first = checks();
  clock.t += 2000;
  await source.sync();
  await source.idle();
  assert.equal(checks(), first);
  clock.t += 61000;
  await source.sync();
  await source.idle();
  assert.ok(checks() > first);
});

test("automatic status never runs a repo-local filter, and notices a new one without waiting", async () => {
  const { dir, run, env } = await realRepo();
  const marker = path.join(await tmp(), "ran");
  await fs.writeFile(path.join(dir, ".gitattributes"), "*.txt filter=evil\n");
  await fs.writeFile(path.join(dir, "a.txt"), "one\n");
  await run("add", "-A");
  await run("commit", "-m", "init");
  const source = realSource(dir, env);
  await source.sync();
  await source.idle();
  assert.equal(source.snapshot().selected.files.length, 0);
  assert.equal(source.snapshot().hint, null);
  await run("config", "--local", "filter.evil.clean", `touch '${marker}'; cat`);
  await fs.writeFile(path.join(dir, "a.txt"), "two\n");
  await source.sync(true);
  await source.idle();
  const snap = source.snapshot();
  assert.equal(snap.hint, STATUS_OFF_HINT);
  assert.equal(snap.selected.branch, "main");
  assert.deepEqual(snap.selected.files, []);
  await assert.rejects(fs.stat(marker), { code: "ENOENT" });
  await source.stageAll();
  await fs.stat(marker);
});

test("createPr and message use a private temp folder by default", async () => {
  const { source, claudeCalls } = make({ tmpdir: undefined, git: { status: "## main\0M  a.js\0" } });
  await source.sync();
  await source.message();
  const cwd = claudeCalls[0].opts.cwd;
  assert.equal(path.dirname(cwd), path.resolve(os.tmpdir()));
  assert.match(path.basename(cwd), /^orca-pulse-/);
  assert.equal((await fs.stat(cwd)).mode & 0o777, 0o700);
  removePrivateTmpDir();
  await assert.rejects(fs.stat(cwd), { code: "ENOENT" });
});
