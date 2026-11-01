// Injected by blacksand. The version stamp in the window's corner and its
// "changes in this build" card; styled in blacksand.css.

import { useCallback, useEffect, useState, type MouseEvent, type ReactNode } from "react";

import { openDesktopUpdateReleaseNotes } from "./desktopUpdate.toast";
import { Dialog, DialogClose, DialogPopup, DialogTitle } from "./ui/dialog";
import { useDesktopUpdateState } from "../state/desktopUpdate";
import { BLACKSAND_T3_BUILD } from "../blacksandBuild";
import { useBlacksandInterface } from "../blacksandInterface";

type Change = (typeof BLACKSAND_T3_BUILD)["upstream"]["items"][number];

/** Opens in the browser: through the desktop shell in the app, a new tab on the web. */
function openUrl(url: string) {
  if (window.desktopBridge) void openDesktopUpdateReleaseNotes(window.desktopBridge, url);
  else window.open(url, "_blank", "noopener,noreferrer");
}

function openLink(event: MouseEvent<HTMLAnchorElement>) {
  event.preventDefault();
  openUrl(event.currentTarget.href);
}

function ExternalLink({ href, children }: { readonly href: string; readonly children: string }) {
  return (
    <a href={href} onClick={openLink} rel="noreferrer" target="_blank">
      {children}
    </a>
  );
}

