import test from "node:test";
import assert from "node:assert/strict";
import { isoDay, addDays, eachDay } from "../src/lib/days.mjs";

test("isoDay formats local dates with padding", () => {
  assert.equal(isoDay(new Date(2026, 0, 5)), "2026-01-05");
  assert.equal(isoDay(new Date(2026, 11, 31, 23, 59)), "2026-12-31");
});

test("addDays crosses month and year boundaries and does not mutate", () => {
  const start = new Date(2026, 11, 30);
  assert.equal(isoDay(addDays(start, 3)), "2027-01-02");
  assert.equal(isoDay(addDays(start, -30)), "2026-11-30");
  assert.equal(isoDay(start), "2026-12-30");
});

test("eachDay is inclusive and ordered", () => {
  const seen = [];
  eachDay(new Date(2026, 1, 27), new Date(2026, 2, 2), (day) => seen.push(day));
  assert.deepEqual(seen, ["2026-02-27", "2026-02-28", "2026-03-01", "2026-03-02"]);
});

test("eachDay yields nothing when start is after end", () => {
  const seen = [];
  eachDay(new Date(2026, 1, 2), new Date(2026, 1, 1), (day) => seen.push(day));
  assert.deepEqual(seen, []);
});
