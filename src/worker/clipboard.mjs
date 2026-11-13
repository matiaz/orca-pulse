import { run as defaultRun } from "../lib/exec.mjs";

const LINUX = [
  ["wl-copy", []],
  ["xclip", ["-selection", "clipboard"]],
  ["xsel", ["--clipboard", "--input"]],
];

export async function copyToClipboard(value, { platform = process.platform, run = defaultRun } = {}) {
  const candidates = platform === "darwin" ? [["pbcopy", []]] : LINUX;
  for (const [bin, args] of candidates) {
    try {
      const result = await run(bin, args, { input: value, timeoutMs: 3000 });
      if (result.code === 0) return true;
    } catch {}
  }
  return false;
}
