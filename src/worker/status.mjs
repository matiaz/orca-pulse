import { ACTIONS } from "../sources/pulls.mjs";

const LABELS = {
  merge: (n) => `${n} to merge`,
  "ci failed": (n) => `${n} CI failed`,
  conflict: (n) => `${n} with conflicts`,
  changes: (n) => `${n} need changes`,
  update: (n) => `${n} to update`,
  review: (n) => `${n} to review`,
};
const ICONS = { danger: "error", warning: "warning", success: "check", neutral: "activity" };

function percentOf(window) {
  return Number.isFinite(window?.pct) ? window.pct : null;
}

export function statusSummary(pulls, limits) {
  const items = Array.isArray(pulls?.items) ? pulls.items : [];
  const counts = {};
  for (const item of items) counts[item.action] = (counts[item.action] ?? 0) + 1;
  const top = ACTIONS.find((action) => LABELS[action] && counts[action] > 0);
  const unavailable = items.length === 0 && Boolean(pulls?.error);
  let text = unavailable ? "PRs unavailable" : top ? LABELS[top](counts[top]) : "No PRs waiting";

  const enabled = limits?.enabled === true;
  const five = enabled ? percentOf(limits.fiveHour) : null;
  const seven = enabled ? percentOf(limits.sevenDay) : null;
  if (five !== null) text += ` · ${Math.round(five)}%`;
  const peak = Math.max(five ?? 0, seven ?? 0);

  let tone = "neutral";
  if (counts["ci failed"] || peak >= 90) tone = "danger";
  else if (peak >= 70 || counts.conflict || counts.changes) tone = "warning";
  else if (counts.merge) tone = "success";

  const parts = ACTIONS.filter((action) => counts[action] > 0).map((action) => `${counts[action]} ${action}`);
  if (unavailable) parts.push(String(pulls.error));
  if (five !== null) parts.push(`5h ${Math.round(five)}%`);
  if (seven !== null) parts.push(`7d ${Math.round(seven)}%`);
  const tooltip = (parts.join(", ") || "No pull requests").slice(0, 200);
  return { text, tone, tooltip, icon: ICONS[tone] };
}
