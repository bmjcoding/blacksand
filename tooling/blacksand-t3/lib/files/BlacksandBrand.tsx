// Injected by blacksand. The version indicator beside the composer and its
// "changes in this build" card; styled in blacksand.css.

import { useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { CircleAlertIcon, InfoIcon } from "lucide-react";

import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "./ui/popover";

import { openDesktopUpdateReleaseNotes } from "./desktopUpdate.toast";
import { useDesktopUpdateState } from "../state/desktopUpdate";
import { BLACKSAND_T3_BUILD } from "../blacksandBuild";
import { useBlacksandInterface } from "../blacksandInterface";
import { useChatCanvas } from "./chat/ChatCanvasContext";
import { observeResize } from "../lib/observeResize";

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

/** Features this build left out, with no report UI or bridge. */
function LeftOut() {
  const skipped = BLACKSAND_T3_BUILD.skipped;
  if (skipped.length === 0) return null;
  return (
    <section className="t3b-version-drift">
      <h4>Left out<span> · upstream moved their code</span></h4>
      <ul>{skipped.map((feature) => (
        <li key={feature.name}>{feature.label}
          {feature.reason === "requires" && feature.requires ? <span> (needs {feature.requires})</span> : null}
        </li>
      ))}</ul>
    </section>
  );
}

/**
 * The full build version (e.g. 0.1.1-nightly.20261017.3238), stamped into the
 * composer's reserved end gutter while its switch is on. Hover, keyboard focus
 * or a tap shows what the build changed, baked in at
 * build time (blacksandBuild.ts). The desktop's reported version wins if the
 * bundle predates a rename. A build that left features out shows a hollow dot,
 * and the card lists them.
 */
export function BlacksandVersionStamp() {
  return useBlacksandInterface("stamp") ? <VersionStamp /> : null;
}

function VersionStamp() {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const restoringFocus = useRef(false);
  const canvas = useChatCanvas();
  const frame = canvas?.layout.frame;
  useLayoutEffect(() => {
    const button = trigger.current;
    const lane = button?.closest<HTMLElement>(".chat-composer-lane");
    const surface = lane?.closest<HTMLElement>("[data-chat-canvas]");
    if (!button || !lane || !surface || !frame) return;
    const measure = () => {
      const bounds = button.getBoundingClientRect();
      const origin = surface.getBoundingClientRect();
      const previewTop = origin.top + frame.y;
      const besidePreview = previewTop < bounds.bottom && previewTop + frame.height > bounds.top;
      const laneBounds = lane.getBoundingClientRect();
      const end = laneBounds.right - Number.parseFloat(getComputedStyle(lane).paddingRight);
      const previewLeft = origin.left + frame.x;
      // A preview beside the trigger requires compact mode. Reserve before it
      // only when it occupies the unadjusted 32px end target; a preview moved
      // away from that corner leaves the normal composer alignment intact.
      const blocked = besidePreview && previewLeft < end && previewLeft + frame.width > end - 32
        ? Math.max(0, end - previewLeft + 12)
        : 0;
      lane.toggleAttribute("data-t3b-version-preview", besidePreview);
      lane.style.setProperty("--t3b-version-blocked-end", `${blocked}px`);
    };
    measure();
    // Reuse the app's shared observer: a centered draft can grow without
    // changing the canvas frame. No new observer or polling loop is created.
    const stop = observeResize(lane, measure);
    return () => {
      stop();
      lane.removeAttribute("data-t3b-version-preview");
      lane.style.removeProperty("--t3b-version-blocked-end");
    };
  }, [frame?.x, frame?.y, frame?.width, frame?.height, canvas?.container.width, canvas?.container.height]);
  const update = useDesktopUpdateState();
  const build = BLACKSAND_T3_BUILD;
  const omitted = build.skipped.length > 0;
  const StampIcon = omitted ? CircleAlertIcon : InfoIcon;
  const version = update?.currentVersion ?? build.version ?? "dev";
  const built = build.builtAt
    ? new Date(build.builtAt).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : null;
  return (
    <div className="t3b-version-rail">
      <Popover
        open={open}
        onOpenChange={(next, details) => {
          setOpen(next);
          if (!next && details.reason === "escape-key") {
            // Escape returns to the button without opening again on that focus.
            // Outside press/Tab keep their natural destination.
            restoringFocus.current = true;
            trigger.current?.focus();
            restoringFocus.current = false;
          }
        }}
      >
        <PopoverTrigger
          ref={trigger}
          openOnHover
          delay={150}
          closeDelay={150}
          onFocus={(event) => {
            if (!restoringFocus.current && event.currentTarget.matches(":focus-visible"))
              setOpen(true);
          }}
          aria-label={`T3 Code (blacksand) ${version} — build details and changelog${omitted ? " — some features omitted" : ""}`}
          className="t3b-version-stamp"
          data-drift={omitted ? "" : undefined}
        >
          <StampIcon aria-hidden="true" className="t3b-version-icon" />
          <i aria-hidden="true" />
          <span className="t3b-version-label">{version}</span>
        </PopoverTrigger>
        <PopoverPopup
          side="top"
          align="end"
          padding="none"
          initialFocus={false}
          finalFocus={false}
          touchBackdrop
          className="t3b-version-notes"
        >
          <PopoverTitle className="sr-only">Build details and changelog</PopoverTitle>
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
            <LeftOut />
          </div>
        </PopoverPopup>
      </Popover>
    </div>
  );
}
