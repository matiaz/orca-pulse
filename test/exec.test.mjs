import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { ALLOWED, GIT_FLAGS, claudeEnv, ghEnv, gitConfigEnv, resolveBin, run, git, gitEnv, toolEnv } from "../src/lib/exec.mjs";
import { toolPath, applyToolPath, privateTmpDir, removePrivateTmpDir } from "../src/lib/env.mjs";

const hasGit = spawnSync("git", ["--version"]).status === 0;

test("ALLOWED lists the permitted binaries", () => {
  assert.deepEqual([...ALLOWED].sort(), ["claude", "gh", "git", "pbcopy", "security", "wl-copy", "xclip", "xsel"]);
});

test("run rejects binaries outside the allowlist", async () => {
  await assert.rejects(() => run("sh", ["-c", "true"]), /binary not allowed: sh/);
});

test("run rejects non-array args", async () => {
  await assert.rejects(() => run("git", "--version"), /args/);
  await assert.rejects(() => run("git", [1]), /args/);
});

test("git version resolves with code 0", { skip: !hasGit }, async () => {
  const result = await git(process.cwd(), ["version"]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /git version/);
});

test("git refuses a leading option", async () => {
  await assert.rejects(() => git(process.cwd(), ["--version"]), /subcommand/);
  await assert.rejects(() => git(process.cwd(), ["-c", "x=y", "status"]), /subcommand/);
  await assert.rejects(() => git(process.cwd(), []), /subcommand/);
});

test("non-zero exit resolves with the code", { skip: !hasGit }, async () => {
  const result = await git(os.tmpdir(), ["definitely-not-a-command"]);
  assert.notEqual(result.code, 0);
  assert.equal(typeof result.stderr, "string");
});

test("run passes input via stdin", { skip: !hasGit }, async () => {
  const result = await run("git", ["hash-object", "--stdin"], { input: "hello\n" });
  assert.equal(result.code, 0);
  assert.equal(result.stdout.trim(), "ce013625030ba8dba906f756967f9e9ca394464a");
});

test("run honours opts.env.PATH", { skip: !hasGit }, async () => {
  const error = await run("git", ["version"], { env: { PATH: "/nonexistent-dir" } }).catch((e) => e);
  assert.ok(error instanceof Error);
  assert.equal(error.code, "ENOENT");
});

test("run kills on timeout and flags timedOut", { skip: !hasGit || process.platform === "win32" }, async () => {
  const started = Date.now();
  const error = await run("git", ["-c", "alias.slp=!sleep 2", "slp"], { timeoutMs: 200 }).catch((e) => e);
  assert.ok(error instanceof Error);
  assert.equal(error.timedOut, true);
  assert.ok(Date.now() - started < 1800);
});

test("gitEnv drops GIT_ variables and askpass, then applies defaults", () => {
  const env = gitEnv({
    PATH: "/bin",
    HOME: "/h",
    GIT_EXTERNAL_DIFF: "evil",
    GIT_DIR: "/x",
    GIT_PAGER: "less",
    SSH_ASKPASS: "/a",
    SSH_ASKPASS_REQUIRE: "force",
    SSH_AUTH_SOCK: "/sock",
  });
  assert.equal(env.GIT_EXTERNAL_DIFF, undefined);
  assert.equal(env.GIT_DIR, undefined);
  assert.equal(env.SSH_ASKPASS, undefined);
  assert.equal(env.SSH_ASKPASS_REQUIRE, undefined);
  assert.equal(env.GIT_TERMINAL_PROMPT, "0");
  assert.equal(env.GIT_OPTIONAL_LOCKS, "0");
  assert.equal(env.GIT_PAGER, "cat");
  assert.equal(env.LC_ALL, "C");
  assert.equal(env.PATH, "/bin");
  assert.equal(env.HOME, "/h");
  assert.equal(env.SSH_AUTH_SOCK, "/sock");
});

test("gitEnv does not mutate its input", () => {
  const base = { GIT_DIR: "/x" };
  gitEnv(base);
  assert.deepEqual(base, { GIT_DIR: "/x" });
});

