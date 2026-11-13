import { addDays, isoDay } from "../lib/days.mjs";
import { resetLabel } from "../sources/limits.mjs";

export const MAX_BYTES = 200 * 1024;
const STEPS = [
  { span: 400, pulls: 100, files: 100 },
  { span: 200, pulls: 50, files: 50 },
  { span: 90, pulls: 25, files: 25 },
];

export function startOfDay(ms) {
  const date = new Date(ms);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export function trimDays(days, anchor, span) {
  const from = isoDay(addDays(anchor, -span));
  const to = isoDay(addDays(anchor, 7));
  const out = {};
  for (const [day, value] of Object.entries(days ?? {})) {
    if (day >= from && day <= to) out[day] = value;
  }
  return out;
}

function windowView(window, now) {
  return window ? { pct: window.pct, resetsAt: window.resetsAt, resetLabel: resetLabel(window.resetsAt, now) } : null;
}

export function limitsView(limits, now) {
  if (!limits?.enabled) return { enabled: false };
  return {
    enabled: true,
    fiveHour: windowView(limits.fiveHour, now),
    sevenDay: windowView(limits.sevenDay, now),
    updatedAt: limits.updatedAt ?? null,
    backoffUntil: limits.backoffUntil ?? null,
    error: limits.error ?? null,
    hint: limits.hint ?? null,
  };
}

function gitView(git, files) {
  const { updatedAt, ...rest } = git ?? {};
  if (!rest.selected) return rest;
  const all = rest.selected.files ?? [];
  const kept = all.slice(0, files);
  return { ...rest, selected: { ...rest.selected, files: kept, more: (rest.selected.more ?? 0) + all.length - kept.length } };
}

function latest(values) {
  const present = values.filter((value) => typeof value === "string");
  return present.length ? present.reduce((a, b) => (a > b ? a : b)) : null;
}

function build({ view, github, claude, limits, pulls, git, focus, now }, step) {
  const anchor = addDays(startOfDay(now), -7 * view.offset);
  const items = Array.isArray(pulls?.items) ? pulls.items.slice(0, step.pulls) : [];
  return {
    heatmap: {
      source: view.source,
      offset: view.offset,
      github: { ...github, days: trimDays(github?.days, anchor, step.span) },
      claude: { ...claude, days: trimDays(claude?.days, anchor, step.span) },
    },
    limits: limitsView(limits, now),
    pulls: { ...pulls, items },
    git: gitView(git, step.files),
    focus: focus ?? { via: null, workspaceId: null, candidates: [] },
    updatedAt: latest([github?.updatedAt, claude?.updatedAt, pulls?.updatedAt, limits?.updatedAt]),
  };
}

export function buildSnapshot(input, maxBytes = MAX_BYTES) {
  let snapshot = null;
  for (const step of STEPS) {
    snapshot = build(input, step);
    if (JSON.stringify(snapshot).length <= maxBytes) return snapshot;
  }
  return snapshot;
}
