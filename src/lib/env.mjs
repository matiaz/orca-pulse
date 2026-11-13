import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let privateDir = null;

export function toolPath(base = process.env.PATH) {
  const extra = ["/opt/homebrew/bin", "/usr/local/bin", path.join(os.homedir(), ".local", "bin")];
  const existing = (base || "").split(path.delimiter).filter(Boolean);
  return [...new Set([...existing, ...extra])].join(path.delimiter);
}

export function applyToolPath() {
  process.env.PATH = toolPath(process.env.PATH);
}

function ownPrivateDir(dir) {
  try {
    const info = fs.lstatSync(dir);
    const uid = typeof process.getuid === "function" ? process.getuid() : info.uid;
    return info.isDirectory() && !info.isSymbolicLink() && info.uid === uid && (info.mode & 0o077) === 0;
  } catch {
    return false;
  }
}

export function privateTmpDir() {
  if (privateDir && ownPrivateDir(privateDir)) return privateDir;
  privateDir = fs.mkdtempSync(path.join(os.tmpdir(), "orca-pulse-"));
  return privateDir;
}

export function removePrivateTmpDir() {
  const dir = privateDir;
  privateDir = null;
  if (!dir) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
}
