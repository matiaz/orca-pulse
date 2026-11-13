import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const NAME = /^[\w-][\w.-]*\.json$/;
let verified = null;

export function stateDir() {
  const xdg = process.env.XDG_STATE_HOME;
  const base = xdg && path.isAbsolute(xdg) ? xdg : path.join(os.homedir(), ".local", "state");
  const dir = path.join(base, "orca-pulse");
  if (verified === dir) return dir;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const info = fs.lstatSync(dir);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`state dir is a symlink or not a directory: ${dir}`);
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) throw new Error(`state dir not owned by current user: ${dir}`);
  fs.chmodSync(dir, 0o700);
  verified = dir;
  return dir;
}

function fileFor(name) {
  if (typeof name !== "string" || !NAME.test(name)) throw new Error(`invalid state file name: ${name}`);
  return path.join(stateDir(), name);
}

export function readJson(name, fallback) {
  const file = fileFor(name);
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

export function writeJson(name, value) {
  try {
    writeOnce(name, value);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    verified = null;
    writeOnce(name, value);
  }
}

function writeOnce(name, value) {
  const file = fileFor(name);
  const tmp = path.join(path.dirname(file), `.${name}.${crypto.randomBytes(6).toString("hex")}.tmp`);
  try {
    fs.writeFileSync(tmp, JSON.stringify(value), { flag: "wx", mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    throw error;
  }
}

export function quartileLevels(values) {
  const sorted = values.filter((v) => v > 0).sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  const [q1, q2, q3] = sorted.length ? [at(0.25), at(0.5), at(0.75)] : [0, 0, 0];
  return (value) => {
    if (!value) return 0;
    if (value <= q1) return 1;
    if (value <= q2) return 2;
    if (value <= q3) return 3;
    return 4;
  };
}
