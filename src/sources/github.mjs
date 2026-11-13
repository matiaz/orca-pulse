import { clean } from "../lib/sanitize.mjs";
import { addDays, eachDay, isoDay } from "../lib/days.mjs";
import { describeError, ghGraphql } from "../lib/ghcall.mjs";

const CACHE_FILE = "github.json";
const REFETCH_TODAY_MS = 10 * 60 * 1000;
const RETRY_AFTER_FAILURE_MS = 60 * 1000;
const MAX_QUERY_DAYS = 364;
const MAX_HISTORY_YEARS = 5;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const LEVELS = { NONE: 0, FIRST_QUARTILE: 1, SECOND_QUARTILE: 2, THIRD_QUARTILE: 3, FOURTH_QUARTILE: 4 };
const QUERY = `query($from: DateTime!, $to: DateTime!) {
  viewer {
    login
    contributionsCollection(from: $from, to: $to) {
      contributionCalendar { weeks { contributionDays { date contributionCount contributionLevel } } }
    }
  }
}`;

export function chunkRanges(from, to) {
  const ranges = [];
  for (let start = new Date(from); start <= to; start = addDays(start, MAX_QUERY_DAYS + 1)) {
    const end = addDays(start, MAX_QUERY_DAYS);
    ranges.push({ from: start, to: end < to ? end : new Date(to) });
  }
  return ranges;
}

export function mergeDays(cache, weeks) {
  const merged = { ...cache };
  for (const week of Array.isArray(weeks) ? weeks : []) {
    for (const day of week?.contributionDays ?? []) {
      if (!day || typeof day.date !== "string" || !DAY.test(day.date)) continue;
      if (!Number.isSafeInteger(day.contributionCount) || day.contributionCount < 0) continue;
      merged[day.date] = [day.contributionCount, Object.hasOwn(LEVELS, day.contributionLevel) ? LEVELS[day.contributionLevel] : 0];
    }
  }
  return merged;
}

function reviveDays(days) {
  const out = {};
  if (!days || typeof days !== "object") return out;
  for (const [date, value] of Object.entries(days)) {
    if (!DAY.test(date) || !Array.isArray(value)) continue;
    const [count, level] = value;
    if (Number.isSafeInteger(count) && count >= 0 && Number.isInteger(level) && level >= 0 && level <= 4) out[date] = [count, level];
  }
  return out;
}

export function createGithub({ gh, readJson, writeJson, now = Date.now }) {
  let cached = null;
  let error = null;
  try {
    cached = readJson(CACHE_FILE, null);
  } catch {
    error = "cache unreadable";
  }
  const cache = {
    login: typeof cached?.login === "string" ? clean(cached.login) : null,
    days: reviveDays(cached?.days),
    recentAt: Number.isFinite(cached?.recentAt) ? cached.recentAt : 0,
  };
  let updatedAt = Number.isFinite(cached?.recentAt) && cached.recentAt > 0 ? cached.recentAt : 0;
  let failedAt = 0;
  let hint = null;
  let tail = null;
  let tailKey = null;

  function containsToday(range) {
    const today = isoDay(new Date(now()));
    return isoDay(range.from) <= today && today <= isoDay(range.to);
  }

  function needsFetch(range, force) {
    if (force) return true;
    if (containsToday(range) && now() - cache.recentAt > REFETCH_TODAY_MS) return true;
    let missing = false;
    eachDay(range.from, range.to, (day) => {
      missing ||= !(day in cache.days);
    });
    return missing;
  }

  async function fetchChunk(range) {
    const data = await ghGraphql(gh, [
      "-f", `query=${QUERY}`,
      "-f", `from=${isoDay(range.from)}T00:00:00`,
      "-f", `to=${isoDay(range.to)}T23:59:59`,
    ]);
    const viewer = data.viewer;
    const weeks = viewer?.contributionsCollection?.contributionCalendar?.weeks;
    if (!viewer || !Array.isArray(weeks)) throw new Error("unexpected response from gh");
    if (typeof viewer.login === "string") cache.login = clean(viewer.login);
    cache.days = mergeDays(cache.days, weeks);
    if (containsToday(range)) cache.recentAt = now();
    updatedAt = now();
  }

  async function run(range, force) {
    if (!force && failedAt && now() - failedAt < RETRY_AFTER_FAILURE_MS) return;
    try {
      for (const chunk of chunkRanges(range.from, range.to)) {
        if (!needsFetch(chunk, force)) continue;
        await fetchChunk(chunk);
        try {
          writeJson(CACHE_FILE, cache);
        } catch {}
      }
      error = null;
      hint = null;
      failedAt = 0;
    } catch (failure) {
      failedAt = now();
      ({ error, hint } = describeError(failure));
    }
  }

  function resolveRange(from, to) {
    const end = to ?? new Date(now());
    const earliest = new Date(end);
    earliest.setFullYear(earliest.getFullYear() - MAX_HISTORY_YEARS);
    const start = from ?? addDays(end, -MAX_QUERY_DAYS);
    return { from: start < earliest ? earliest : start, to: end };
  }

  return {
    sync(force = false, { from, to } = {}) {
      const range = resolveRange(from, to);
      const key = `${isoDay(range.from)}:${isoDay(range.to)}:${force}`;
      if (tail && tailKey === key) return tail;
      const job = (tail ?? Promise.resolve()).then(() => run(range, force));
      tail = job;
      tailKey = key;
      job.finally(() => {
        if (tail === job) {
          tail = null;
          tailKey = null;
        }
      });
      return job;
    },
    snapshot() {
      return {
        login: cache.login,
        days: { ...cache.days },
        updatedAt: updatedAt ? new Date(updatedAt).toISOString() : null,
        error,
        hint,
      };
    },
  };
}
