// The only authenticated Git caller is self-update, for its checked HTTPS origin.
// This file also runs as Git's credential helper. Its stdout is a private pipe
// to Git, never a command result that the updater reports or passes to a build.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import { UPSTREAM_URL } from "./git.mjs";

export function canonicalSelfOrigin(url) {
  return typeof url === "string" && /^https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+\.git$/.test(url) &&
    ![".", ".."].includes(url.slice(url.lastIndexOf("/") + 1, -4)) && url.toLowerCase() !== UPSTREAM_URL.toLowerCase();
}

// gh uses the owner's existing login, never a token from the caller's environment.
// No proxy/TLS/debug/startup override or GitHub token reaches either process.
export function selfFetchEnv(env = process.env) {
  return { PATH: env.PATH ?? "/usr/bin:/bin", HOME: env.HOME, LANG: "C", GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1" };
}

const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
export function selfFetchConfig(url) {
  if (!canonicalSelfOrigin(url)) throw new Error("unsafe self-fetch origin");
  const helper = `!${quote(process.execPath)} ${quote(fileURLToPath(import.meta.url))} ${quote(url)}`;
  return ["http.followRedirects=false", "http.proxy=", "credential.useHttpPath=true", `credential.${url}.helper=${helper}`];
}

function credential(url, operation) {
  // Git calls store/erase too. Never save or delete the owner's login.
  if (operation !== "get" || !canonicalSelfOrigin(url)) return;
  const buffer = Buffer.alloc(8193);
  let size = 0;
  while (size < buffer.length) {
    const count = fs.readSync(0, buffer, size, buffer.length - size, null);
    if (!count) break;
    size += count;
  }
  if (size > 8192) return;
  const input = buffer.subarray(0, size).toString("utf8");
  if (/[\r\0]/.test(input) || !input.endsWith("\n")) return;
  const fields = new Map();
  for (const line of input.replace(/\n\n?$/, "").split("\n")) {
    // Git may advertise its auth capability or the server's challenge. Neither
    // affects the fixed request below, and neither is forwarded to gh.
    if (["capability[]=authtype", "capability[]=state"].includes(line) || line.startsWith("wwwauth[]=")) continue;
    const cut = line.indexOf("=");
    const key = line.slice(0, cut);
    if (cut < 1 || fields.has(key) || !["protocol", "host", "path", "username"].includes(key)) return;
    fields.set(key, line.slice(cut + 1));
  }
  if (fields.get("protocol") !== "https" || fields.get("host") !== "github.com" || fields.get("path") !== url.slice("https://github.com/".length)) return;
  const result = spawnSync("gh", ["auth", "git-credential", "get"], {
    input: `protocol=https\nhost=github.com\npath=${fields.get("path")}\n\n`,
    encoding: "utf8", cwd: "/", env: selfFetchEnv(), timeout: 60_000, maxBuffer: 16 << 10,
  });
  if (result.error || result.signal || result.status !== 0) return;
  // Treat even the helper's response as data; no diagnostic can reach the log.
  const match = /^protocol=https\nhost=github\.com\nusername=([^\r\n\0]+)\npassword=([^\r\n\0]+)\n$/.exec(result.stdout);
  if (match) process.stdout.write(`username=${match[1]}\npassword=${match[2]}\n\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { credential(process.argv[2], process.argv[3]); } catch { process.exitCode = 1; }
}
