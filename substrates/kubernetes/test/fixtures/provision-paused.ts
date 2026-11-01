// A setup that stops halfway: provisionReceipts, paused for good right after
// it makes the receipts root and before it syncs that root's name into its
// parent (the window a claim must not use). It tells its parent, then waits to
// be killed.
//   node provision-paused.ts ROOT   (forked, with an IPC channel)

import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

import { provisionReceipts } from "../../src/receipt.ts";

const root = process.argv[2] ?? "";
const mkdirSync = fs.mkdirSync;
Object.assign(fs, {
  mkdirSync: (file: fs.PathLike, ...rest: unknown[]) => {
    const made = (mkdirSync as (...a: unknown[]) => unknown)(file, ...rest);
    if (String(file) === root) {
      process.send?.({ phase: "root-visible-before-parent-sync" });
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    }
    return made;
  },
});
syncBuiltinESMExports();
provisionReceipts(root);
throw new Error("the pause must stop provisioning");
