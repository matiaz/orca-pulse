export function createScheduler({ tasks, before, now = Date.now, timers = globalThis, tickMs = 1000, onError = () => {} }) {
  const state = tasks.map((task) => ({ task, last: -Infinity, running: null }));
  let handle = null;

  function startDue() {
    const started = [];
    for (const item of state) {
      if (item.running) continue;
      if (now() - item.last < (item.task.everyMs ?? 0)) continue;
      let wanted = true;
      try {
        wanted = item.task.when ? Boolean(item.task.when()) : true;
      } catch {
        wanted = false;
      }
      if (!wanted) continue;
      item.last = now();
      item.running = Promise.resolve()
        .then(() => item.task.run())
        .catch((error) => onError(item.task.name, error))
        .finally(() => {
          item.running = null;
        });
      started.push(item.running);
    }
    return started;
  }

  async function tick() {
    if (before) {
      try {
        await before();
      } catch (error) {
        onError("before", error);
      }
    }
    return Promise.all(startDue());
  }

  return {
    tick,
    start() {
      if (handle) return;
      handle = timers.setInterval(() => {
        tick().catch(() => {});
      }, tickMs);
      handle?.unref?.();
    },
    stop() {
      if (!handle) return;
      timers.clearInterval(handle);
      handle = null;
    },
    isRunning: () => handle !== null,
  };
}
