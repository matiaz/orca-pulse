const ID = /^[\w:.-]{1,200}$/;
const FILE = "terminals.json";
const WRITE_DELAY_MS = 2000;

const valid = (value) => typeof value === "string" && ID.test(value);

export function createTerminalMap({ readJson, writeJson, now = Date.now, max = 500, timers = { setTimeout, clearTimeout } }) {
  const entries = new Map();
  let timer = null;
  let dirty = false;
  let last = 0;

  function trim() {
    while (entries.size > max) {
      let oldest = null;
      for (const [key, entry] of entries) if (oldest === null || entry.at < entries.get(oldest).at) oldest = key;
      entries.delete(oldest);
    }
  }

  function load() {
    let stored = null;
    try {
      stored = readJson(FILE, null);
    } catch {
      return;
    }
    const list = Array.isArray(stored?.entries) ? stored.entries : [];
    const accepted = [];
    for (const item of list) {
      if (!item || typeof item !== "object") continue;
      if (!valid(item.terminalId) || !valid(item.workspaceId) || !Number.isFinite(item.at)) continue;
      accepted.push({ terminalId: item.terminalId, workspaceId: item.workspaceId, at: item.at });
    }
    accepted.sort((a, b) => a.at - b.at);
    for (const item of accepted) entries.set(item.terminalId, { workspaceId: item.workspaceId, at: item.at });
    for (const entry of entries.values()) last = Math.max(last, entry.at);
    trim();
  }

  function write() {
    timer = null;
    if (!dirty) return;
    dirty = false;
    try {
      writeJson(FILE, { entries: [...entries].map(([terminalId, entry]) => ({ terminalId, workspaceId: entry.workspaceId, at: entry.at })) });
    } catch {}
  }

  function schedule() {
    dirty = true;
    if (timer) return;
    timer = timers.setTimeout(write, WRITE_DELAY_MS);
    timer?.unref?.();
  }

  load();

  return {
    learn(terminalId, workspaceId) {
      if (!valid(terminalId) || !valid(workspaceId)) return;
      const stamp = Math.max(now(), last + 1);
      last = stamp;
      entries.delete(terminalId);
      entries.set(terminalId, { workspaceId, at: stamp });
      trim();
      schedule();
    },
    resolve(terminalIds) {
      if (!Array.isArray(terminalIds)) return null;
      let best = null;
      for (const id of terminalIds) {
        const entry = typeof id === "string" ? entries.get(id) : undefined;
        if (entry && (best === null || entry.at > best.at)) best = entry;
      }
      return best ? best.workspaceId : null;
    },
    prune(validWorkspaceIds) {
      const keep = new Set(validWorkspaceIds);
      let changed = false;
      for (const [key, entry] of entries) {
        if (!keep.has(entry.workspaceId)) {
          entries.delete(key);
          changed = true;
        }
      }
      if (changed) schedule();
    },
    flush() {
      if (timer) timers.clearTimeout(timer);
      write();
    },
  };
}
