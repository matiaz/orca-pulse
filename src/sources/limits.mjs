import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { run as execRun } from "../lib/exec.mjs";
import { defaultConfigDir } from "./claude.mjs";

const CACHE_FILE = "claude-limits.json";
const ENDPOINT = "https://api.anthropic.com/api/oauth/usage";
const KEYCHAIN_SERVICE = "Claude Code-credentials";
const INTERVAL_MS = 2 * 60 * 1000;
const BACKOFF_MS = 10 * 60 * 1000;
const TIMEOUT_MS = 10 * 1000;
const TOKEN_PATTERN = /^[\x21-\x7e]{1,4096}$/;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export const HINT_SIGN_IN = "Open Claude Code to refresh your sign-in";

function windowOf(entry) {
  if (!entry || typeof entry !== "object" || !Number.isFinite(entry.utilization)) return null;
  const parsed = typeof entry.resets_at === "string" ? new Date(entry.resets_at) : null;
  return {
    pct: Math.min(100, Math.max(0, entry.utilization)),
    resetsAt: parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : null,
  };
}

export function parseLimits(json) {
  const source = json && typeof json === "object" ? json : {};
  return { fiveHour: windowOf(source.five_hour), sevenDay: windowOf(source.seven_day) };
}

const pad = (value) => String(value).padStart(2, "0");

export function resetLabel(iso, now) {
  const target = typeof iso === "string" ? Date.parse(iso) : NaN;
  if (Number.isNaN(target)) return null;
  const diff = target - (now instanceof Date ? now.getTime() : now);
  if (diff <= 0) return "resets now";
  if (diff < 24 * 3600 * 1000) {
    const hours = Math.floor(diff / 3600000);
    const minutes = Math.floor((diff % 3600000) / 60000);
    if (hours > 0) return `resets in ${hours}h ${minutes}m`;
    return minutes > 0 ? `resets in ${minutes}m` : "resets in <1m";
  }
  const date = new Date(target);
  return `resets ${WEEKDAYS[date.getDay()]} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function credentialsFrom(raw) {
  try {
    const oauth = JSON.parse(raw)?.claudeAiOauth;
    if (typeof oauth?.accessToken !== "string") return null;
    return { accessToken: oauth.accessToken, expiresAt: Number.isFinite(oauth.expiresAt) ? oauth.expiresAt : null };
  } catch {
    return null;
  }
}

function osUserName() {
  try {
    return os.userInfo().username || null;
  } catch {
    return null;
  }
}

export function createTokenReader({ platform = process.platform, run = execRun, readFile = (file) => fsp.readFile(file, "utf8"), getConfigDir = defaultConfigDir, userName = osUserName } = {}) {
  async function keychain(account) {
    const args = ["find-generic-password", "-s", KEYCHAIN_SERVICE, ...(account ? ["-a", account] : []), "-w"];
    const result = await run("security", args, { timeoutMs: TIMEOUT_MS });
    return result.code === 0 ? credentialsFrom(result.stdout) : null;
  }
  return async function readToken() {
    if (platform === "darwin") {
      const account = userName();
      return (account ? await keychain(account) : null) ?? (await keychain(null));
    }
    try {
      return credentialsFrom(await readFile(path.join(getConfigDir(), ".credentials.json")));
    } catch {
      return null;
    }
  };
}

function toRaw(window) {
  return window ? { utilization: window.pct, resets_at: window.resetsAt } : null;
}

export function createLimits({ enabled, readToken, fetch: fetchImpl = globalThis.fetch, now = Date.now, readJson, writeJson, getConfigDir, run }) {
  const tokenReader = readToken ?? createTokenReader({ getConfigDir, run });
  const isEnabled = () => {
    try {
      return Boolean(enabled());
    } catch {
      return false;
    }
  };
  let cache = null;
  let attemptedAt = 0;
  let backoffUntil = 0;
  let error = null;
  let hint = null;
  let pending = null;

  function load() {
    if (cache) return cache;
    let stored = null;
    try {
      stored = readJson(CACHE_FILE, null);
    } catch {
      error = "cache unreadable";
    }
    cache = {
      five_hour: toRaw(windowOf(stored?.five_hour)),
      seven_day: toRaw(windowOf(stored?.seven_day)),
      fetchedAt: Number.isFinite(stored?.fetchedAt) ? stored.fetchedAt : 0,
      backoffUntil: Number.isFinite(stored?.backoffUntil) ? stored.backoffUntil : 0,
    };
    attemptedAt = cache.fetchedAt;
    backoffUntil = cache.backoffUntil;
    if (backoffUntil > now() && typeof stored?.error === "string") {
      error = stored.error.slice(0, 120);
      hint = stored.hint === HINT_SIGN_IN ? HINT_SIGN_IN : null;
    }
    return cache;
  }

  function persist() {
    cache = { ...cache, backoffUntil, error, hint };
    try {
      writeJson(CACHE_FILE, cache);
    } catch {}
  }

  function fail(message, nextHint = null, backoff = false) {
    error = message;
    hint = nextHint;
    if (backoff) {
      backoffUntil = now() + BACKOFF_MS;
      persist();
    }
  }

  async function fetchOnce() {
    attemptedAt = now();
    let credentials = null;
    try {
      credentials = await tokenReader();
    } catch {
      credentials = null;
    }
    if (typeof credentials === "string") credentials = { accessToken: credentials, expiresAt: null };
    let token = credentials?.accessToken;
    if (typeof token !== "string" || !TOKEN_PATTERN.test(token)) return fail("no Claude credentials found", HINT_SIGN_IN, true);
    if (Number.isFinite(credentials.expiresAt) && credentials.expiresAt < now()) return fail("Claude sign-in expired", HINT_SIGN_IN);
    let response;
    try {
      response = await fetchImpl(ENDPOINT, {
        headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" },
        redirect: "error",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (failure) {
      return fail(failure?.name === "TimeoutError" || failure?.name === "AbortError" ? "usage request timed out" : "usage request failed");
    }
    token = null;
    const status = Number.isInteger(response?.status) ? response.status : 0;
    if (!response?.ok) {
      const denied = status === 401 || status === 403;
      return fail(`usage request failed (${status})`, denied ? HINT_SIGN_IN : null, denied || status === 429);
    }
    let body;
    try {
      body = await response.json();
    } catch {
      return fail("usage response invalid");
    }
    const parsed = parseLimits(body);
    cache = { five_hour: toRaw(parsed.fiveHour), seven_day: toRaw(parsed.sevenDay), fetchedAt: now(), backoffUntil };
    error = null;
    hint = null;
    persist();
  }

  function snapshot() {
    if (!isEnabled()) return { enabled: false };
    const data = load();
    const parsed = parseLimits(data);
    return {
      enabled: true,
      fiveHour: parsed.fiveHour,
      sevenDay: parsed.sevenDay,
      updatedAt: data.fetchedAt ? new Date(data.fetchedAt).toISOString() : null,
      backoffUntil: backoffUntil > now() ? new Date(backoffUntil).toISOString() : null,
      error,
      hint,
    };
  }

  return {
    async sync(force = false) {
      if (!isEnabled()) return { enabled: false };
      load();
      if (pending) {
        await pending;
        return snapshot();
      }
      if (now() < backoffUntil || (!force && now() - attemptedAt < INTERVAL_MS)) return snapshot();
      pending = fetchOnce().finally(() => {
        pending = null;
      });
      await pending;
      return snapshot();
    },
    snapshot,
  };
}
