# Upstream rules and drift

> **Applies to:** every build, macOS and Linux. Code: `lib/rules.mjs`,
> `lib/features.mjs`, `lib/strip-engine.mjs`, `lib/drift.mjs`, `lib/looks.mjs`.
> Tests: `test/strip-rules.test.mjs`, `test/build-strip-engine.test.mjs`,
> `test/app-rules.test.mjs`, `test/app-stock-guidance.test.mjs`.

Each rule is a small, anchored source edit applied to every upstream checkout. It
states how many times its anchor must match. What happens when upstream moves that
code depends on the rule.

## Strict rules and feature rules

- **Strict rules** stop the update, and the installed build stays. These cover
  privacy, identity, the updater, the CSP, and stock-T3 guidance. Every rule is
  strict unless `lib/features.mjs` says otherwise.
- **Feature rules** are grouped into features in `lib/features.mjs`. They cover the
  look, the usage-limits fix, host update requests, the PDF preview, the update-track
  note and the privacy text. If one stops matching, or stops compiling, the build
  leaves that whole feature out, plus any feature that requires it, and installs
  anyway. Upstream's own code runs in its place until the rule is updated.

A last strict rule (`stock/no-stock-guidance`) fails the build if any text sending
you to stock T3 is left (`npx t3 …`, `t3@latest`, t3.codes downloads, pingdotgg's
GitHub releases, "update manually"). New stock wording upstream adds holds updates at
the last good pin until a rule replaces it.

The evaluator pins only a release its strict rules apply to, so a machine following
the pin doesn't meet one that fails. If a strict rule fails anyway, the update stops.
On a track built without a pin, the update runs the rules first and falls back to the
newest release (up to 5 back) that still works. If none does, it stays on the
installed build and says why.

## What the rules change

Beyond removing what [privacy](../security/privacy.md) lists, the rules give the app
its own name, bundle ID and data directory, plus its look. The look is the Redacted
app icon, and touches that follow whichever theme you pick: the T3 BLACKOUT wordmark,
redaction bars in place of the nightly starfield, a ringed send button, button glow, a
version stamp and accent text selection. Each has its own switch in **Settings →
Appearance → Interface**. There are no Blackout themes; use upstream's, or add a
custom theme to change the accent.

## The build report

Every build writes a report (`lib/drift.mjs`, `lib/looks.mjs`). It opens with
screenshots. Your installed build and the new one each boot offline, with an empty
profile and the default theme in dark mode. Headless Chrome photographs the same
screens in both, and the report shows them side by side, with what changed
highlighted. The packaged server runs under the [network tripwire](../building/pipeline.md#the-smoke-test)
while it's photographed; if it tries to reach the network, the update fails and
nothing is installed.

For each feature left out, the report lists the upstream commits and pull requests
that touched its code, and the diff with the lines the rule hooked into highlighted. It
also shows where those lines live now, if upstream moved them. A strict failure gets
its own report: which strict rules stopped the update, and how to get updates going
again. Open it from the version stamp's hover card, or with `bin/t3blackout drift`.
Beside it are the report's data and screenshots as files (`<version>.json`,
`<version>/`), which `bin/t3blackout review` gathers for an agent to read.

## Fixing a rule

1. `bin/t3blackout drift` shows what upstream changed.
2. Update the anchor in `lib/rules.mjs`. `bin/t3blackout check` dry-runs the rules
   against the pinned release (`--ref` for any), so you can iterate quickly.
   `bin/t3blackout check --build` also builds, scans and smoke-tests it, without
   installing.
3. Commit it, signed. The rules are a repo file, so a change needs the owner's
   signature to reach any machine.

New stock-T3 wording needs a rule that replaces it, placed before `brand/name` in
`lib/rules.mjs`.
