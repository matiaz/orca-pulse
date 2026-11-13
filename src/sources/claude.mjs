import fsp from "node:fs/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isoDay } from "../lib/days.mjs";
import { clean } from "../lib/sanitize.mjs";
import { quartileLevels } from "../lib/store.mjs";

const SCAN_FILE = "claude-scan.json";
const HISTORY_FILE = "claude-history.json";
const RESCAN_AFTER_MS = 30 * 1000;
const MAX_LINE_BYTES = 2 * 1024 * 1024;
const READ_CHUNK_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_FILES = 5000;
const DEFAULT_MAX_DEPTH = 6;
const MAX_SEEN = 200000;
const MAX_PER_DIR = 2000;
const MAX_TOKENS = 1e10;
const MAX_KEY_LENGTH = 200;
const MIN_TIME = Date.UTC(2000, 0, 1);
const DAY_MS = 24 * 3600 * 1000;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const PRICES = Object.entries({
  "claude-fable-5-1": [10, 50, 0.25],
  "claude-fable-5": [10, 50, 1],
  "claude-opus-5-5": [4, 20, 0.2],
  "claude-opus-5": [5, 25, 0.5],
  "claude-opus-4-8": [5, 25, 0.5],
  "claude-opus-4-7": [5, 25, 0.5],
  "claude-opus-4-6": [5, 25, 0.5],
  "claude-sonnet-5-5": [2, 10, 0.2],
  "claude-sonnet-5": [2, 10, 0.2],
  "claude-sonnet-4-6": [3, 15, 0.3],
  "claude-haiku-4-5": [1, 5, 0.1],
}).sort(([a], [b]) => b.length - a.length);

const num = (value) => (Number.isFinite(value) && value > 0 ? Math.min(value, MAX_TOKENS) : 0);

function priceFor(model) {
  if (typeof model !== "string") return undefined;
  return PRICES.find(([prefix]) => model.startsWith(prefix))?.[1];
}

export function costOf(usage, model, speed) {
  const price = priceFor(model);
  if (!price || !usage || typeof usage !== "object") return 0;
  const [input, output, cacheRead] = price;
  const written = num(usage.cache_creation_input_tokens);
  const oneHour = num(usage.cache_creation?.ephemeral_1h_input_tokens);
  const fiveMinutes = usage.cache_creation && typeof usage.cache_creation === "object" ? num(usage.cache_creation.ephemeral_5m_input_tokens) : written;
  const dollars =
    (num(usage.input_tokens) * input +
      num(usage.output_tokens) * output +
      fiveMinutes * input * 1.25 +
      oneHour * input * 2 +
      num(usage.cache_read_input_tokens) * cacheRead) /
    1e6;
  return speed === "fast" ? dollars * 2 : dollars;
}

export function parseLines(text, seen = new Map(), { maxSeen = MAX_SEEN, now = Date.now() } = {}) {
  const byDay = {};
  for (const raw of String(text).split("\n")) {
    if (!raw || Buffer.byteLength(raw) > MAX_LINE_BYTES || !raw.includes('"usage"')) continue;
    let record;
    try {
      record = JSON.parse(raw);
    } catch {
      continue;
    }
    const message = record?.message;
    const usage = message?.usage;
    if (record?.type !== "assistant" || !usage || typeof message.id !== "string" || !message.id || !record.timestamp) continue;
    const requestId = record.requestId;
    if (requestId !== undefined && typeof requestId !== "string") continue;
    if (message.id.length > MAX_KEY_LENGTH || (requestId?.length ?? 0) > MAX_KEY_LENGTH) continue;
    const when = new Date(record.timestamp);
    const time = when.getTime();
    if (Number.isNaN(time) || time < MIN_TIME || time > now + DAY_MS) continue;
    const key = `${message.id}:${requestId}`;
    const cost = costOf(usage, message.model, usage.speed);
    if (!Number.isFinite(cost)) continue;
    const previous = seen.get(key)?.[1] ?? 0;
    if (cost <= previous) continue;
    const day = isoDay(when);
    seen.set(key, [day, cost]);
    byDay[day] = (byDay[day] ?? 0) + (cost - previous);
    while (seen.size > maxSeen) seen.delete(seen.keys().next().value);
  }
  return { byDay, seen };
}

export function splitComplete(buffer) {
  const last = buffer.lastIndexOf(0x0a);
  if (last < 0) return { text: "", consumed: 0 };
  return { text: buffer.subarray(0, last + 1).toString("utf8"), consumed: last + 1 };
}

export function resolveConfigDir(setting, env, home) {
  const usable = (value) => typeof value === "string" && value.trim() && path.isAbsolute(value.trim());
  if (usable(setting)) return setting.trim();
  if (usable(env?.CLAUDE_CONFIG_DIR)) return env.CLAUDE_CONFIG_DIR.trim();
  return path.join(home, ".claude");
}

export function defaultConfigDir(setting) {
  return resolveConfigDir(setting, process.env, os.homedir());
}

async function listTranscripts(root, maxFiles, maxDepth, maxPerDir) {
  const files = [];
  try {
    if ((await fsp.lstat(root)).isSymbolicLink()) return files;
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return files;
    throw error;
  }
  async function walk(dir, depth) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (depth === 0) throw error;
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    let inDir = 0;
    for (const entry of entries) {
      if (files.length >= maxFiles) return;
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < maxDepth) await walk(full, depth + 1);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl") && inDir < maxPerDir) {
        files.push(full);
        inDir++;
      }
    }
  }
  await walk(root, 0);
  return files;
}

