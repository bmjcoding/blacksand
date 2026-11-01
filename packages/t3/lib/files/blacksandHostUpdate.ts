// @effect-diagnostics nodeBuiltinImport:off - One stat and one exclusive create, outside any fiber.
// Injected by blacksand. "Update everything" for a host whose server runs
// without upstream's service, as every SSH host's does: a marker in the host's
// request folder asks its Blacksand T3 updater (the LaunchDaemon install.sh
// --role host sets up, watching the folder) to build and install the signed
// pin.json. The server advertises this as the blacksandHostUpdate capability.

import * as NodeCrypto from "node:crypto";
import * as NodeFs from "node:fs";
import * as NodePath from "node:path";

/** Matches UPDATE_REQUESTS in the CLI's lib/util.mjs. */
export const BLACKSAND_UPDATE_REQUESTS =
  process.env.BLACKSAND_T3_UPDATE_REQUESTS ??
  (process.platform === "darwin" ? "/Users/Shared/blacksand/update-requests" : "/var/tmp/blacksand-update-requests");

/** Whether this host has an updater to ask: its request folder exists and takes markers from this account. */
export function hasBlacksandUpdateAgent(requests: string = BLACKSAND_UPDATE_REQUESTS): boolean {
  try {
    if (!NodeFs.statSync(requests).isDirectory()) return false;
    NodeFs.accessSync(requests, NodeFs.constants.W_OK | NodeFs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Drops a new marker; true once it exists. The folder is shared by every
 * account on the host, so the name is unguessable and the create exclusive
 * (O_EXCL): an entry someone planted, a symlink included, is never opened.
 */
export function requestBlacksandHostUpdate(requests: string = BLACKSAND_UPDATE_REQUESTS): boolean {
  const name = `${process.getuid?.() ?? 0}-${NodeCrypto.randomUUID()}`;
  try {
    NodeFs.writeFileSync(NodePath.join(requests, name), "", { flag: "wx", mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}
