import test from "node:test";
import assert from "node:assert/strict";
import { createScheduler } from "../src/worker/scheduler.mjs";

function fakeTimers() {
  const log = { set: [], cleared: [] };
  return {
    log,
    setInterval(fn, ms) {
      const handle = { fn, ms, unref() { this.unrefd = true; } };
      log.set.push(handle);
      return handle;
    },
    clearInterval(handle) {
      log.cleared.push(handle);
    },
  };
}

test("tasks never overlap and respect their interval", async () => {
  let clock = 0;
  let release;
  let runs = 0;
  const gate = new Promise((resolve) => (release = resolve));
  const scheduler = createScheduler({ now: () => clock, timers: fakeTimers(), tasks: [{ name: "slow", everyMs: 1000, run: () => { runs++; return gate; } }] });
  const first = scheduler.tick();
  await Promise.resolve();
  clock += 5000;
  await scheduler.tick();
  assert.equal(runs, 1);
  release();
  await first;
  runs = 1;
  clock = 5000;
  await scheduler.tick();
  assert.equal(runs, 2);
  clock = 5500;
  await scheduler.tick();
  assert.equal(runs, 2);
  clock = 6100;
  await scheduler.tick();
  assert.equal(runs, 3);
});

test("when() gates a task and errors are contained", async () => {
  const errors = [];
  let allowed = false;
  let ran = 0;
  const scheduler = createScheduler({
    now: () => 0,
    timers: fakeTimers(),
    onError: (name) => errors.push(name),
    tasks: [
      { name: "gated", when: () => allowed, run: () => { ran++; } },
      { name: "bad", run: () => { throw new Error("x"); } },
    ],
  });
  await scheduler.tick();
  assert.equal(ran, 0);
  assert.deepEqual(errors, ["bad"]);
  allowed = true;
  await scheduler.tick();
  assert.equal(ran, 1);
});

test("start unrefs the interval and stop clears it", () => {
  const timers = fakeTimers();
  const scheduler = createScheduler({ tasks: [], timers });
  scheduler.start();
  scheduler.start();
  assert.equal(timers.log.set.length, 1);
  assert.equal(timers.log.set[0].unrefd, true);
  assert.equal(timers.log.set[0].ms, 1000);
  scheduler.stop();
  assert.deepEqual(timers.log.cleared, timers.log.set);
  assert.equal(scheduler.isRunning(), false);
});
