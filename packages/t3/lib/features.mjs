// Which strip rules a build may leave out.
//
// A rule listed under a feature fails open: if upstream moves the code it hooks
// into, the build drops the whole feature (every rule in it, and every feature
// that requires it) and still installs. The update says what it left out, and
// `blacksand t3 drift` shows what upstream changed (lib/drift.mjs).
//
// Every rule not listed here is strict: telemetry, phone-homes, the CSP, the app's
// identity and the updater. A strict rule that stops matching stops the update.
// New rules are strict until added here, so only list a rule whose absence costs
// looks or convenience, never privacy.
//
// `rules` are rule ids; a trailing * matches every id with that prefix.
// `requires` names features this one can't build or show without. Data
// attributes for blacksand.css don't count: they're inert without it.

export const features = [
  {
    name: "names",
    label: "Blacksand names",
    description: "Blacksand T3 as the app name in a plain browser and the page title; the Ink and Orchid theme names",
    rules: ["web/branding-name", "web/branding-title", "web/theme-name-ink", "web/theme-name-orchid"],
  },
  {
    name: "product-name",
    label: "Blacksand T3 in dialogs and menus",
    description: "Upstream's ~400 hardcoded mentions of T3 Code",
    rules: ["brand/name"],
  },
  {
    name: "styles",
    label: "Blacksand styles",
    description: "blacksand.css and the Blacksand interface switches it loads with",
    rules: ["web/blacksand-css", "web/blacksand-css-import", "web/blacksand-interface-file"],
  },
  {
    name: "brand-file",
    label: "Blacksand brand components",
    description: "The wordmark, redaction art and version stamp components, and this build's version info and drift report",
    rules: ["web/blacksand-brand-file", "web/blacksand-build-info", "web/blacksand-drift-report"],
    // Its components read the interface switches, which load with the styles.
    requires: ["styles"],
  },
  {
    name: "wordmark",
    label: "T3 BLACKOUT wordmark",
    description: "The sidebar logo",
    rules: ["web/blacksand-wordmark"],
    requires: ["brand-file", "styles"],
  },
  {
    name: "stage-art",
    label: "Redaction art",
    description: "Replaces the nightly starfield behind the sidebar and send button",
    rules: ["web/blacksand-stage-art"],
    requires: ["brand-file", "styles"],
  },
  {
    name: "version-stamp",
    label: "Version stamp",
    description: "The build version in the window's corner, with its changes and this report on hover",
    rules: ["web/blacksand-version-stamp"],
    requires: ["brand-file", "styles"],
  },
  {
    name: "drift-viewer",
    label: "Report with screenshots in the app",
    description: "The version stamp opens this report, screenshots included; without it, a copy without them",
    rules: ["desktop/drift-report-*", "contracts/drift-report-bridge"],
  },
  {
    name: "send-button",
    label: "Ringed send button",
    description: "Lets blacksand.css find the send button and the composer around it",
    rules: ["web/blacksand-send-button"],
  },
  {
    name: "interface-settings",
    label: "Blacksand interface switches",
    description: "The Blacksand switches in Settings → Appearance → Interface; without them everything stays on",
    rules: ["web/blacksand-interface-setting-file", "web/blacksand-interface-setting-search", "web/blacksand-interface-setting-rows"],
    requires: ["styles"],
  },
  {
    name: "glow-sidebar",
    label: "Glow on the sidebar footer buttons",
    description: "An ember ring and glow when you hover the icon buttons at the foot of the sidebar",
    rules: ["web/blacksand-glow-sidebar"],
  },
  {
    name: "glow-update",
    label: "Glow on the update button",
    description: "An ember ring and glow when you hover the sidebar's update button",
    rules: ["web/blacksand-glow-update"],
  },
  {
    name: "glow-attach",
    label: "Glow on the attach button",
    description: "An ember ring and glow when you hover the composer's attach button",
    rules: ["web/blacksand-glow-attach"],
  },
  {
    name: "stage-pins",
    label: "Pinned patched dependencies",
    description: "Builds the app when a dependency upstream patches has published a newer version than its patch",
    rules: ["desktop/stage-pin-patched"],
  },
  {
    name: "app-icon",
    label: "Redacted app icon",
    description: "The redaction-bar app icon in the Dock and Finder, layered for Liquid Glass",
    rules: ["desktop/app-icon-*"],
  },
  {
    name: "host-update-requests",
    label: "Update everything for SSH hosts",
    description: "Update everything includes SSH hosts and asks each one's Blacksand T3 updater to build the signed pin; without it, they need a manual update",
    rules: [
      "server/blacksand-host-update-file",
      "server/self-update-requests-host-build",
      "server/self-update-host-capability",
      "contracts/self-update-blacksand-host",
      "client/self-update-blacksand-host-queued",
      "web/self-update-blacksand-host*",
    ],
  },
  {
    name: "pdf-preview",
    label: "PDFs in the preview browser",
    description: "A PDF the preview browser opens shows in upstream's PDF viewer; without it, the CSP refuses upstream's embed and the page stays blank",
    rules: ["web/preview-pdf-viewer"],
  },
  {
    name: "update-track-note",
    label: "Update track explained",
    description: "Picking another update track says how Blacksand T3's pinned tracks are switched; without it, it says npm has no release",
    rules: ["web/update-track-pinned"],
  },
  {
    name: "usage-limits",
    label: "Usage limits after a failed probe",
    description: "Live limit updates replace 'Could not read limits'; Claude's idle reading says when limits will appear",
    rules: ["provider/usage-limits-clear-probe-failure", "provider/claude-usage-*"],
  },
  {
    // Text and a link only: the telemetry itself is removed by strict rules, so a
    // reworded upstream sentence costs accuracy, not privacy, and doesn't hold an update.
    name: "privacy-text",
    label: "Accurate privacy text",
    description: "The welcome screen and Settings → About say Blacksand T3 collects no usage data and link its README; without it, they repeat upstream's claim and link T3's privacy policy",
    rules: ["web/privacy-text-*"],
  },
];

const matches = (pattern, id) => (pattern.endsWith("*") ? id.startsWith(pattern.slice(0, -1)) : id === pattern);

/**
 * Maps each rule id in `rules` to its feature's name (strict rules are absent),
 * after checking the list above against them.
 */
export function featureIndex(rules) {
  const names = new Set(features.map((feature) => feature.name));
  const index = new Map();
  for (const feature of features) {
    for (const required of feature.requires ?? []) {
      if (!names.has(required)) throw new Error(`lib/features.mjs: ${feature.name} requires unknown feature ${required}`);
    }
    for (const pattern of feature.rules) {
      const hits = rules.filter((rule) => matches(pattern, rule.id));
      if (!hits.length && !pattern.endsWith("*")) throw new Error(`lib/features.mjs: ${feature.name} lists unknown rule ${pattern}`);
      for (const rule of hits) {
        const other = index.get(rule.id);
        if (other && other !== feature.name) throw new Error(`lib/features.mjs: ${rule.id} is in both ${other} and ${feature.name}`);
        index.set(rule.id, feature.name);
      }
    }
  }
  return index;
}

export const featureByName = (name) => features.find((feature) => feature.name === name);

/** Adds every feature that requires one in `skipped`, transitively, with why. */
export function skipDependents(skipped) {
  for (let grew = true; grew; ) {
    grew = false;
    for (const feature of features) {
      if (skipped.has(feature.name)) continue;
      const missing = (feature.requires ?? []).find((name) => skipped.has(name));
      if (missing) {
        skipped.set(feature.name, { reason: "requires", requires: missing });
        grew = true;
      }
    }
  }
  return skipped;
}
