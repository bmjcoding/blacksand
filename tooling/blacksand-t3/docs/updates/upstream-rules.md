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
is upstream's T3, with a blacksand backdrop behind it: a night sky, one low dune, and
the blacksand static logo, its centre line through the gap between the T and the 3. The sidebar logo is
upstream's too, with a muted "blacksand" centred under it, which keeps the header
row narrow. Two touches follow whichever
theme you pick: a version stamp and accent text selection. Each has its own switch
in **Settings → Appearance → Interface**. The send button is upstream's.

On nightly builds, the sidebar header shows Blacksand artwork instead of upstream's
starry sky: a monochrome desert night, with dunes along the bottom and the blacksand
mark pressed faintly into the sky behind the two-line "T3 Code / blacksand" label. The send button
on nightly is filled with the same sky and stars, without the mark or the dunes.
The art fades into the sidebar like upstream's, in light mode and dark. It is
static, and it stays put when you resize the sidebar. **Settings → Appearance →
Environment identification** lists it as Blacksand artwork, next to upstream's
Version pill and None.

Blacksand adds no themes of its own. Use upstream's themes, or add a custom theme to
change the accent.

The sidebar's mark is [`docs/assets/blacksand.svg`](../../../../docs/assets/blacksand.svg).
`tooling/blacksand-t3/lib/files/blacksand.svg` is a copy, so the T3 component builds on its
own. A test keeps the two the same. The icon's logo is the static logo,
`tooling/blacksand-t3/lib/files/blacksand-mark.svg`, with its sand line dimmed from
#8e8e8e to #555555 so it doesn't read as a seam through the T at Dock sizes.
`tooling/blacksand-t3/lib/icon-backdrop.mjs` draws the backdrop. The build adds its
parts to upstream's Icon Composer bundle as layers behind the T3, so with Xcode 26 the
icon is Liquid Glass. Only the sky is glass. The logo and the dune are flat layers,
so no glass edge rims them, and with a system tint they become faint white shapes.
The flat PNGs, `tooling/blacksand-t3/lib/files/backdrop-*.png`, cover a build without
Xcode 26, DMG volumes, Linux and the startup splash. They are upstream's icons with the
same backdrop drawn behind the T3. When upstream changes its icons, or the backdrop
changes, remake them with `tooling/blacksand-t3/scripts/backdrop-icons.mjs`. It runs
anywhere Chrome or Chromium does, and its first lines say how.

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

Open the CLI diagnostic report with `blacksand t3 drift`. The app keeps only a
lightweight version stamp and change list. Next
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
