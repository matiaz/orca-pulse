import { isLocal, matchRepo } from "../lib/workspaces.mjs";

const lower = (value) => String(value ?? "").toLowerCase();

function slugOf(item, remotes) {
  const slug = remotes?.[item.path];
  return typeof slug === "string" && slug ? lower(slug) : null;
}

function keepRepos(items, slugs) {
  return items.filter((item) => slugs.has(lower(item.repo)));
}

export function scopePulls(items, { scope, workspaces, remotes, focusedId }) {
  const list = Array.isArray(items) ? items : [];
  const local = (Array.isArray(workspaces) ? workspaces : []).filter(isLocal);
  if (scope === "all") return { items: list, scope: { mode: "all", reason: null } };
  if (scope === "workspace") {
    const focused = focusedId ? local.find((item) => item.id === focusedId) : null;
    if (!focused) return { items: [], scope: { mode: "workspace", reason: "no-workspace" } };
    const slug = slugOf(focused, remotes);
    if (!slug) return { items: [], scope: { mode: "workspace", reason: "no-remote" } };
    return { items: keepRepos(list, new Set([slug])), scope: { mode: "workspace", reason: null } };
  }
  const slugs = new Set(local.map((item) => slugOf(item, remotes)).filter(Boolean));
  return { items: keepRepos(list, slugs), scope: { mode: "open", reason: null } };
}

export function pickReview(items, { workspaces, remotes, store }) {
  const list = Array.isArray(workspaces) ? workspaces : [];
  return (
    (Array.isArray(items) ? items : []).find(
      (item) =>
        item.requested === true &&
        item.isDraft !== true &&
        item.mine !== true &&
        item.viewerReview == null &&
        !store.has(item.url) &&
        matchRepo(item.repo, list, remotes, null) !== null,
    ) ?? null
  );
}

export function mergeKey(pr, method) {
  return `${pr.headRefOid}:${pr.mergeStateStatus}:${method}`;
}

export function canMerge(pr, entry, method) {
  if (!entry || entry.launchError) return false;
  if (entry.mergeKey === mergeKey(pr, method)) return false;
  if ((pr.state ?? "OPEN") !== "OPEN" || pr.isDraft === true) return false;
  if (typeof pr.headRefOid !== "string" || !pr.headRefOid) return false;
  return (
    pr.reviewDecision === "APPROVED" &&
    pr.viewerReview?.state === "APPROVED" &&
    pr.viewerReview.oid === pr.headRefOid &&
    pr.mergeStateStatus === "CLEAN" &&
    pr.checks === "SUCCESS"
  );
}

export function pickMerge(items, store, method) {
  return (Array.isArray(items) ? items : []).find((item) => canMerge(item, store.get(item.url), method)) ?? null;
}
