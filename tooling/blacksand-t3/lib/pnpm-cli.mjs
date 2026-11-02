// The pinned pnpm's commands, for install.sh and maintainers:
//   node lib/pnpm-cli.mjs digests | fetch DIR | check-pnpm FILE | check-build-tools DIR
//                         | check-tools-lock FILE BUILDER [FD]
// A program of its own, so lib/pnpm.mjs is only ever imported: a module that
// also ran as a program when it was the file node was given would run inside
// any bundle it's part of (scripts/build-sea.ts), where every module is that file.

import { checkBuildTools, checkPnpm, checkToolsLock, fetchPinnedPnpm, printBinaryDigests } from "./pnpm.mjs";

const [command, a, b, c] = process.argv.slice(2);
if (command === "digests") await printBinaryDigests();
else if (command === "fetch" && a) await fetchPinnedPnpm(a);
else if (command === "check-pnpm" && a) process.exitCode = checkPnpm(a);
else if (command === "check-build-tools" && a) process.exitCode = checkBuildTools(a);
else if (command === "check-tools-lock" && a && b) process.exitCode = checkToolsLock(a, b, c);
else {
  console.error("usage: node lib/pnpm-cli.mjs digests | fetch DIR | check-pnpm FILE | check-build-tools DIR | check-tools-lock FILE BUILDER [FD]");
  process.exitCode = 2;
}
