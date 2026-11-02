# blacksand mark

Backlit primary mark: a black triangle lit from behind, an etched ring and hourglass whose walls pinch to a 10-unit neck, and a sand stream that pours from the apex. The animated hero and the static files come from one engine and the same instant of the pour, with one deliberate difference: in the static logo the stream runs in front of everything, as one line through the mark; in motion it falls behind the sand, into the top pile and out of the neck.

## Files

| File | Use |
|---|---|
| `blacksand-engine.js` | Geometry, volume-conserving sand levels, seeded grain simulation, timeline. No DOM. |
| `blacksand-hero.js` | Canvas renderer. `mountBlacksand(canvas, { markSize })` returns `{ start, stop, renderAt, destroy }`. |
| `BlacksandMark.tsx` | React / Next.js wrapper (client component). |
| `index.html` | Full-bleed hero demo. Self-contained, opens straight from disk. Rebuild it with `node tools/build-demo.mjs` after changing the modules. |
| `blacksand_mark.svg` | Static primary mark, transparent background, for dark surfaces. |
| `blacksand_mark_on_black.svg` | Same, with its own black background. |
| `blacksand_lockup.svg` | Primary lockup: mark + `blacksand` in Geist Semibold, text #666666. |
| `blacksand_lockup_mono.svg` | Docs/CLI lockup: mark + `blacksand` in Geist Mono Medium, text #666666. |
| `blacksand_mark@2x.png`, `blacksand_hero_still@2x.png` | Raster exports. |
| `blacksand_hero_preview.mp4` | 1080p60, two full cycles, loops seamlessly. |
| `tools/` | Deterministic frame capture and the QA suite used to verify every frame. |

## Behaviour

- Loop is 7.55 s: pour 5.4 s, tail 0.85 s, hold 0.15 s, flip 1.15 s. Exact period is two cycles (15.1 s) because the sand texture rides the glass through each flip.
- The glow brightens on every flip and decays over about a second.
- The top drains through the neck from the instant the glass is upright. Sand leaves the neck as a column exactly as wide as the opening, in the sand's own tone, with moving grains inside it.
- The apex stream follows, falls into the top crater and disappears into the pile; it stops so its tail reaches the neck as the top runs dry.
- `streamLayer`: `'behind-sand'` (default in motion), `'front'` (static logo look), `'behind'` (also behind the ring).
- `prefers-reduced-motion: reduce` renders the static logo frame (stream in front) and does not animate. The loop pauses when the tab is hidden or the canvas is off screen.
- The page behind the canvas should be `#000`.
- Text outlines are paths; no font loading needed.

## Palette

| Token | Value |
|---|---|
| Ring and walls (etch) | `#262626` to `#4a4a4a`, top to bottom |
| Sand | `#363636` to `#5e5e5e` |
| Wordmark | `#666666` (3.7:1 on black) |
| Stream grains | `rgb(92..150)` at 50% opacity, rare glints at 190 |

## Small sizes

The backlit mark relies on a dark surface and fine detail. Below about 24 px tall (favicon, GitHub/npm avatar) use the white small cut `blacksand_v2_small.svg` from the earlier set.

## Fonts

Geist and Geist Mono, SIL Open Font License 1.1.
