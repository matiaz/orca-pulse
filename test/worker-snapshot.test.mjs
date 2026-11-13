import test from "node:test";
import assert from "node:assert/strict";
import { buildSnapshot, limitsView, trimDays } from "../src/worker/snapshot.mjs";

const NOW = new Date(2026, 10, 10, 12).getTime();
const day = (back) => {
  const date = new Date(2026, 10, 10);
  date.setDate(date.getDate() - back);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
};

function input(overrides = {}) {
  const days = {};
  for (let back = 0; back < 1000; back++) days[day(back)] = [back, back % 5];
  return {
    view: { source: "github", offset: 0 },
    github: { login: "me", days, updatedAt: "2026-11-10T10:00:00.000Z", error: null, hint: null },
    claude: { days: {}, updatedAt: null, error: null, hint: null },
    limits: { enabled: false },
    pulls: { items: Array.from({ length: 150 }, (_, i) => ({ url: `https://github.com/a/b/pull/${i + 1}`, number: i + 1, repo: "a/b", title: "t", action: "waiting" })), updatedAt: "2026-11-10T11:00:00.000Z", error: null, hint: null },
    git: { visible: false, updatedAt: "x", repos: [], selected: null },
    now: NOW,
    ...overrides,
  };
}

test("heatmap days are trimmed to about 400 days", () => {
  const snapshot = buildSnapshot(input());
  const count = Object.keys(snapshot.heatmap.github.days).length;
  assert.ok(count > 390 && count <= 410, String(count));
  assert.ok(day(0) in snapshot.heatmap.github.days);
  assert.ok(!(day(600) in snapshot.heatmap.github.days));
});

test("offset moves the kept window back", () => {
  const snapshot = buildSnapshot(input({ view: { source: "github", offset: 52 } }));
  assert.ok(day(52 * 7) in snapshot.heatmap.github.days);
  assert.ok(!(day(0) in snapshot.heatmap.github.days));
  assert.equal(snapshot.heatmap.offset, 52);
});

test("pulls are capped at 100 and git updatedAt is dropped", () => {
  const snapshot = buildSnapshot(input());
  assert.equal(snapshot.pulls.items.length, 100);
  assert.equal("updatedAt" in snapshot.git, false);
  assert.equal(snapshot.updatedAt, "2026-11-10T11:00:00.000Z");
});

test("git file lists are trimmed and counted in more", () => {
  const files = Array.from({ length: 300 }, (_, i) => ({ path: `f${i}`, kind: "modified", staged: "unstaged" }));
  const snapshot = buildSnapshot(input({ git: { visible: true, selected: { files, more: 5 } } }));
  assert.equal(snapshot.git.selected.files.length, 100);
  assert.equal(snapshot.git.selected.more, 205);
});

test("snapshot stays under the byte limit", () => {
  const huge = "x".repeat(2000);
  const items = Array.from({ length: 150 }, (_, i) => ({ url: `https://github.com/a/b/pull/${i + 1}`, number: i + 1, repo: "a/b", title: huge, action: "waiting" }));
  const snapshot = buildSnapshot(input({ pulls: { items, error: null, hint: null } }), 200 * 1024);
  assert.ok(JSON.stringify(snapshot).length <= 200 * 1024);
});

test("limitsView adds reset labels only when enabled", () => {
  assert.deepEqual(limitsView({ enabled: false }, NOW), { enabled: false });
  const view = limitsView({ enabled: true, fiveHour: { pct: 50, resetsAt: new Date(NOW + 90 * 60000).toISOString() }, sevenDay: null }, NOW);
  assert.equal(view.fiveHour.resetLabel, "resets in 1h 30m");
  assert.equal(view.sevenDay, null);
});

test("trimDays ignores bad containers", () => {
  assert.deepEqual(trimDays(undefined, new Date(NOW), 400), {});
});

test("focus passes through and defaults to unresolved", () => {
  assert.deepEqual(buildSnapshot(input()).focus, { via: null, workspaceId: null, candidates: [] });
  const focus = { via: "terminal", workspaceId: "w1", candidates: [] };
  assert.deepEqual(buildSnapshot(input({ focus })).focus, focus);
});
