# Validation record

Final implementation of the recorded design decisions from `HANDOFF.txt` (the published checkpoint had the
old 7.55 s timeline; everything below was rebuilt from the recorded decisions). All results here were produced
in this session from this package with `tools/qa.py`, `tools/capture.mjs` and `tools/preview.mjs`, over
`file://hero/index.html` in headless Chromium (software rasterisation, WebGL2 via SwiftShader).

## What changed against the checkpoint

| Decision | Implementation |
|---|---|
| Apex stream never stops, crosses the full ring band, only visible sand hides it | Superseded mid-flip by the designer consensus below: the stream still never stops, but while the glass turns it ends where it first meets a wall or the arriving sand. Upright it crosses the full ring band and is cut by the visible sand (inside the ring's inner edge). |
| Zero settle; flip 0.85 s, 180°, cubic-bezier(0.4,0,0.2,1) | `TIMING.flow = 5.4`, flip starts the instant the top runs dry. |
| Restart at 148° (phase zero), period 5.858333 s, landEnd 0.391667, 0.12 s ramp | `TIMING.restart = 110/240 s` (147.72°, the nearest integer step), `cycle = 1406/240 s`. Flow rate ramps linearly over 0.12 s. The column is world-vertical from the pivot; first grains land at phase 0.31, the glass settles at 0.392. |
| Fade late grains during the flip; smooth bottom level; canonical full chamber | Splash/rollers fade over 0.22 s from the flip start and ride the glass. The bottom level is one tabulated curve (shared by sim and renderer); its tip rise is capped at 240 units/s so the last units into the neck take a few frames. A full chamber is drawn as the whole chamber (both chambers draw the identical region across the wrap). |
| 8-sample blur, half-frame shutter centred on the frame, w = smoothstep((travel-0.3)/2.2) at the ring's outer edge | Three blurred groups (sand bodies, walls, occlusion mask) sampled at the same eight shutter angles; pairwise averaging tree so a flat area rounds by at most one level; sharp/blur mix by w; at rest the sharp path is used directly. |
| Glow flare on the flip; float composition with fixed dither | Superseded by the design panel's continuous breath (see "Glow: design panel consensus"). The float composition with a fixed per-pixel dither is kept. |
| Column head fades in, crisp sides, less splash, no fringe | Head fade over 30 units while falling free (and a 12-unit tail fade once the top is dry); fill is a vertical gradient inside a crisp clip. Splash share 0.30 → 0.10, rollers 0.32 → 0.18, splash velocities reduced. |
| Opens at phase 0.6; still/poster/reduced motion at 2.5 with stream in front; pause when hidden | `OPEN_PHASE = 0.6`, `STATIC_PHASE = 2.5`; `streamLayer` modes kept. |

## Mid-flip stream: two-designer consensus

Owner's complaint: "it looks strange when it's mid turn and still going". Two independent contrarian motion
designers (agents) debated in rounds until both signed off, then reviewed the implementation.

Agreed diagnosis: continuity was not the fault. Mid-flip the stream was a rigid full-density line running
through the empty, spinning chamber, and through solid wall, to the rotation axis. It touched nothing, so it
read as an axle or needle, not falling sand. The pivot is enclosed by wall: from about 40° to 140° the
nearest the stream can get without passing through a wall is about 32 units above it.

Implemented spec:

1. Apex emission 100% → 30% (ease-out) over phase 5.05–5.35, hold to 5.55, 30% → 100% (ease-in) to 5.85.
   It never stops; full density lands after the glass settles. The faint core's density at each height is
   the emission when that sand left the apex.
2. First-hit contact while the glass turns: the stream ends where its centreline first meets a wall face
   (its last 6 units fade) or the arriving full chamber's sand (hidden, sharp). The contact slides along
   the stream as the glass turns: at the ring around 40°, down to about 32 units above the pivot at 90°,
   back up to the ring around 140°. When a wall sweeps across the stream the sand below is gone and the cut
   head falls on.
3. Of grains landing on a long face at least 40° from vertical, 40% slide downhill (0.3 × the impact
   speed along the face, 80–400 units/s), riding the glass, and fade out before the corner.
4. Walls are drawn over the whole stream. The earlier "stream over the walls above a pinch zone" rule is
   gone, because first-hit makes it unnecessary.
5. Sand surfaces stay level under gravity while the glass turns. This fixes a dark "bite" just after the
   wrap: the crater was being drawn in the rotated glass frame. The crater's slope eases to half within
   0.25 Rin while the thinned stream lands, returning to full by phase 0.5.

Deviations from the debated spec, accepted by both designers in their review of the implementation:

- Contact on the stream's centreline, not per grain. Per-grain contact frayed into a grey fringe along
  steep faces.
- No sliding on steep faces or on the wall ends. On steep faces it hugged the edge as a fringe; on the end
  caps the turning glass carried the grains around the ring band.
- Sliding grains fade before the corner instead of falling free. Free-falling grains read as stray specks,
  and one drifted through a wall. Consequence: slides are now rare (shallow faces only meet the stream near
  the corner), so in practice the stream simply lands on the wall.
- Sand hides the stream but does not stop grains. That keeps every phase boundary continuous.

Both designers' acceptance criteria hold:

- 5.60–5.77 s: no line ends on the axis in empty space. Before about 5.70 the end is the cut head falling,
  and after that it is on a wall face.
- The contact moves continuously, except the two frames where a wall end sweeps across it at the ring
  (covered by blur).
- No sand is drawn inside wall material, and there are no fringes or specks.

## Glow: design panel consensus

Owner: "the glow pulse is a little harsh on rotation … it could just be a continuous pulse", with Vercel's
cursor-following triangle glow as inspiration (not to copy). vercel.com is blocked from this environment and no
write-up of its implementation was found, so the panel worked from the owner's screenshots and pixel
measurements of them (`tools/qa-logs/vercel-measurements.txt`). These show a light hidden behind the triangle,
offset toward the cursor. The lit edge reaches about 230, halves by 0.1 of the side and is gone by about 1.5.
Far edges keep a dim rim of about 40. The light is neutral grey with heavy grain.

Diagnosis: the old glow sat dark for about 3 s, then went from 0 to full in about 0.3 s during the flip. That
is a strobe hit, not a pulse.

Agreed spec, implemented:

1. A source behind the triangle, in the triangle's frame, neutral grey, silhouette-masked.
2. Rest (breath b = 0) is the approved static look, unchanged. The SVG, lockups, poster and reduced-motion
   frame stay as approved.
3. Halo = h·w·[0.06·e^(−d/0.05S) + 0.05·e^(−d/0.40S)]. The weight w = clamp(1 + 12·(n·o), 0.6, 2.2) leans
   the halo toward the source offset o.
4. Breath b = ½ + ½·cos(2π(ph − 0.40)/cycle), cresting at phase 0.40, after the glass settles at 0.392.
   The rim gains 15%·b and the pool 10%·b. The old flare is deleted, and there is no dead time.
5. The source sits 0.04 S below the centroid. A sideways swing was shipped first and removed after the
   owner's review (see below).
6. Pointer light: opt-in, fine pointer only. It reaches 0.10 S, within ±100° of straight down, and its reach
   fades to nothing past that arc (so the light never swings round the base). It rides critically damped
   springs (0.6 s settle, slowed to 1.2 s after review 2) and lets go on leave or after 2.5 s idle. The halo factor is h = b + 0.5·a·(1 − b),
   and the rim also gains ×(1 + 0.25·a·max(0, w − 1)).
7. Grain: the fixed per-pixel dither only.
8. MP4: `-tune grain`, CRF 14, full-range 8-bit (see "Preview video and still").

Why Vercel's primitives were adopted only in part:

- Adopted: the hidden source behind an occluder, a long soft two-scale falloff, a dim rim kept on every edge,
  and neutral grey.
- Rejected:
  - cursor-follow as the main behaviour. It is their signature and does nothing on touch, in the MP4 or in
    stills, so here it is opt-in.
  - the one-sided 230 hot edge, which conflicts with the approved soft rim on all edges.
  - heavy grain, given the owner's sensitivity to stray pixels.

Changes after implementation, agreed by both designers:

- Pointer floor. The pointer had almost no effect near the breath trough, so the halo factor became
  b + 0.5·a·(1 − b). This equals b with the pointer off, so the trough is unchanged.
- Arc fade. A cursor crossing over the apex flipped the clamped target from one end of the arc to the other.
  The reach now fades to zero past the arc.
- Swing profile. sin(2·rot) whipped the source at the easing's peak, giving 4 levels per frame at the edge.
  Linear flip progress halves its peak rate: 2.0 levels per frame, with the lean ratio still 1.87.

## Owner review 2: the swing was too quick; a true static logo

Owner: "that left right glow is very harsh - way too quick. not sure how the design reviewers signed off on
that fast animation … the still logo needs work … make the line more of a line and less of the sand stream,
that way we have an actual static logo and then an animated one."

The panel's miss: the swing (±0.04 S, out and back within the 0.85 s flip, about 0.4 s each way) was checked
only against per-frame pixel limits and lean visibility, never tempo. The new criterion is K5: the angular
rate of the light's lean, measured from the source offset. It must be at most 20°/s for anything autonomous
and at most 60°/s for the pointer.

Agreed and implemented:

- **Glow.** No autonomous lean: the source is fixed 0.04 S below centre, and the flip swing is deleted.
  A slow two-cycle drift was proposed and rejected, because it competes with the breath and is a gentler
  version of the motion the owner rejected. The pointer light now settles in 1.2 s (was 0.6 s), and its lean
  turns at most 60°/s. Live test with fast mouse flicks: the maximum was 60.0°/s, and it lets go fully when
  idle.
- **Static logo.** First proposal: one flat line from the apex to the base, replacing the grain stream. The owner
  had not approved it; it was revised over three more reviews (below).

## Owner reviews 3–5: the static logo

Owner, review 3: the line "should just stop at the sand mound like it did before … I see blur here in the
sand … the bottom glow is throwing me off … there's a halo around the entire triangle yet [only] the bottom
glow … how we would style the static logo for a light background … [and] a version that doesn't have the outer
glow." Review 4: "the line overlapping the edge at the apex doesn't look good … a few px in the apex [on white]
look off … tone down the brightness of the line … a few hues darker." The panel's first apex fix started the
line below the tip; the owner rejected the gap ("the line should still go to the apex"). Review 5: the default
was right; on the light and glow marks the line should reach the apex too. The owner approved the result and
the renames.

Agreed and implemented (panel consensus each round; the owner's instructions taken as given):

- **Line.** From the apex at x 512 down into the bottom mound. It ends 6 units under the mound's peak and the
  pile covers its end. Tone #8e8e8e (#b8b8b8 on the light mark), 12 levels darker than first proposed.
  8 units in the masters, 16 in the small cuts.
- **Apex.** On the no-glow mark the #3a3a3a inner edge band (8 units in the master, 12 in the cut) is drawn
  over the line, so the band runs unbroken across the tip and the line runs up under it. On the glow and light
  marks the line runs into the tip, clipped by the triangle. At 40–64 px on white the tip's top pixels take the
  line's grey: the line is wider than the tip there (flagged to the owner, who approved).
- **Sand.** Flat, in the approved world-space gradient (#363636 to #5e5e5e). The feTurbulence grain the owner
  saw as blur is gone from every static file.
- **Lighting.** The pool is removed from the static files; a rim on all edges with a floor light only beneath
  was inconsistent. The animated hero keeps its own lighting (rim, pool, breath).
- **Variants.** `blacksand-mark` is the no-glow default; `-glow` (even rim, no pool) is for black key art;
  `-light` is for white surfaces. There are lockups for each surface and a black icon cut (see the README's
  "Which file" table).
- **The hero's reduced-motion frame.** The logo's interior (line into the mound, flat sand) under the hero's
  rest lighting. The poster is the first played frame.

Measured (1x screenshots, triangle height as the size):

- **Light mark at 40 px.** The ring is about 1.8 px. Ring #5c5c5c is 92 levels over black, sand is 46 levels
  from the ring, and the line is 46 from the sand.
- **The 16-unit line at 40 px.** Nominal 0.86 px, just under the panel's 1 px floor.
- **No-glow cut at 64 px.** The edge is 1.04 px and 58 levels over black. The gap from edge to ring is
  28 units, 2.4 px.
- **Files.** The default mark is 31 KB, against 108 KB for the old grain-stream file.

## QA suite (`python3 tools/qa.py <dpr>`), 1200x900 viewport, mark 420 px

All checks passed at 1x and at 2x (device pixel ratio 2, the same viewport), re-run on the final code
after the mid-flip change. The table gives the 1x figures; the 2x run differs only in pixel counts.
Raw logs: `tools/qa-logs/`.

| Pass | Result at 1x |
|---|---|
| A: stray pixels (outside triangle, face outside ring, side gaps with blur margin, empty chamber parts) | 0 violations over 439 frames |
| B: no pops (glow + particles off) | 0 spikes, mean frame diff 0.0103, max 0.1498 |
| C: phase boundaries (flow end, land end, loop seam, two-cycle seam) 2 µs apart | same picture as an ordinary instant (see below) |
| D: same phase two cycles apart (10 phases incl. mid-flip, mid-pour) | 8 of 10 pixel-identical; the rest ≤ 27 pixels (splash dots at the pile) |
| E: stream hidden inside both sand bodies | 0 leaks over 439 frames |
| G: stream visible across the ring band | 429 / 429 frames; the other 10 end at a wall's end or the sand under the ring by design |
| F: neck negative space beside the column pure black | 0 dirty frames over 439 |
| H1: at rest, blur on == blur off | pixel-identical at 4 instants |
| H2: blur onset / release, 240 fps difference series | 0 steps (max 0.029 / 0.017) |
| J: glow smoothness through a whole cycle (outside the mark) | mean per-frame change 0.022 (≤ 0.05), max 0.035 (≤ 0.35), no frame > 3× its neighbours |
| K1: breath trough is the static rest look | pixel-identical |
| K2: rim change between 60 fps frames | 99.9th percentile 1.0 level (≤ 2.0) |
| K5: autonomous lean | source offset constant over the cycle (K3, the swing's lean, retired with the swing) |
| K4: breath visible with the pointer off | +30.1 levels near the base edge, crest vs trough |

Rasteriser noise: two frames 2 µs apart at an ordinary instant differ on 50–60 pixels at 1x, at most 1–2 of
them by more than 2 levels, all on the stream line. Grain streaks are thin round-capped strokes and a tiny
shift flips their subpixel coverage. At 1x the boundary pairs measure 43–58 pixels and ≤ 5 by more than 2
levels, the same as an ordinary instant.

## Page behaviour over file://

- `hero/index.html` opened from disk without parameters: no page errors, the WebGL glow path is active, the frame
  changes within 0.7 s (autoplay from phase 0.6).
- With `prefers-reduced-motion: reduce`: the frame is static and byte-identical to the explicit
  phase-2.5, stream-in-front render with the glow at rest.
- Pointer light, live page, real mouse: it leans left, right and down as the pointer moves. Above the apex it
  stays calm and symmetric, and it lets go after the idle time. No page errors.
- Every QA capture in this record was taken through `file://hero/index.html` (the capture tool loads it that way).

## Preview video and still

- `media/blacksand-hero.mp4`: 1920x1080, 60 fps, 703 frames (exactly two cycles), opens at phase 0.6,
  mark 480 px, libx264 slow -tune grain CRF 14, full-range 8-bit (yuvj420p, BT.709 tags), faststart.
- Banding: limited-range 8-bit (the usual yuv420p) squeezes 256 levels into 220 luma steps and flattens the
  dither. Contour rings showed in the glow's long halo at 3× gain, and no CRF fixed them (low-frequency error
  0.59 levels mean, 2 max, at CRF 10 through 14). Full range removes them: low-frequency error at the breath
  crest is 0.08 levels mean and 1 max against the lossless source. 10-bit is also clean but is poorly
  supported for H.264 in browsers.
- Loop seam: mean grayscale difference last frame → first frame 0.0148, ordinary adjacent step 0.0150.
- `media/blacksand-hero-still@2x.png`: phase 2.5, 1600x1000 at 2x, mark 440 px, stream in front, glow at rest.
- `logo/blacksand-mark@2x.png`: `logo/blacksand-mark.svg` (the no-glow default) at 2x, transparent, 1024 px wide.

## Independent review

A reviewer agent with no knowledge of the implementation critiqued 60 fps frame strips around every transition.
Confirmed correct: zero dead air, easing, wrap seam (texture continuous, chambers agree), blur profiles monotone
with no snaps or double edges, column head fade and crisp edges, neck negative space, ring-band crossing.
Defects it found and their resolution:

1. A wall sweeping across the stream mid-flip hid it inside the ring for 1–2 frames → first fixed by drawing the stream over the walls; superseded by the designer consensus (the stream now lands on the wall).
2. Visible glow crest lagged the fastest rotation by 0.22 s (follower delay) → envelope pulled forward; crest measured at +0.13 s (fixed, QA pass I).
3. Column collapsed into the neck in one frame when the pile reached it → tip rise capped, tail fade added (fixed, verified).
4. Pulse delta re-quantised into 1-level contours; and 5. the pulse's snap to zero stepped the whole glow by a level → WebGL float composition per frame (fixed, QA pass J). The 2D fallback keeps the contour limitation.
6. Dark speckle in the sand texture reads as dirt at 4x → unchanged: this is the approved texture from the checkpoint (design call, not a defect of the motion work).
7. One-pixel darker notches where the column meets the wall corners at the neck line → unchanged: anti-aliasing of two abutting shapes at a geometric corner, 2 static pixels per frame, no flicker.

## Performance

Median `renderAt` time per frame over consecutive 60 fps frames, 1920x1080, mark 480 px, headless Chromium
with software rasterisation (no GPU; WebGL through SwiftShader). `sim` is excluded (it includes PNG encoding in
the capture loop). The old session's figures (pour 5.6 ms, landing 7.4 ms, flip 12 ms) were measured under
unknown conditions and are not comparable.

| Path | DPR | Pour | Flip | Landing (pulse on) |
|---|---|---|---|---|
| WebGL glow (default) | 2x | 161 ms | 193 ms | 196 ms |
| WebGL glow (default) | 1x | 35 ms | 48 ms | – |
| 2D fallback (`?webgl=0`) | 2x | 9.9 ms | 38 ms | 45 ms |
| 2D fallback (`?webgl=0`) | 1x | 2.5 ms | 8.2 ms | – |

Of the WebGL figures, 145–160 ms at 2x is the full-screen shader draw plus the copy into the 2D canvas, both
pure software here; on a GPU they are sub-millisecond, so the mark itself is what remains: sand 8–13 ms,
stream 5–12 ms, walls 6 ms at 2x in software (blur groups during the flip), 0.6–3 ms at 1x. No per-frame
full-screen work is done outside the glow: while the pulse is zero only the mark's box is repainted, and the
stream layer and the blur layers are the ring's box. These figures predate the mid-flip change. The 2x flip
frames measured in its capture runs took 130–165 ms median with WebGL, the same range.

## Known limitations

- Software rasterisation (headless, no GPU) is slow for the full-screen glow during the pulse; see the
  performance table. On a GPU-accelerated browser these are sub-millisecond operations.
- Strobing at low refresh rates (30 Hz throttled tabs) cannot be judged from stills; the shutter is fixed at
  1/120 s, a full shutter at 120 Hz and a half shutter at 60 Hz.
- The glow is the panel's design from screenshots; Vercel's actual implementation could not be inspected.
- The 2D fallback (no WebGL2) has the breath but not the pointer light.
- With the breath, the glow is recomposed every frame. In software rasterisation that full-screen pass dominates the frame
  time (see the performance table); on a GPU it is negligible.

## File names

The package was reorganised after this record was written; the measurements above apply unchanged. The rebuilt
marks, lockups and demo are byte-identical to the files they replace, except the icon. The icon's fill was
`currentColor` and is now explicit `#fff`. Old name → new name:

| Old | New |
|---|---|
| `index.html`, `blacksand-engine.js`, `blacksand-hero.js`, `BlacksandMark.tsx` | `hero/` (same names) |
| `blacksand_mark.svg`, `_glow`, `_light` | `logo/blacksand-mark.svg`, `-glow`, `-light` |
| `blacksand_mark_64.svg`, `_glow_64`, `_light_64` | `logo/blacksand-mark-small.svg`, `-glow-small`, `-light-small` |
| `blacksand_v2_small.svg`, `blacksand_v2_small_dark.svg` | `logo/blacksand-icon.svg`, `logo/blacksand-icon-dark.svg` |
| `blacksand_mark@2x.png` | `logo/blacksand-mark@2x.png` |
| `blacksand_lockup_large.svg` (and `_mono_large`, `_light_large`, `_mono_light_large`) | `lockups/blacksand-lockup.svg` (and `-mono`, `-light`, `-mono-light`) |
| `blacksand_lockup.svg` (and `_mono`, `_light`, `_mono_light`) | `lockups/blacksand-lockup-small.svg` (and `-mono-small`, `-light-small`, `-mono-light-small`) |
| `blacksand_hero_preview.mp4`, `blacksand_hero_still@2x.png`, `blacksand_hero_poster@2x.png` | `media/blacksand-hero.mp4`, `media/blacksand-hero-still@2x.png`, `media/blacksand-hero-poster@2x.png` |
| `blacksand_mark_on_black.svg` | removed (the glow mark on a black rect; use `blacksand-mark-glow.svg` on black) |
| `tools/wordmark.json` | `tools/data/wordmark.json` |
| `tools/geom.json`, `tools/mark_fragment.json` | build intermediates, now in `tools/.build/` (git-ignored) |

## Glowing sand stream (glow mark)

Owner: "what if we made the sandstream glow? … I feel like it would be more cohesive rather than just the line
fill", then "darken the line just a tad bit and brighten the glow", then "the line from A2 but the soft haze/tight
halo from D1", then "I like [rim] 40, but the line needs fixed … it's much brighter when being overlayed on the gray".
The design panel judged twelve variants by one rule: light is brightest at its core and fades evenly outward.

- **Glow:** a soft haze (white 30%, width 18, blur 16) and a tight halo (white 38%, width 8, blur 4) around the
  line, both clipped like the line; the rim goes from 35% to 40%.
- **Core:** white at 18% over the glow, 122 of 255 on black, the brightness of the approved line.
- **Even brightness:** an opaque grey core went darker than the sand beside it (the glow added to the sand but the
  core covered it: up to 24 levels darker); an added-light core went brighter over grey (131 over the ring, 151
  over the sand). The stream is now drawn opaque over its own black backing and lightened onto the logo: the line
  measures 121–122 over the air, the ring and the sand, and no pixel of the logo is darker than without the stream.
- **Scope:** only `blacksand-mark-glow.svg` and `-glow-small.svg` change (the small cut's glow scales with its
  16-unit line); every other logo and lockup file is byte-identical.
