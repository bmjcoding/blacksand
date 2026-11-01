// Every relative link in the repository's Markdown points at a file or folder that
// exists. Web links and in-page anchors aren't checked. Vendored files are skipped.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** The tracked Markdown files, minus vendored copies of other projects. */
function markdownFiles(): string[] {
  const out = execFileSync("git", ["ls-files", "-z", "--", "*.md"], { cwd: ROOT, encoding: "utf8" });
  return out.split("\0").filter((file) => file && !file.includes("/vendor/"));
}

/** The link targets in `text`, outside code fences and inline code. */
export function linkTargets(text: string): string[] {
  const prose = text.replace(/^(```|~~~)[\s\S]*?^\1/gm, "").replace(/`[^`\n]*`/g, "");
  return [...prose.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)].map((match) => match[1] ?? "");
}

/** Whether a target is a path in this repository, as opposed to a URL or an anchor. */
const isLocal = (target: string) => target !== "" && !target.startsWith("#") && !/^[a-z][a-z0-9+.-]*:/i.test(target);

test("link targets skip code and keep titles out", () => {
  const text = "[a](one.md) `[b](two.md)` [d](five.md \"title\")\n```\n[e](six.md)\n```\n";
  assert.deepEqual(linkTargets(text), ["one.md", "five.md"]);
});

test("every relative link in the repository's Markdown resolves", () => {
  const broken: string[] = [];
  for (const file of markdownFiles()) {
    const text = fs.readFileSync(path.join(ROOT, file), "utf8");
    for (const target of linkTargets(text).filter(isLocal)) {
      const relative = decodeURIComponent(target.split("#")[0] ?? "");
      if (!fs.existsSync(path.resolve(ROOT, path.dirname(file), relative))) broken.push(`${file}: ${target}`);
    }
  }
  assert.deepEqual(broken, []);
});
