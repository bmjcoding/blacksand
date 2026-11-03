# blacksand mark

Backlit primary mark: a black triangle lit from behind, an etched ring and hourglass whose walls pinch to a 10-unit neck, and a sand stream that pours from the apex. There are two forms. The static logo is a still mark: one solid line runs from the apex down into the bottom mound, over flat sand and the etched hourglass, with no lighting effects in the default file. The animated hero is the live version, where that line is a falling sand stream that disappears into the top pile and leaves through the neck, under a breathing backlight.

## Files

| File | Use |
|---|---|
| `blacksand-engine.js` | Geometry, volume-conserving sand levels, seeded grain simulation, timeline, glow breath and light-source offset. No DOM. |
| `blacksand-hero.js` | Canvas renderer. `mountBlacksand(canvas, { markSize })` returns `{ start, stop, renderAt, destroy }`. |
| `BlacksandMark.tsx` | React / Next.js wrapper (client component). |
| `index.html` | Full-bleed hero demo. Self-contained, opens straight from disk (double-click, `file://`). Rebuild it with `node tools/build-demo.mjs` after changing the modules. |
| `blacksand_mark.svg`, `blacksand_mark_64.svg` | **The default logo**, for dark surfaces (docs, avatars, decks, app icons). No glow: the black triangle has a crisp #3a3a3a inner edge so it holds on black. Transparent background. |
| `blacksand_mark_glow.svg`, `blacksand_mark_glow_64.svg` | The backlit mark, for black key art and posters: an even rim of light on all three edges, no pool. |
| `blacksand_mark_light.svg`, `blacksand_mark_light_64.svg` | For white and light surfaces (an email signature, documents): solid black triangle, lighter flat interior (ring and walls #5c5c5c, sand #8a8a8a, line #b8b8b8), no lighting. |
| `blacksand_mark_on_black.svg` | The glow mark on its own black field (kept under its old name). |
| `blacksand_v2_small.svg`, `blacksand_v2_small_dark.svg` | Small cuts below 24 px (favicon). The original uses `currentColor` (set the CSS colour; as a plain image it renders black); `_dark` is explicit #000 for light surfaces. |
| `blacksand_lockup.svg`, `blacksand_lockup_mono.svg` | Lockups with the default mark: B (Geist Semibold, tracking -4.5%) and D (Geist Mono Medium, tracking -3%), text #666666, for dark surfaces. Each has a `_large` cut. |
| `blacksand_lockup_light.svg`, `blacksand_lockup_mono_light.svg` | The same lockups with the light mark and text #262626, for white surfaces. Each has a `_large` cut. |
| `blacksand_mark@2x.png` | The default mark, transparent, 1024 px wide. |
| `blacksand_hero_still@2x.png` | The hero's static frame (the reduced-motion look): the logo's interior (line into the mound, flat sand) under the hero's rest lighting. 1600x1000 at 2x, mark 440 px. |
| `blacksand_hero_poster@2x.png` | The hero's poster: exactly the first frame the animation plays (phase 0.6), so nothing pops on play. |
| `blacksand_hero_preview.mp4` | 1080p60, two full cycles (703 frames), opens at phase 0.6, loops seamlessly. |
| `tools/` | Build scripts, deterministic frame capture and the QA suite. |
| `VALIDATION.md` | What was implemented against the handoff, QA results at 1x and 2x, review findings, performance, limitations. |

## Behaviour

- One cycle is 5.858 s (1406 steps of 1/240 s). Phase zero is the 148° point of the flip, where the neck starts to flow again.
  - 0 .. 0.392 s: the glass finishes its turn (148° to 180°) while sand already falls from the neck, world-vertical from the pivot; the first grains land just before the glass settles.
  - 0 .. 5.4 s: the top drains through the neck. The flow rate ramps in over 0.12 s, then the mass rate is constant.
  - 5.4 s: the top runs dry and the flip starts at that instant (no settle). 0.85 s, 180°, `cubic-bezier(0.4, 0, 0.2, 1)`. The cycle wraps at 148°.
  - The exact period is two cycles (11.717 s) because the sand texture rides the glass through each flip.
- The apex stream never stops. It thins to 30% as the top runs dry (5.05–5.35 s), holds through the fast part of the flip, and recovers (5.55–5.85 s) so full density lands after the glass settles; its faint core follows the same density.
- While the glass turns, the stream ends where it first meets something: a wall face (it lands there, and its last 6 units fade), or the arriving sand (which hides it, sharp). The contact point slides along the stream as the glass turns, so it never reads as a rod through the pivot. When a wall sweeps across the stream, the sand below is gone and the cut head falls on. A share of grains landing on a shallow face (40° or more from vertical) slides down it and fades before the corner.
- Upright, the stream crosses the full ring band and disappears behind the top pile. Sand surfaces stay level under gravity while the glass turns. The top crater is shallower near its centre while the thinned stream lands on it.
- Sand leaves the neck as a column exactly as wide as the opening, in the sand's own tone, with moving grains inside it. While its head falls free it fades in instead of ending in a flat cap; its side edges are crisp. Both sand bodies cover its ends; the walls are drawn last.
- Grains that land late (splash, rollers) fade out as the glass starts to turn.
- Motion blur while the glass turns: eight samples over a half-frame shutter centred on the frame time, blended with the sharp render by `smoothstep((travel_px - 0.3) / 2.2)` where travel is measured at the ring's outer edge. At rest the frame is exactly the sharp render. Occlusion masks are sampled at the same shutter angles as the sand.
- The backlight breathes continuously: a raised cosine over exactly one cycle, cresting at phase 0.40, just after the glass settles, so the flip rides the rising swell and the light blooms as the sand lands. At its trough it is exactly the approved static look (rim + pool). As it swells, a soft two-scale halo grows around the triangle (0.06·e^(−d/0.05S) + 0.05·e^(−d/0.40S), S the side), the rim gains up to 15% and the pool 10%.
- The light comes from a source hidden behind the triangle, fixed slightly below centre (so the base runs warmer). It never moves on its own; only the pointer light moves it. The glow is composed per frame in floating point (WebGL2) with a fixed per-pixel dither, so there are no 8-bit steps. Without WebGL2 the breath still runs; there is no pointer light.
- `pointerLight` (opt-in; on in the standalone page, `?pointer=0` turns it off; off by default in the React component): a mouse over the canvas pulls the hidden source toward it, within the lower arc so it stays a backlight, on a critically damped spring (1.2 s settle), and its direction turns at most 60°/s. It lets go when the pointer leaves or idles for 2.5 s. Touch, reduced motion and the MP4 never use it.
- Playback opens at phase 0.6 (upright, pour under way). `prefers-reduced-motion: reduce` renders the static logo frame (static line, glow at rest) and does not animate. The loop pauses when the tab is hidden or the canvas is off screen.
- `streamLayer`: `'behind-sand'` (default in motion), `'front'` (the static logo: the static line instead of the stream), `'behind'` (also behind the ring).
- The page behind the canvas should be `#000`. Text outlines are paths; no font loading needed.

## Palette

| Token | Value |
|---|---|
| Ring and walls (etch) | `#262626` to `#4a4a4a`, top to bottom |
| Sand | `#363636` to `#5e5e5e` |
| Wordmark | `#666666` (3.7:1 on black) |
| Stream grains | `rgb(92..150)` at 50% opacity, rare glints at 190 |

## Which file

| Surface | Mark 128 px tall and up | 24–127 px | Under 24 px |
|---|---|---|---|
| Dark (general use) | `blacksand_mark.svg` | `blacksand_mark_64.svg` | `blacksand_v2_small.svg` (white) |
| Black key art, posters | `blacksand_mark_glow.svg` | `blacksand_mark_glow_64.svg` | `blacksand_v2_small.svg` (white) |
| White / light | `blacksand_mark_light.svg` | `blacksand_mark_light_64.svg` | `blacksand_v2_small_dark.svg` |

Lockups follow the same rule: the default lockup files for marks under 128 px tall (the usual header size), `_large` for 128 px and up. The small cuts carry a 16-unit line (and a 12-unit edge on the no-glow mark) so neither drops below 1 device pixel; the masters use 8 units.

Static logo construction: the line (#8e8e8e; #b8b8b8 on the light mark) runs from the apex at x 512 down into the bottom mound, which covers its last 6 units. On the no-glow mark the inner edge band is drawn over the line, so the band stays continuous across the tip and the line runs up under it; on the glow and light marks the line runs into the tip itself. The sand is the approved world-space gradient, flat (no grain texture). The static files carry no pool of light; that belongs to the animated hero.

## Rebuilding

Node 22 and Playwright with Chromium (`require('playwright')` must resolve), ffmpeg, Python 3 with numpy and Pillow for the QA suite.

```
node tools/build-static.mjs      # blacksand_mark*.svg (incl. _64), tools/geom.json, tools/mark_fragment.json
node tools/lockups.mjs           # lockups (both cuts) from the mark fragment + tools/wordmark.json (pre-shaped Geist outlines)
node tools/build-demo.mjs        # index.html (engine + renderer inlined as a classic script)
node tools/preview.mjs still     # blacksand_hero_still@2x.png (static logo frame)
node tools/preview.mjs poster    # blacksand_hero_poster@2x.png (first played frame)
node tools/preview.mjs mark      # blacksand_mark@2x.png
node tools/preview.mjs video     # blacksand_hero_preview.mp4 (703 frames, libx264 -tune grain CRF 14, full-range 8-bit, faststart)
python3 tools/qa.py 1            # frame-by-frame QA at 1x (python3 tools/qa.py 2 for 2x); exits non-zero on failure
```

`tools/capture.mjs` drives `hero.renderAt(t)` in the demo page over `file://` and dumps PNGs; `debug=glow,particles,blur,breath` switches layers off (`breath` holds the glow at rest), `profile` records per-section timings.

## Fonts

Geist and Geist Mono, SIL Open Font License 1.1. The wordmark outlines in `tools/wordmark.json` were shaped from them.
