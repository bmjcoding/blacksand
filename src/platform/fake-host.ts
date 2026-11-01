// A Host for tests: programs answer from a table (anything not in it "isn't
// found"), files from a map, and every program run is recorded.

import type { PlatformId } from "../core/envelope.ts";
import type { Host, Output, Read } from "./host.ts";

export interface FakeMachine {
  platform?: PlatformId;
  uid?: number;
  home?: string;
  /** `"<file> <args joined by spaces>"` -> its output (a string is stdout with exit 0). */
  programs?: { [command: string]: string | Partial<Output> };
  /** Path -> contents; `null` for a file that exists but only root can read. */
  files?: { [path: string]: string | Buffer | null };
  /** Path -> where it leads (realpath); a file not listed leads to itself. */
  links?: { [path: string]: string };
}

export interface FakeHost extends Host {
  /** Every program run, as `[file, ...args]`, preceded by `NAME=value` for any environment it was given beyond the fixed one. */
  ran: string[][];
}

export function fakeHost(machine: FakeMachine = {}): FakeHost {
  const files = machine.files ?? {};
  const ran: string[][] = [];
  return {
    platform: machine.platform ?? "darwin-arm64",
    uid: machine.uid ?? 501,
    home: machine.home ?? "/Users/owner",
    node: { path: "/usr/local/lib/blacksand/node/bin/node", version: "v24.22.2" },
    ran,
    exec(file, args, env) {
      ran.push([...(env ? Object.entries(env).map(([k, v]) => `${k}=${v}`) : []), file, ...args]);
      const answer = machine.programs?.[[file, ...args].join(" ")];
      if (answer === undefined) return { status: null, stdout: "", stderr: "", error: "not found" };
      return typeof answer === "string" ? { status: 0, stdout: answer, stderr: "" } : { status: 0, stdout: "", stderr: "", ...answer };
    },
    read(file): Read {
      if (!Object.hasOwn(files, file)) return { ok: false, why: "missing" };
      const content = files[file];
      if (content === null || content === undefined) return { ok: false, why: "denied" };
      return { ok: true, bytes: Buffer.from(content) };
    },
    exists: (file) => Object.hasOwn(files, file),
    realpath: (file) => (Object.hasOwn(files, file) ? (machine.links?.[file] ?? file) : null),
  };
}
