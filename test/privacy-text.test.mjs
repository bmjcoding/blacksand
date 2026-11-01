// node --test test/: the welcome screen and Settings → About no longer claim T3
// Blackout collects usage data (rules web/privacy-text-*, feature privacy-text).
// The fixtures are upstream's text, unchanged across its recent builds.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { featureByName, featureIndex } from "../lib/features.mjs";
import { makeRules } from "../lib/rules.mjs";
import { applyRules } from "../lib/strip-engine.mjs";

const rules = makeRules({ updater: { node: "/usr/bin/node", launcher: "/opt/t3b/bin/t3blackout", path: "/usr/bin" }, build: null });
const ids = ["web/privacy-text-link", "web/privacy-text-welcome", "web/privacy-text-about"];

const UPSTREAM = {
  "apps/web/src/legalLinks.ts": 'export const PRIVACY_POLICY_URL = "https://t3.codes/privacy-policy";\n',
  "apps/web/src/components/onboarding/WelcomeWizard.tsx": `import { PRIVACY_POLICY_URL } from "../../legalLinks";
      <div className="mt-6 flex flex-col-reverse gap-4 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
        <p className="min-w-0 text-xs leading-relaxed text-muted-foreground">
          T3 Code collects anonymous usage data to help us improve it. To read more about how your
          data is used and how to opt out, see our{" "}
          <a
            className="underline underline-offset-2 hover:text-foreground"
            href={PRIVACY_POLICY_URL}
            target="_blank"
            rel="noreferrer noopener"
          >
            privacy policy
          </a>
          .
        </p>
`,
  "apps/web/src/components/settings/SettingsPanels.tsx": `import { PRIVACY_POLICY_URL } from "../../legalLinks";
      <SettingsSection id="legal" title="Legal">
        <SettingsRow
          {...searchableSetting("privacy-policy")}
          description="How we handle your data, including the anonymous usage data T3 Code collects."
          control={
            <Button
              render={<a href={PRIVACY_POLICY_URL} target="_blank" rel="noreferrer noopener" />}
              size="sm"
              variant="outline"
            >
              View policy
            </Button>
          }
        />
`,
};

function applied() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "t3b-privacy-"));
  for (const [file, text] of Object.entries(UPSTREAM)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
  const failures = applyRules(root, rules.filter((rule) => ids.includes(rule.id)));
  const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
  return { failures, read };
}

test("the privacy sentences say T3 Blackout collects no usage data, and the links open its README", () => {
  const { failures, read } = applied();
  assert.deepEqual(failures, []);
  const all = Object.keys(UPSTREAM).map(read).join("\n");
  assert.doesNotMatch(all, /anonymous usage data/);
  assert.doesNotMatch(all, /t3\.codes/);
  assert.doesNotMatch(all, /privacy policy|View policy/);
  assert.doesNotMatch(all, /T3 Code/, "nothing left for brand/name to turn into a false sentence");
  assert.match(read("apps/web/src/legalLinks.ts"), /"https:\/\/github\.com\/bmjcoding\/t3blackout\/blob\/main\/docs\/security\/privacy\.md"/);
  assert.match(read("apps/web/src/components/onboarding/WelcomeWizard.tsx"), /T3 Blackout collects no usage data/);
  assert.match(read("apps/web/src/components/onboarding/WelcomeWizard.tsx"), /href=\{PRIVACY_POLICY_URL\}[\s\S]*T3 Blackout README\n {10}<\/a>/, "the import stays used");
  assert.match(read("apps/web/src/components/settings/SettingsPanels.tsx"), /description="T3 Blackout collects no usage data\./);
  assert.match(read("apps/web/src/components/settings/SettingsPanels.tsx"), /Read more\n/);
});

test("the privacy rules run before brand/name and form one feature: a reword upstream skips it instead of holding an update", () => {
  const order = rules.map((rule) => rule.id);
  for (const id of ids) assert.ok(order.indexOf(id) !== -1 && order.indexOf(id) < order.indexOf("brand/name"), id);
  const index = featureIndex(rules);
  for (const id of ids) assert.equal(index.get(id), "privacy-text");
  assert.ok(featureByName("privacy-text").label);
  // A reword drifts the feature, not the build.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "t3b-privacy-drift-"));
  fs.mkdirSync(path.join(root, "apps/web/src/components/onboarding"), { recursive: true });
  fs.writeFileSync(path.join(root, "apps/web/src/components/onboarding/WelcomeWizard.tsx"), "T3 Code collects usage data differently now.\n");
  assert.equal(applyRules(root, rules.filter((rule) => rule.id === "web/privacy-text-welcome")).length, 1);
});
