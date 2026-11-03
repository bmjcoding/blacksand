// Injected by blacksand. The nightly stage art: a monochrome desert night, with the
// blacksand mark pressed faintly into the sky above the dunes. It replaces upstream's
// NightlySkyArt wherever upstream draws it: the sidebar header, and the send button's
// fill. Settings -> Appearance -> Environment identification turns it on or off
// ("Blacksand artwork"). Static: no motion.
//
// Same frame as upstream's art: a 96-unit-tall viewBox, left-anchored and sliced, so a
// unit is 80/96 css px in the sidebar's 80px header box. Everything is placed in sky
// coordinates and never moves when the sidebar is resized. The scene is night in every
// theme; blacksand.css fades it into the chrome, light or dark, from under the far ridge.

import { useId } from "react";

const VIEW_BOX = "0 0 8192 96";
const U = 96 / 80; // svg units per css px

// The mark: docs/assets/blacksand.svg as it is (1024 viewBox; triangle 56..968 x 138..878).
// 42px tall, its left edge 131px in, its top 5px down: centred behind the sidebar's
// two-line "T3 Code / blacksand" label as one lockup, its base resting on the far ridge.
const MARK_TRIANGLE = "M512.0 138.0 L968.0 878.0 L56.0 878.0Z";
const MARK_TRANSFORM = `translate(${131 * U} ${5 * U}) scale(${(42 * U) / 740}) translate(-56 -138)`;
const MARK_OPACITY = 0.09;

const mulberry32 = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) >>> 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

// Stars: plain dots, seeded, in a 300-unit tile. Denser high up, dimmer toward the horizon,
// at least 6px apart (wrapping across the tile) so no cluster reads as dirt.
const STAR_TILE = 300;
const STARS: ReadonlyArray<{ cx: number; cy: number; r: number; opacity: number }> = (() => {
  const random = mulberry32(7);
  const stars: Array<{ cx: number; cy: number; r: number; opacity: number }> = [];
  const gap = 6 * U;
  for (let tries = 0; stars.length < 24 && tries < 2000; tries++) {
    const cx = random() * STAR_TILE;
    const y = 3 + Math.pow(random(), 1.25) * 40;
    const r = 0.38 + Math.pow(random(), 4) * 0.4;
    const opacity = (0.4 + random() * 0.5) * (1 - (0.55 * y) / 46);
    const cy = y * U;
    const clear = stars.every((star) => {
      const dx = Math.abs(star.cx - cx);
      return Math.hypot(Math.min(dx, STAR_TILE - dx), star.cy - cy) >= gap;
    });
    if (clear) stars.push({ cx: round(cx), cy: round(cy), r: round(r), opacity: round(opacity) });
  }
  return stars;
})();

function round(value: number) {
  return Math.round(value * 100) / 100;
}

// Dunes: periodic ridges (each tiles seamlessly at its own period), base and amplitude
// in css px. The crest is lit by its fill gradient alone: no stroked rim.
// Three ranks, their crests shaped by the wind: a long windward slope, a sharper crest.
const SKEW = 0.55;
type Ridge = { period: number; base: number; amp: number; offset: number; waves: ReadonlyArray<[number, number, number]> };
const FAR: Ridge = { period: 384, base: 50, amp: 3.4, offset: 0, waves: [[1, 1, 0.4], [2, 0.55, 2.1], [3, 0.2, 0.9]] };
const MIDDLE: Ridge = { period: 480, base: 54.5, amp: 3.2, offset: -60, waves: [[1, 1, 1.2], [3, 0.35, 2.2]] };
const NEAR: Ridge = { period: 576, base: 59, amp: 4.2, offset: -120, waves: [[1, 1, 2.6], [2, 0.4, 0.3], [5, 0.1, 1.7]] };

function ridgePath({ period, base, amp, waves }: Ridge) {
  const points: string[] = [];
  for (let x = 0; x <= period; x += 2) {
    let y = base;
    for (const [k, a, phase] of waves) {
      const t = (2 * Math.PI * k * x) / period + phase;
      y -= amp * a * Math.sin(t + SKEW * Math.sin(t));
    }
    points.push(`${x} ${round(y * U)}`);
  }
  return `M0 96L${points.join("L")}L${period} 96Z`;
}
const FAR_PATH = ridgePath(FAR);
const MIDDLE_PATH = ridgePath(MIDDLE);
const NEAR_PATH = ridgePath(NEAR);

// the night is night in every theme; the backdrop fades it into the chrome, light or dark
const NIGHT = "#0d0d0e";