/** An upstream title with its trailing "(#1234)" turned into a pull request link. */
function UpstreamTitle({ change, repo }: { readonly change: Change; readonly repo: string | null }) {
  const pr = /^(.*?)\s*\(#(\d+)\)$/.exec(change.title);
  if (!pr || !repo) return <>{change.title}</>;
  return (
    <>
      {pr[1]} <ExternalLink href={`${repo}/pull/${pr[2]}`}>{`#${pr[2]}`}</ExternalLink>
    </>
  );
}

/** A Blacksand title led by its short commit ID, linked to the commit. */
function BlacksandTitle({ change, repo }: { readonly change: Change; readonly repo: string | null }) {
  const short = change.sha.slice(0, 7);
  return (
    <>
      {repo ? (
        <ExternalLink href={`${repo}/commit/${change.sha}`}>{short}</ExternalLink>
      ) : (
        <code>{short}</code>
      )}{" "}
      {change.title}
    </>
  );
}

function ChangeList({
  title,
  changes,
  empty,
  render,
}: {
  readonly title: string;
  readonly changes: (typeof BLACKSAND_T3_BUILD)["upstream"];
  readonly empty: string;
  readonly render: (change: Change, repo: string | null) => ReactNode;
}) {
  const { since, items, repo } = changes;
  return (
    <section>
      <h4>
        {title}
        {since ? <span> since {since}</span> : items.length > 0 ? <span> · latest</span> : null}
      </h4>
      {items.length > 0 ? (
        <ul>
          {items.map((change) => (
            <li key={change.sha}>{render(change, repo)}</li>
          ))}
        </ul>
      ) : (
        <p>{empty}</p>
      )}
    </section>
  );
}

/**
 * The desktop's copy of a build's report, screenshots included (state/drift,
 * written after the build), and the staged build's preview. Cast rather than
 * typed: the bridge methods are their own feature (lib/features.mjs), and this
 * file must build without them.
 */
const blacksandBridge = () =>
  window.desktopBridge as
    | {
        getBlacksandDriftReport?: (version?: string | null) => Promise<string | null>;
        previewBlacksandBuild?: () => Promise<string | null>;
      }
    | undefined;
const reportBridge = () => blacksandBridge()?.getBlacksandDriftReport;

/** Features this build left out (lib/features.mjs), and the way into the report. */
function WhatChanged({ onOpen }: { readonly onOpen: () => void }) {
  const skipped = BLACKSAND_T3_BUILD.skipped;
  if (skipped.length === 0 && !reportBridge()) return null;
  return (
    <section className="t3b-version-drift">
      {skipped.length > 0 ? (
        <>
          <h4>
            Left out<span> · upstream moved their code</span>
          </h4>
          <ul>
            {skipped.map((feature) => (
              <li key={feature.name}>
                {feature.label}
                {feature.reason === "requires" && feature.requires ? <span> (needs {feature.requires})</span> : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <button onClick={onOpen} type="button">
        See what changed
      </button>
    </section>
  );
}

/**
 * A build that's staged and installs on restart (upstream's update state says
 * "downloaded"): open it in a sandboxed window first (`blacksand t3 preview`),
 * or read its report.
 */
function NextBuild({ version, onReport }: { readonly version: string; readonly onReport: () => void }) {
  const preview = blacksandBridge()?.previewBlacksandBuild;
  const [status, setStatus] = useState<string | null>(null);
  if (!preview && !reportBridge()) return null;
  const open = () => {
    if (!preview) return;
    setStatus("Opening the preview…");
    void preview()
      .then((problem) => setStatus(problem ?? "It's open in a window of its own, on a copy of your profile. Close that window when you're done."))
      .catch(() => setStatus("The preview couldn't start."));
  };
  return (
    <section className="t3b-version-drift t3b-version-next">
      <h4>
        {version}
        <span> · ready, installs on restart</span>
      </h4>
      <div>
        {preview ? (
          <button onClick={open} type="button">
            Preview
          </button>
        ) : null}
        {reportBridge() ? (
          <button onClick={onReport} type="button">
            What changed
          </button>
        ) : null}
      </div>
      {status ? <p>{status}</p> : null}
    </section>
  );
}

/**
 * A build's report (lib/drift.mjs) in a frame over the window: the desktop's
 * copy with screenshots, else for this build the one baked into
 * blacksandDrift.ts. `version`: another build's (a staged one). It has no
 * scripts; links open in the browser, # links scroll. Upstream's modal dialog
 * moves focus into it, keeps Tab inside, closes on Escape or a click outside,
 * and returns focus to the version stamp.
 */
function DriftReport({ version, onClose }: { readonly version: string | null; readonly onClose: () => void }) {
  const [html, setHtml] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    const baked = () =>
      version ? Promise.resolve(null) : import("../blacksandDrift").then((module) => module.BLACKSAND_T3_DRIFT_REPORT);
    const fromDesktop = reportBridge();
    void (fromDesktop ? fromDesktop(version).catch(() => null) : Promise.resolve(null))
      .then((report) => report ?? baked())
      .then(setHtml);
  }, [version]);
  const routeLinks = (frame: HTMLIFrameElement) => {
    const doc = frame.contentDocument;
    doc?.addEventListener("click", (event) => {
      const link = (event.target as Element | null)?.closest?.("a[href]");
      const href = link?.getAttribute("href");
      if (!href) return;
      event.preventDefault();
      if (href.startsWith("#")) doc.getElementById(href.slice(1))?.scrollIntoView({ behavior: "smooth" });
      else openUrl(href);
    });
    // Keys inside the frame never reach the dialog.
    doc?.addEventListener("keydown", (event) => {
      if (event.key === "Escape") onClose();
    });
  };
  return (
    <Dialog onOpenChange={(open) => !open && onClose()} open>
      <DialogPopup bottomStickOnMobile={false} className="t3b-drift-panel" showCloseButton={false}>
        <header>
          <DialogTitle>{version ? `What changed in ${version}` : "What changed"}</DialogTitle>
          <DialogClose aria-label="Close">×</DialogClose>
        </header>
        {html ? (
          <iframe onLoad={(event) => routeLinks(event.currentTarget)} srcDoc={html} title="What changed" />
        ) : (
          <p>{html === null ? "This build has no report." : "Loading…"}</p>
        )}
      </DialogPopup>
    </Dialog>
  );
}

/**
 * The full build version (e.g. 0.1.1-nightly.20261017.3238), stamped into the
 * window's bottom-right corner while its switch is on. Hovering or focusing it shows what the build changed, baked in at
 * build time (blacksandBuild.ts). The desktop's reported version wins if the
 * bundle predates a rename. A build that left features out shows a hollow dot,
 * and the card lists them with a way into what upstream changed. A staged
 * build adds a way to preview it.
 */
export function BlacksandVersionStamp() {
  return useBlacksandInterface("stamp") ? <VersionStamp /> : null;
}

function VersionStamp() {
  const update = useDesktopUpdateState();
  const build = BLACKSAND_T3_BUILD;
  const version = update?.currentVersion ?? build.version ?? "dev";
  const next = update?.status === "downloaded" && update.downloadedVersion !== version ? update.downloadedVersion : null;
  // Whose report is open: this build's (null) or the staged one's.
  const [report, setReport] = useState<{ readonly version: string | null } | null>(null);
  const closeReport = useCallback(() => setReport(null), []);
  const built = build.builtAt
    ? new Date(build.builtAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
    : null;
  return (
    <div
      aria-label={`T3 Code (blacksand) ${version}`}
      className="t3b-version-stamp"
      data-drift={build.skipped.length > 0 ? "" : undefined}
      data-next={next ? "" : undefined}
      role="note"
      tabIndex={0}
    >
      <i />
      {version}
      <div className="t3b-version-notes">
        <div className="t3b-version-card">
          <header>
            <b>{version}</b>
            <small>
              {built ? `Built ${built}` : "Development build"}
              {build.upstreamSha ? ` · upstream ${build.upstreamSha.slice(0, 7)}` : ""}
            </small>
          </header>
          <ChangeList
            changes={build.upstream}
            empty="No upstream changes in this build."
            render={(change, repo) => <UpstreamTitle change={change} repo={repo} />}
            title="Upstream"
          />
          <ChangeList
            changes={build.blacksand}
            empty="No Blacksand changes in this build."
            render={(change, repo) => <BlacksandTitle change={change} repo={repo} />}
            title="Blacksand"
          />
          <WhatChanged onOpen={() => setReport({ version: null })} />
          {next ? <NextBuild onReport={() => setReport({ version: next })} version={next} /> : null}
        </div>
      </div>
      {report ? <DriftReport onClose={closeReport} version={report.version} /> : null}
    </div>
  );
}