test("toolEnv passes only allowlisted variables plus extras", () => {
  const env = toolEnv(
    {
      HOME: "/h", USER: "u", LOGNAME: "u", PATH: "/bin", SHELL: "/bin/sh", TMPDIR: "/t", TERM: "xterm", LANG: "en",
      LC_ALL: "C", XDG_STATE_HOME: "/s", GH_HOST: "h", GH_TOKEN: "t", GITHUB_TOKEN: "g", CLAUDE_CONFIG_DIR: "/c",
      ANTHROPIC_API_KEY: "k", SSH_AUTH_SOCK: "/sock",
      FOO_SECRET: "nope", GIT_EXTERNAL_DIFF: "evil", AWS_SECRET_ACCESS_KEY: "nope", NODE_OPTIONS: "--require x",
    },
    { GH_PROMPT_DISABLED: "1" },
  );
  for (const key of ["HOME", "USER", "LOGNAME", "PATH", "SHELL", "TMPDIR", "TERM", "LANG", "LC_ALL", "XDG_STATE_HOME", "GH_HOST", "GH_TOKEN", "GITHUB_TOKEN", "CLAUDE_CONFIG_DIR", "ANTHROPIC_API_KEY", "SSH_AUTH_SOCK", "GH_PROMPT_DISABLED"]) {
    assert.ok(key in env, key);
  }
  for (const key of ["FOO_SECRET", "GIT_EXTERNAL_DIFF", "AWS_SECRET_ACCESS_KEY", "NODE_OPTIONS"]) {
    assert.equal(key in env, false, key);
  }
});

test("toolEnv fills USER and LOGNAME from the OS when the host omits them", () => {
  const name = os.userInfo().username;
  const env = toolEnv({ HOME: "/h", PATH: "/bin" }, {});
  assert.equal(env.USER, name);
  assert.equal(env.LOGNAME, name);
  const kept = toolEnv({ HOME: "/h", USER: "given", LOGNAME: "given" }, {});
  assert.equal(kept.USER, "given");
  assert.equal(kept.LOGNAME, "given");
});

test("git and gh environments built from process.env lack leaked variables", () => {
  process.env.GIT_EXTERNAL_DIFF = "evil";
  process.env.FOO_SECRET = "nope";
  try {
    assert.equal("GIT_EXTERNAL_DIFF" in gitEnv(process.env), false);
    const tool = toolEnv(process.env, {});
    assert.equal("GIT_EXTERNAL_DIFF" in tool, false);
    assert.equal("FOO_SECRET" in tool, false);
  } finally {
    delete process.env.GIT_EXTERNAL_DIFF;
    delete process.env.FOO_SECRET;
  }
});

test("toolPath keeps existing order, appends well-known dirs, dedupes", () => {
  const home = os.homedir();
  const result = toolPath("/usr/bin:/usr/local/bin:/bin");
  assert.deepEqual(result.split(path.delimiter), ["/usr/bin", "/usr/local/bin", "/bin", "/opt/homebrew/bin", path.join(home, ".local", "bin")]);
  assert.equal(toolPath(result), result);
});

test("toolPath handles an empty base", () => {
  assert.deepEqual(toolPath("").split(path.delimiter), ["/opt/homebrew/bin", "/usr/local/bin", path.join(os.homedir(), ".local", "bin")]);
});

test("applyToolPath sets process.env.PATH idempotently", () => {
  const original = process.env.PATH;
  try {
    process.env.PATH = "/usr/bin";
    applyToolPath();
    const first = process.env.PATH;
    assert.ok(first.startsWith("/usr/bin"));
    assert.ok(first.includes("/opt/homebrew/bin"));
    applyToolPath();
    assert.equal(process.env.PATH, first);
  } finally {
    process.env.PATH = original;
  }
});

test("run rejects when output exceeds maxBytes", { skip: !hasGit }, async () => {
  const error = await run("git", ["version"], { maxBytes: 3 }).catch((e) => e);
  assert.ok(error instanceof Error);
  assert.equal(error.code, "ERR_MAXBUFFER");
});

test("GIT_FLAGS hardens every git call, including alternate refs", () => {
  assert.deepEqual(GIT_FLAGS, [
    "-c", "core.fsmonitor=false",
    "-c", "core.hooksPath=/dev/null",
    "-c", "diff.external=",
    "-c", "core.pager=cat",
    "-c", "core.alternateRefsCommand=",
  ]);
});

