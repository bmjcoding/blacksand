# Upstream rules and drift

> **Applies to:** every build, macOS and Linux. Code: `tooling/blacksand-t3/lib/rules.mjs`,
> `tooling/blacksand-t3/lib/features.mjs`, `tooling/blacksand-t3/lib/strip-engine.mjs`,
> `tooling/blacksand-t3/lib/drift.mjs`, `tooling/blacksand-t3/lib/looks.mjs`. Tests:
> `tooling/blacksand-t3/test/strip-rules.test.mjs`,
> `tooling/blacksand-t3/test/build-strip-engine.test.mjs`,
> `tooling/blacksand-t3/test/app-rules.test.mjs`,
> `tooling/blacksand-t3/test/app-stock-guidance.test.mjs`.

Each rule is a small source edit, tied to an anchor in the code, that the build applies
to every upstream checkout. The rule states how many times its anchor must match. What
happens when upstream moves that code depends on the kind of rule.

## Strict rules and feature rules

- **Strict rules stop the update when they fail, and the installed build stays.** They
  cover privacy, identity, the updater, the CSP and stock-T3 guidance. Every rule is
  strict unless `tooling/blacksand-t3/lib/features.mjs` says otherwise.
- **Feature rules are grouped into features in `tooling/blacksand-t3/lib/features.mjs`.** They
  cover the look, the usage-limits fix, host update requests, the PDF preview, the
  update-track note and the privacy text. If a feature rule stops matching or stops
  compiling, the build leaves out that whole feature, plus any feature that requires
  it, and installs anyway. Upstream's own code runs in its place until someone updates
  the rule.

One last strict rule, `stock/no-stock-guidance`, fails the build if any text that sends
you to stock T3 is left. That text includes `npx t3 …`, `t3@latest`, t3.codes
downloads, pingdotgg's GitHub releases and "update manually". If upstream adds new
stock wording, updates stay at the last good pin until a rule replaces that wording.

The evaluator pins only a release that its strict rules apply to. So a machine that
follows the pin doesn't meet a strict rule that fails. If a strict rule fails anyway,
the update stops. On a track built without a pin, the update runs the rules first. It
falls back to the newest release, up to 5 back, that still works. If none works, the
machine stays on the installed build and says why.

## What the rules change

The rules remove what [privacy](../security/privacy.md) lists. They also give the app
its own name, bundle ID and data directory. The name is T3 Code (blacksand). The icon
is upstream's, with a small blacksand badge in the corner. The sidebar logo is
upstream's too, with a muted "blacksand" after it. A few touches follow whichever
theme you pick: a ringed send button, button glow, a version stamp and accent text
selection. Each has its own switch in **Settings → Appearance → Interface**. Blacksand
adds no themes of its own. Use upstream's themes, or add a custom theme to change the
accent.

The badge's logo is [`docs/assets/blacksand.svg`](../../../../docs/assets/blacksand.svg).
`tooling/blacksand-t3/lib/files/blacksand.svg` is a copy, so the T3 component builds on its
own. A test keeps the two the same. The badge PNGs in `tooling/blacksand-t3/lib/files/` are
upstream's icons with the badge drawn on. When upstream changes its icons, remake them
with `tooling/blacksand-t3/scripts/badge-icons.swift`; its first lines say how.

## The build report

Every build writes a report (`tooling/blacksand-t3/lib/drift.mjs`,
`tooling/blacksand-t3/lib/looks.mjs`). The report opens with screenshots. Your installed
build and the new one each boot offline, with an empty profile and the default theme
in dark mode. Headless Chrome photographs the same screens in both builds. The report
shows the screenshots side by side and highlights what changed. The packaged server
runs under the [network tripwire](../building/pipeline.md#the-smoke-test) while Chrome
photographs it. If the server tries to reach the network, the update fails and installs
nothing.

For each feature the build left out, the report lists the upstream commits and pull
requests that touched that feature's code. It shows the diff and highlights the lines
the rule hooked into. If upstream moved those lines, it also shows where they are now.
A strict failure gets its own report. That report lists which strict rules stopped the
update, and how to get updates going again.

Open the report from the version stamp's hover card, or with `blacksand t3 drift`. Next
to it are the report's data and screenshots as files (`<version>.json` and
`<version>/`). `blacksand t3 review` gathers those files for an agent to read.

## Fixing a rule

1. Run `blacksand t3 drift` to see what upstream changed.
2. Update the anchor in `tooling/blacksand-t3/lib/rules.mjs`. `blacksand t3 check` dry-runs
   the rules against the pinned release, or against any release with `--ref`, so you
   can try a change without building. `blacksand t3 check --build` also builds, scans
   and smoke-tests the release, without installing it.
3. Commit the change, signed. The rules are a repository file, so a change reaches a
   machine only with the owner's signature.

New stock-T3 wording needs a rule that replaces it. Place that rule before
`brand/name` in `tooling/blacksand-t3/lib/rules.mjs`.
