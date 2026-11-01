// Which platform adapter applies here, and what it observes. Each adapter
// reads the machine through a Host (host.ts) and changes nothing.

import type { PlatformId } from "../core/envelope.ts";
import type { Machine, Wanted } from "../core/resource.ts";
import { observe as observeDarwin } from "./darwin/observe.ts";
import type { Host } from "./host.ts";
import { observe as observeLinux } from "./linux/observe.ts";

export function platformId(platform: string = process.platform, arch: string = process.arch): PlatformId {
  const id = `${platform}-${arch}`;
  if (id === "darwin-arm64" || id === "darwin-x64" || id === "linux-arm64" || id === "linux-x64") return id;
  throw new Error(`blacksand runs on macOS and Linux, arm64 or x64, not ${id}`);
}

/**
 * Everything discovery can see on `host`'s machine, without root and without
 * changing anything. `wanted` (plan's) adds what only a config asks about:
 * units by name, and sshd evaluated for each connection plan checks.
 */
export const observe = (host: Host, wanted?: Wanted): Machine => (host.platform.startsWith("darwin") ? observeDarwin(host, wanted) : observeLinux(host, wanted));
