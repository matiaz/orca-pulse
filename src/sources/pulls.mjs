import { clean, isPullUrl } from "../lib/sanitize.mjs";
import { describeError, ghGraphql } from "../lib/ghcall.mjs";

const CACHE_FILE = "pulls.json";
const INTERVAL_MS = 2 * 60 * 1000;
const SEARCHES = {
  authored: "is:pr is:open archived:false author:@me",
  assigned: "is:pr is:open archived:false assignee:@me",
  review: "is:pr is:open archived:false review-requested:@me",
};
const QUERY = `query {
  viewer { login }
  ${Object.entries(SEARCHES).map(([alias, q]) => `${alias}: search(query: "${q}", type: ISSUE, first: 50) { nodes { ...pr } }`).join("\n  ")}
}
fragment pr on PullRequest {
  number title url isDraft updatedAt reviewDecision mergeable mergeStateStatus
  author { login }
  repository { nameWithOwner }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
}`;

export const ACTIONS = ["merge", "ci failed", "conflict", "changes", "update", "review", "ci running", "waiting", "draft"];
const NOTABLE = new Set(["merge", "ci failed"]);

export function actionOf(pr, viewer) {
  if (pr.reviewRequested && pr.author?.login !== viewer) return "review";
  if (pr.isDraft) return "draft";
  if (pr.mergeable === "CONFLICTING") return "conflict";
  const checks = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state;
  if (checks === "FAILURE" || checks === "ERROR") return "ci failed";
  if (pr.reviewDecision === "CHANGES_REQUESTED") return "changes";
  if (checks === "PENDING" || checks === "EXPECTED") return "ci running";
  if (pr.mergeStateStatus === "BEHIND") return "update";
  if (["CLEAN", "HAS_HOOKS", "UNSTABLE"].includes(pr.mergeStateStatus)) return "merge";
  return "waiting";
}

function priority(action) {
  const index = ACTIONS.indexOf(action);
  return index < 0 ? ACTIONS.length : index;
}

export function rankPulls(list) {
  return [...list].sort((a, b) => priority(a.action) - priority(b.action) || String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

export function diffNotable(prev, next) {
  if (!Array.isArray(prev)) return [];
  const before = new Map(prev.map((pr) => [pr.url, pr.action]));
  return next.filter((pr) => NOTABLE.has(pr.action) && before.get(pr.url) !== pr.action);
}

function normalize(data) {
  const viewer = data.viewer?.login;
  if (typeof viewer !== "string") throw new Error("unexpected response from gh");
  const byUrl = new Map();
  for (const alias of Object.keys(SEARCHES)) {
    for (const pr of data[alias]?.nodes ?? []) {
      if (!pr || !isPullUrl(pr.url) || !pr.repository || !Number.isSafeInteger(pr.number)) continue;
      const reviewRequested = alias === "review" || byUrl.get(pr.url)?.reviewRequested === true;
      const raw = { ...pr, reviewRequested };
      byUrl.set(pr.url, {
        reviewRequested,
        item: {
          url: pr.url,
          repo: clean(pr.repository.nameWithOwner),
          number: pr.number,
          title: clean(pr.title),
          action: actionOf(raw, viewer),
          isDraft: pr.isDraft === true,
          author: clean(pr.author?.login),
          updatedAt: clean(pr.updatedAt, 40),
          mine: pr.author?.login === viewer,
        },
      });
    }
  }
  return rankPulls([...byUrl.values()].map((entry) => entry.item));
}

function revive(items) {
  if (!Array.isArray(items)) return null;
  return items
    .filter((it) => it && isPullUrl(it.url) && Number.isSafeInteger(it.number))
    .map((it) => ({
      url: it.url,
      repo: clean(it.repo),
      number: it.number,
      title: clean(it.title),
      action: ACTIONS.includes(it.action) ? it.action : "waiting",
      isDraft: it.isDraft === true,
      author: clean(it.author),
      updatedAt: clean(it.updatedAt, 40),
      mine: it.mine === true,
    }));
}

export function createPulls({ gh, readJson, writeJson, now = Date.now }) {
  let cached = null;
  let error = null;
  try {
    cached = readJson(CACHE_FILE, null);
  } catch {
    error = "cache unreadable";
  }
  const cache = {
    items: revive(cached?.items),
    fetchedAt: Number.isFinite(cached?.fetchedAt) ? cached.fetchedAt : 0,
  };
  let attemptedAt = cache.fetchedAt;
  let hint = null;
  let pending = null;

  async function fetchOnce() {
    attemptedAt = now();
    try {
      const data = await ghGraphql(gh, ["-f", `query=${QUERY}`]);
      const items = normalize(data);
      const notable = diffNotable(cache.items, items);
      cache.items = items;
      cache.fetchedAt = attemptedAt;
      error = null;
      hint = null;
      try {
        writeJson(CACHE_FILE, cache);
      } catch {}
      return { notable };
    } catch (failure) {
      ({ error, hint } = describeError(failure));
      return { notable: [] };
    }
  }

  return {
    sync(force = false) {
      if (pending) return pending;
      if (!force && now() - attemptedAt < INTERVAL_MS) return Promise.resolve({ notable: [] });
      pending = fetchOnce().finally(() => {
        pending = null;
      });
      return pending;
    },
    snapshot() {
      return {
        items: (cache.items ?? []).map((item) => ({ ...item })),
        updatedAt: cache.fetchedAt ? new Date(cache.fetchedAt).toISOString() : null,
        error,
        hint,
      };
    },
  };
}
