import test from "node:test";
import assert from "node:assert/strict";
import { statusSummary } from "../src/worker/status.mjs";

const pr = (action) => ({ action });
const limits = (five, seven = 0) => ({ enabled: true, fiveHour: { pct: five }, sevenDay: { pct: seven } });

test("empty list says nothing is waiting", () => {
  const s = statusSummary({ items: [] }, { enabled: false });
  assert.equal(s.text, "No PRs waiting");
  assert.equal(s.tone, "neutral");
});

test("top action is counted by priority", () => {
  assert.equal(statusSummary({ items: [pr("merge"), pr("merge"), pr("review")] }).text, "2 to merge");
  assert.equal(statusSummary({ items: [pr("review"), pr("review"), pr("review")] }).text, "3 to review");
  assert.equal(statusSummary({ items: [pr("ci failed"), pr("review")] }).text, "1 CI failed");
  assert.equal(statusSummary({ items: [pr("waiting"), pr("draft")] }).text, "No PRs waiting");
});

test("tone follows severity", () => {
  assert.equal(statusSummary({ items: [pr("ci failed")] }).tone, "danger");
  assert.equal(statusSummary({ items: [pr("conflict")] }).tone, "warning");
  assert.equal(statusSummary({ items: [pr("changes")] }).tone, "warning");
  assert.equal(statusSummary({ items: [pr("merge")] }).tone, "success");
  assert.equal(statusSummary({ items: [pr("merge"), pr("conflict")] }).tone, "warning");
  assert.equal(statusSummary({ items: [pr("review")] }).tone, "neutral");
});

test("limits add the 5h percent and raise the tone", () => {
  assert.equal(statusSummary({ items: [] }, limits(72)).text, "No PRs waiting · 72%");
  assert.equal(statusSummary({ items: [] }, limits(72)).tone, "warning");
  assert.equal(statusSummary({ items: [pr("merge")] }, limits(95)).tone, "danger");
  assert.equal(statusSummary({ items: [pr("merge")] }, limits(10, 91)).tone, "danger");
  assert.equal(statusSummary({ items: [] }, { enabled: false }).text, "No PRs waiting");
});

test("fetch failure without items is not reported as empty", () => {
  assert.equal(statusSummary({ items: [], error: "gh not found" }).text, "PRs unavailable");
});

test("output only uses icons and tones Orca accepts", () => {
  const icons = new Set(["activity", "error", "warning", "check"]);
  const tones = new Set(["neutral", "accent", "success", "warning", "danger"]);
  for (const items of [[], [pr("merge")], [pr("ci failed")], [pr("conflict")]]) {
    const s = statusSummary({ items });
    assert.ok(icons.has(s.icon) && tones.has(s.tone));
    assert.ok(s.tooltip.length <= 200);
  }
});