test("gitConfigEnv carries the same hardening as GIT_FLAGS", () => {
  const env = gitConfigEnv();
  const pairs = [];
  for (let i = 0; i < Number(env.GIT_CONFIG_COUNT); i++) pairs.push("-c", `${env[`GIT_CONFIG_KEY_${i}`]}=${env[`GIT_CONFIG_VALUE_${i}`]}`);
  assert.deepEqual(pairs, GIT_FLAGS);
  assert.equal(Object.keys(env).length, 1 + 2 * Number(env.GIT_CONFIG_COUNT));
});

test("ghEnv passes the git hardening to the git that gh runs", () => {
  const env = ghEnv({ HOME: "/h", PATH: "/bin", GH_TOKEN: "t", GIT_CONFIG_COUNT: "9", GIT_CONFIG_KEY_0: "evil" }, { EXTRA: "1" });
  assert.equal(env.GH_PROMPT_DISABLED, "1");
  assert.equal(env.NO_COLOR, "1");
  assert.equal(env.GH_TOKEN, "t");
  assert.equal(env.EXTRA, "1");
  for (const [key, value] of Object.entries(gitConfigEnv())) assert.equal(env[key], value, key);
});

test("the git config environment is honored by git", { skip: !hasGit }, async () => {
  const result = await run("git", ["config", "--get", "core.hooksPath"], { cwd: os.tmpdir(), env: gitConfigEnv() });
  assert.equal(result.code, 0);
  assert.equal(result.stdout.trim(), "/dev/null");
});

test("claudeEnv drops GitHub tokens and gh variables but keeps the user", () => {
  const env = claudeEnv(
    {
      HOME: "/h", PATH: "/bin", SHELL: "/bin/sh", TMPDIR: "/t", TERM: "xterm", LANG: "en", LC_ALL: "C", XDG_STATE_HOME: "/s",
      CLAUDE_CONFIG_DIR: "/c", ANTHROPIC_API_KEY: "k", GH_TOKEN: "t", GITHUB_TOKEN: "g", GH_HOST: "h", GH_ENTERPRISE_TOKEN: "e",
      FOO_SECRET: "nope", NODE_OPTIONS: "--require x",
    },
    { EXTRA: "1" },
  );
  for (const key of ["HOME", "PATH", "SHELL", "TMPDIR", "TERM", "LANG", "LC_ALL", "XDG_STATE_HOME", "CLAUDE_CONFIG_DIR", "ANTHROPIC_API_KEY", "EXTRA"]) {
    assert.ok(key in env, key);
  }
  for (const key of ["GH_TOKEN", "GITHUB_TOKEN", "GH_HOST", "GH_ENTERPRISE_TOKEN", "FOO_SECRET", "NODE_OPTIONS"]) {
    assert.equal(key in env, false, key);
  }
  const name = os.userInfo().username;
  assert.equal(env.USER, name);
  assert.equal(env.LOGNAME, name);
});

test("resolveBin uses the absolute keychain tool on macOS only", () => {
  assert.equal(resolveBin("security", "darwin"), "/usr/bin/security");
  assert.equal(resolveBin("security", "linux"), "security");
  assert.equal(resolveBin("git", "darwin"), "git");
  assert.equal(resolveBin("gh", "darwin"), "gh");
});

test("run finds security without PATH on macOS", { skip: process.platform !== "darwin" }, async () => {
  const result = await run("security", ["list-keychains", "-d", "system"], { env: { PATH: "/nonexistent-dir" } });
  assert.equal(typeof result.code, "number");
});

test("privateTmpDir creates one private folder lazily and removePrivateTmpDir deletes it", { skip: process.platform === "win32" }, () => {
  const dir = privateTmpDir();
  assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
  assert.match(path.basename(dir), /^orca-pulse-/);
  const info = fs.lstatSync(dir);
  assert.ok(info.isDirectory());
  assert.equal(info.mode & 0o777, 0o700);
  assert.equal(privateTmpDir(), dir);
  removePrivateTmpDir();
  assert.equal(fs.existsSync(dir), false);
  const next = privateTmpDir();
  assert.notEqual(next, dir);
  fs.rmSync(next, { recursive: true });
  const again = privateTmpDir();
  assert.notEqual(again, next);
  assert.ok(fs.existsSync(again));
  removePrivateTmpDir();
  removePrivateTmpDir();
});