function DesertNightArt({ compact = false }: { compact?: boolean }) {
  const id = useId().replaceAll(":", "");
  const sky = `${id}-t3b-sky`;
  const stars = `${id}-t3b-stars`;
  const far = `${id}-t3b-far`;
  const farFill = `${id}-t3b-far-fill`;
  const middle = `${id}-t3b-middle`;
  const middleFill = `${id}-t3b-middle-fill`;
  const near = `${id}-t3b-near`;
  const nearFill = `${id}-t3b-near-fill`;
  const clear = `${id}-t3b-clear`;
  const horizon = round(((FAR.base - 2) * U) / 96);

  return (
    <svg
      data-stage-art="blacksand"
      className="h-full w-full"
      fill="none"
      preserveAspectRatio="xMinYMin slice"
      viewBox={compact ? "96 0 8192 96" : VIEW_BOX}
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        {/* never darker than the chrome; lightest at the horizon */}
        <linearGradient id={sky} x1="0" y1="0" x2="0" y2="96" gradientUnits="userSpaceOnUse">
          <stop stopColor="#0d0d0f" />
          <stop offset="0.3" stopColor="#121214" />
          <stop offset={horizon} stopColor="#1f1f22" />
          <stop offset="1" stopColor="#1f1f22" />
        </linearGradient>
        <pattern id={stars} width={STAR_TILE} height="96" patternUnits="userSpaceOnUse">
          <g fill="#f4f4f5">
            {STARS.map((star) => (
              <circle key={`${star.cx}-${star.cy}`} cx={star.cx} cy={star.cy} r={star.r} fillOpacity={star.opacity} />
            ))}
          </g>
        </pattern>
        {compact ? null : (
          <>
            <linearGradient id={farFill} x1="0" y1={round((FAR.base - FAR.amp * 1.6) * U)} x2="0" y2={round(NEAR.base * U)} gradientUnits="userSpaceOnUse">
              <stop stopColor="#3a3a3e" />
              <stop offset="0.4" stopColor="#1c1c1f" />
              <stop offset="1" stopColor="#0f0f10" />
            </linearGradient>
            <linearGradient id={middleFill} x1="0" y1={round((MIDDLE.base - MIDDLE.amp * 1.5) * U)} x2="0" y2={round((NEAR.base + 2) * U)} gradientUnits="userSpaceOnUse">
              <stop stopColor="#2a2a2e" />
              <stop offset="0.45" stopColor="#161618" />
              <stop offset="1" stopColor="#0e0e0f" />
            </linearGradient>
            <pattern id={middle} width={MIDDLE.period} height="96" x={MIDDLE.offset} patternUnits="userSpaceOnUse">
              <path d={MIDDLE_PATH} fill={`url(#${middleFill})`} />
            </pattern>
            <linearGradient id={nearFill} x1="0" y1={round((NEAR.base - NEAR.amp * 1.4) * U)} x2="0" y2={round((NEAR.base + 7) * U)} gradientUnits="userSpaceOnUse">
              <stop style={{ stopColor: `color-mix(in srgb, ${NIGHT} 80%, #4a4a50)` }} />
              <stop offset="0.55" style={{ stopColor: NIGHT }} />
              <stop offset="1" style={{ stopColor: NIGHT }} />
            </linearGradient>
            <pattern id={far} width={FAR.period} height="96" x={FAR.offset} patternUnits="userSpaceOnUse">
              <path d={FAR_PATH} fill={`url(#${farFill})`} />
            </pattern>
            <pattern id={near} width={NEAR.period} height="96" x={NEAR.offset} patternUnits="userSpaceOnUse">
              <path d={NEAR_PATH} fill={`url(#${nearFill})`} />
            </pattern>
            {/* no star shows through the mark's triangle */}
            <mask id={clear} maskUnits="userSpaceOnUse" x="0" y="0" width="8192" height="96">
              <rect width="8192" height="96" fill="#fff" />
              <path transform={MARK_TRANSFORM} d={MARK_TRIANGLE} fill="#000" />
            </mask>
          </>
        )}
      </defs>

      <rect width="100%" height="96" fill={`url(#${sky})`} />
      <rect width="100%" height="96" fill={`url(#${stars})`} mask={compact ? undefined : `url(#${clear})`} />
      {compact ? null : (
        <>
          <g transform={MARK_TRANSFORM} fill="#fff" opacity={MARK_OPACITY}>
            <BlacksandMark />
          </g>
          <rect width="100%" height="96" fill={`url(#${far})`} />
          <rect width="100%" height="96" fill={`url(#${middle})`} />
          <rect width="100%" height="96" fill={`url(#${near})`} />
        </>
      )}
    </svg>
  );
}

/** docs/assets/blacksand.svg's shapes, unaltered (a test keeps them the same). */
function BlacksandMark() {
  return (
    <>
      <path fillRule="evenodd" d="M512.0 138.0 L968.0 878.0 L56.0 878.0Z M512.0 214.2 L896.4 838.0 L127.6 838.0Z" />
      <circle cx="512.0" cy="623.4" r="197.6" fill="none" stroke="#fff" strokeWidth="34" />
      <path d="M512.0 694.5L610.2 726.1L639.0 774.8A197.6 197.6 0 0 1 385.0 774.8L413.8 726.1Z" />
      <path
        d="M385.0 472.0L474.6 623.4L385.0 774.8M639.0 472.0L549.4 623.4L639.0 774.8"
        fill="none"
        stroke="#fff"
        strokeWidth="22"
        strokeLinejoin="miter"
        strokeMiterlimit="10"
      />
      <path d="M439.5 564.1L512.0 579.9L584.5 564.1L549.4 623.4L474.6 623.4Z" />
      <path d="M501.0 210.2H523.0V425.7H518.6V696.5H505.4V425.7H501.0Z" />
    </>
  );
}

/** The nightly stage art. `compact` is the send button's fill: sky and stars only. */
export function BlacksandNightSky({ compact = false }: { compact?: boolean }) {
  return <DesertNightArt compact={compact} />;
}
