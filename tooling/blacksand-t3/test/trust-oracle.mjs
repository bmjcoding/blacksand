// Run the pre-transition verifier byte for byte. Only its relative dependency
// imports are relocated to the component's lib/; none of its decisions change.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const bytes = readFileSync(new URL("../../../scripts/oracles/selfupdate.mjs", import.meta.url));
assert.equal(createHash("sha256").update(bytes).digest("hex"), "32464423329dc241c01eac566c411faacb70a0d795333995f2713332dad7a048", "the legacy oracle must stay frozen");
const lib = new URL("../lib/", import.meta.url).href;
const source = bytes.toString("utf8").replaceAll('from "./', `from "${lib}`).replaceAll('import("./', `import("${lib}`);
export const oracle = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