function addInto(target, source) {
  for (const [day, cost] of Object.entries(source)) target.set(day, (target.get(day) ?? 0) + cost);
}

async function scanFile(file, known, seen, increments, openFile, parseOptions) {
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
  const handle = await openFile(file, flags);
  try {
    const info = await handle.stat();
    if (!info.isFile()) return null;
    const size = info.size;
    const from = known && known.o <= size ? known.o : 0;
    if (from === size) return { o: size };
    let position = from;
    let carry = Buffer.alloc(0);
    let skipping = false;
    while (position < size) {
      const length = Math.min(READ_CHUNK_BYTES, size - position);
      const chunk = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(chunk, 0, length, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      let data = skipping ? chunk.subarray(0, bytesRead) : Buffer.concat([carry, chunk.subarray(0, bytesRead)]);
      if (skipping) {
        const newline = data.indexOf(0x0a);
        if (newline < 0) {
          carry = Buffer.alloc(0);
          continue;
        }
        data = data.subarray(newline + 1);
        skipping = false;
      }
      const { text, consumed } = splitComplete(data);
      if (text) addInto(increments, parseLines(text, seen, parseOptions).byDay);
      carry = data.subarray(consumed);
      if (carry.length > MAX_LINE_BYTES) {
        carry = Buffer.alloc(0);
        skipping = true;
      }
    }
    return { o: position - carry.length };
  } finally {
    await handle.close();
  }
}

function reviveState(raw) {
  const files = new Map();
  const seen = new Map();
  const days = new Map();
  for (const [file, value] of Object.entries(raw?.files ?? {})) {
    if (Number.isSafeInteger(value?.o) && value.o >= 0) files.set(file, { o: value.o });
  }
  for (const entry of Array.isArray(raw?.seen) ? raw.seen : []) {
    if (Array.isArray(entry) && typeof entry[0] === "string" && DAY.test(entry[1]) && Number.isFinite(entry[2])) seen.set(entry[0], [entry[1], entry[2]]);
  }
  for (const [day, cost] of Object.entries(raw?.days ?? {})) {
    if (DAY.test(day) && Number.isFinite(cost) && cost >= 0) days.set(day, cost);
  }
  return { files, seen, days };
}

function serializeState({ files, seen, days }) {
  return {
    files: Object.fromEntries(files),
    seen: [...seen.entries()].map(([key, [day, cost]]) => [key, day, cost]),
    days: Object.fromEntries(days),
  };
}

export function createClaude({
  getConfigDir,
  readJson,
  writeJson,
  now = Date.now,
  maxFiles = DEFAULT_MAX_FILES,
  maxDepth = DEFAULT_MAX_DEPTH,
  maxPerDir = MAX_PER_DIR,
  maxSeen = MAX_SEEN,
  openFile = (file, flags) => fsp.open(file, flags),
}) {
  let error = null;
  const safeRead = (name) => {
    try {
      return readJson(name, null);
    } catch {
      error = "cache unreadable";
      return null;
    }
  };
  const state = reviveState(safeRead(SCAN_FILE));
  const history = new Map();
  for (const [day, cost] of Object.entries(safeRead(HISTORY_FILE)?.days ?? {})) {
    if (DAY.test(day) && Number.isFinite(cost) && cost >= 0) history.set(day, cost);
  }
  let scannedAt = null;
  let updatedAt = 0;
  let dirty = false;
  let pending = null;

  async function scan() {
    const root = path.join(getConfigDir(), "projects");
    const found = await listTranscripts(root, maxFiles, maxDepth, maxPerDir);
    const increments = new Map();
    const nextFiles = new Map();
    const parseOptions = { maxSeen, now: now() };
    let changed = false;
    for (const file of found) {
      const known = state.files.get(file);
      try {
        const result = await scanFile(file, known, state.seen, increments, openFile, parseOptions);
        if (!result) continue;
        nextFiles.set(file, result);
        if (result.o !== known?.o) changed = true;
      } catch {
        if (known) nextFiles.set(file, known);
      }
    }
    for (const file of state.files.keys()) if (!nextFiles.has(file)) changed = true;
    state.files = nextFiles;
    if (increments.size > 0) changed = true;
    for (const [day, cost] of increments) {
      state.days.set(day, (state.days.get(day) ?? 0) + cost);
    }
    for (const [day, cost] of state.days) history.set(day, Math.max(history.get(day) ?? 0, cost));
    if (!changed && !dirty) return;
    dirty = true;
    writeJson(SCAN_FILE, serializeState(state));
    writeJson(HISTORY_FILE, { days: Object.fromEntries(history) });
    dirty = false;
  }

  async function run() {
    try {
      await scan();
      error = null;
    } catch (failure) {
      error = clean(failure?.message) || "scan failed";
    }
    updatedAt = now();
  }

  return {
    sync(force = false) {
      if (pending) return pending;
      if (!force && scannedAt !== null && now() - scannedAt < RESCAN_AFTER_MS) return Promise.resolve();
      scannedAt = now();
      pending = run().finally(() => {
        pending = null;
      });
      return pending;
    },
    snapshot() {
      const levelOf = quartileLevels([...history.values()]);
      const days = {};
      for (const [day, cost] of history) days[day] = [cost, levelOf(cost)];
      return { days, updatedAt: updatedAt ? new Date(updatedAt).toISOString() : null, error, hint: null };
    },
  };
}
