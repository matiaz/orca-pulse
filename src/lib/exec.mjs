import { spawn } from "node:child_process";
import os from "node:os";

export const ALLOWED = new Set(["git", "gh", "claude", "security", "pbcopy", "wl-copy", "xclip", "xsel"]);

const ABSOLUTE_BINS = { darwin: { security: "/usr/bin/security" } };

const TOOL_ENV_EXACT = new Set(["HOME", "USER", "LOGNAME", "PATH", "SHELL", "TMPDIR", "TERM", "LANG", "GITHUB_TOKEN", "GH_TOKEN", "SSH_AUTH_SOCK"]);
const TOOL_ENV_PREFIX = ["LC_", "XDG_", "GH_", "CLAUDE_", "ANTHROPIC_"];
const CLAUDE_ENV_EXACT = new Set(["HOME", "USER", "LOGNAME", "PATH", "SHELL", "TMPDIR", "TERM", "LANG", "SSH_AUTH_SOCK"]);
const CLAUDE_ENV_PREFIX = ["LC_", "XDG_", "CLAUDE_", "ANTHROPIC_"];

const GIT_CONFIG = [
  ["core.fsmonitor", "false"],
  ["core.hooksPath", "/dev/null"],
  ["diff.external", ""],
  ["core.pager", "cat"],
  ["core.alternateRefsCommand", ""],
];

export const GIT_FLAGS = GIT_CONFIG.flatMap(([key, value]) => ["-c", `${key}=${value}`]);

export function gitConfigEnv() {
  const env = { GIT_CONFIG_COUNT: String(GIT_CONFIG.length) };
  GIT_CONFIG.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  return env;
}

export function resolveBin(bin, platform = process.platform) {
  return ABSOLUTE_BINS[platform]?.[bin] ?? bin;
}

export function gitEnv(base) {
  const env = {};
  for (const [key, value] of Object.entries(base)) {
    if (key.startsWith("GIT_") || key === "SSH_ASKPASS" || key === "SSH_ASKPASS_REQUIRE") continue;
    env[key] = value;
  }
  return { ...env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_PAGER: "cat", LC_ALL: "C" };
}

function pickEnv(base, exact, prefixes, extra) {
  const env = {};
  for (const [key, value] of Object.entries(base)) {
    if (exact.has(key) || prefixes.some((prefix) => key.startsWith(prefix))) env[key] = value;
  }
  if (!env.USER || !env.LOGNAME) {
    const name = osUserName();
    if (name) {
      env.USER ||= name;
      env.LOGNAME ||= name;
    }
  }
  return { ...env, ...extra };
}

export function toolEnv(base, extra) {
  return pickEnv(base, TOOL_ENV_EXACT, TOOL_ENV_PREFIX, extra);
}

export function ghEnv(base, extra) {
  return toolEnv(base, { GH_PROMPT_DISABLED: "1", NO_COLOR: "1", ...extra, ...gitConfigEnv() });
}

export function claudeEnv(base, extra) {
  return pickEnv(base, CLAUDE_ENV_EXACT, CLAUDE_ENV_PREFIX, extra);
}

function osUserName() {
  try {
    return os.userInfo().username || null;
  } catch {
    return null;
  }
}

export function run(bin, args, { cwd, input, timeoutMs = 30000, maxBytes = 8 * 1024 * 1024, env, baseEnv = process.env } = {}) {
  if (!ALLOWED.has(bin)) return Promise.reject(new Error(`binary not allowed: ${bin}`));
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
    return Promise.reject(new TypeError("args must be an array of strings"));
  }
  const posix = process.platform !== "win32";
  return new Promise((resolve, reject) => {
    const child = spawn(resolveBin(bin), args, { cwd, env: { ...baseEnv, ...env }, detached: posix, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let size = 0;
    let failure = null;
    const kill = () => {
      try {
        if (posix && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const timer = setTimeout(() => {
      failure = new Error(`${bin} timed out after ${timeoutMs}ms`);
      failure.timedOut = true;
      kill();
    }, timeoutMs);
    const collect = (name) => (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        if (!failure) {
          failure = new Error(`${bin} output exceeded ${maxBytes} bytes`);
          failure.code = "ERR_MAXBUFFER";
        }
        kill();
        return;
      }
      if (name === "out") stdout += chunk;
      else stderr += chunk;
    };
    child.stdout.setEncoding("utf8").on("data", collect("out"));
    child.stderr.setEncoding("utf8").on("data", collect("err"));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (failure) return reject(failure);
      if (code === null) return reject(new Error(`${bin} terminated by ${signal}`));
      resolve({ code, stdout, stderr });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input === undefined ? undefined : String(input));
  });
}

export function git(cwd, args, opts = {}) {
  if (!Array.isArray(args) || typeof args[0] !== "string" || args[0].startsWith("-")) {
    return Promise.reject(new Error("git requires a subcommand as the first argument"));
  }
  return run("git", [...GIT_FLAGS, ...args], { ...opts, cwd, baseEnv: gitEnv(process.env) });
}

export function gh(args, opts = {}) {
  const { env, ...rest } = opts;
  return run("gh", args, { ...rest, baseEnv: ghEnv(process.env, env) });
}

export function claude(args, opts = {}) {
  const { env, ...rest } = opts;
  return run("claude", args, { ...rest, baseEnv: claudeEnv(process.env, env) });
}
