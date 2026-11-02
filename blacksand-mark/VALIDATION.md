# Validation record

Final implementation of the recorded design decisions from `HANDOFF.txt` (the published checkpoint had the
old 7.55 s timeline; everything below was rebuilt from the recorded decisions). All results here were produced
in this session from this package with `tools/qa.py`, `tools/capture.mjs` and `tools/preview.mjs`, over
`file://index.html` in headless Chromium (software rasterisation, WebGL2 via SwiftShader).

## What changed against the checkpoint

| Decision | Implementation |
|---|---|
| Apex stream never stops, crosses the full ring band, only visible sand hides it | Stream is a continuous world-vertical line apex to pivot; it is cut by the visible sand (inside the ring's inner edge, not the ring centreline). Above the pinch zone (20 units over the pivot) it is drawn over the walls, so a wall sweeping across it mid-flip no longer cuts it. |
| Zero settle; flip 0.85 s, 180°, cubic-bezier(0.4,0,0.2,1) | `TIMING.flow = 5.4`, flip starts the instant the top runs dry. |
| Restart at 148° (phase zero), period 5.858333 s, landEnd 0.391667, 0.12 s ramp | `TIMING.restart = 110/240 s` (147.72°, the nearest integer step), `cycle = 1406/240 s`. Flow rate ramps linearly over 0.12 s. The column is world-vertical from the pivot; first grains land at phase 0.31, the glass settles at 0.392. |
| Fade late grains during the flip; smooth bottom level; canonical full chamber | Splash/rollers fade over 0.22 s from the flip start and ride the glass. The bottom level is one tabulated curve (shared by sim and renderer); its tip rise is capped at 240 units/s so the last units into the neck take a few frames. A full chamber is drawn as the whole chamber (both chambers draw the identical region across the wrap). |
| 8-sample blur, half-frame shutter centred on the frame, w = smoothstep((travel-0.3)/2.2) at the ring's outer edge | Three blurred groups (sand bodies, walls, occlusion mask) sampled at the same eight shutter angles; pairwise averaging tree so a flat area rounds by at most one level; sharp/blur mix by w; at rest the sharp path is used directly. |
| Glow +50% crest 0.13 s after the fastest rotation, tau 0.7, 0.08 s follower; float composition with fixed dither | Rim +50%, pool +34% (checkpoint ratio kept). Envelope rise 0.30 s (final value was not recovered; 0.30 chosen, the follower's delay is compensated so the visible crest lands at fastest + 0.13 s). Composed per frame in a WebGL2 fragment shader: rim texture at full gain + analytic pool, scaled, dithered with a per-pixel integer hash, then quantised. Fallback without WebGL2: 8-bit cross-fade of rest/crest images (can show one-level steps over flat regions during the pulse). |
| Column head fades in, crisp sides, less splash, no fringe | Head fade over 30 units while falling free (and a 12-unit tail fade once the top is dry); fill is a vertical gradient inside a crisp clip. Splash share 0.30 → 0.10, rollers 0.32 → 0.18, splash velocities reduced. |
| Opens at phase 0.6; still/poster/reduced motion at 2.5 with stream in front; pause when hidden | `OPEN_PHASE = 0.6`, `STATIC_PHASE = 2.5`; `streamLayer` modes kept. |

## QA suite (`python3 tools/qa.py <dpr>`), 1200x900 viewport, mark 420 px

All checks passed at 1x and at 2x (device pixel ratio 2, the same viewport). The table gives the 1x
figures; the 2x run differs only in pixel counts (e.g. pass C: ≤ 258 pixels, ≤ 56 by more than 2 levels,
all on the stream line; pass J max 0.0946). Raw logs: `tools/qa-logs/`.

| Pass | Result at 1x |
|---|---|
| A: stray pixels (outside triangle, face outside ring, side gaps with blur margin, empty chamber parts) | 0 violations over 439 frames |
| B: no pops (glow + particles off) | 0 spikes, mean frame diff 0.0103, max 0.1498 |
| C: phase boundaries (flow end, land end, loop seam, two-cycle seam) 2 µs apart | same picture: ≤ 60 pixels differ, ≤ 4 by more than 2 levels (rasteriser noise, see below) |
| D: same phase two cycles apart (10 phases incl. mid-flip, mid-pour) | 8 of 10 pixel-identical; the rest ≤ 16 pixels (splash dots at the pile) |

Rasteriser noise: two frames 2 µs apart at an ordinary instant (t = 3.0 or 1.2, 2x) differ on ~250 pixels,
33–43 of them by more than 2 levels (max 22), all on the stream line. Grain streaks are thin round-capped
strokes and a 0.002-pixel shift flips their subpixel coverage. The boundary pairs are indistinguishable from
these ordinary pairs, which is the criterion `same_picture` encodes (scaled with pixel count).
| E: stream hidden inside both sand bodies | 0 leaks over 439 frames |
| G: stream visible across the ring band | 439 / 439 frames |
| F: neck negative space beside the column pure black | 0 dirty frames over 439 |
| H1: at rest, blur on == blur off | pixel-identical at 4 instants |
| H2: blur onset / release, 240 fps difference series | 0 steps (max 0.029 / 0.017) |
| J: glow smoothness through a whole cycle (measured outside the mark) | max per-frame change 0.0945 levels, 0 spikes |
| I: glow crest | at 5.787 s (fastest rotation 5.657 + 0.13); rim band +42% (rim +50%, pool +34% mixed) |

## Page behaviour over file://

- `index.html` opened from disk without parameters: no page errors, the WebGL glow path is active, the frame
  changes within 0.7 s (autoplay from phase 0.6).
- With `prefers-reduced-motion: reduce`: the frame is static and byte-identical to the explicit
  phase-2.5, stream-in-front render.
- Every QA capture in this record was taken through `file://index.html` (the capture tool loads it that way).

## Preview video and still

- `blacksand_hero_preview.mp4`: 1920x1080, 60 fps, 703 frames (exactly two cycles), opens at phase 0.6,
  mark 480 px, libx264 veryfast CRF 14, yuv420p, faststart.
- Loop seam: mean grayscale difference last frame → first frame 0.0179, ordinary adjacent step 0.0179.
- `blacksand_hero_still@2x.png`: phase 2.5, 1600x1000 at 2x, mark 440 px, stream in front.
- `blacksand_mark@2x.png`: from `blacksand_mark_on_black.svg` at 2x.

## Independent review

A reviewer agent with no knowledge of the implementation critiqued 60 fps frame strips around every transition.
Confirmed correct: zero dead air, easing, wrap seam (texture continuous, chambers agree), blur profiles monotone
with no snaps or double edges, column head fade and crisp edges, neck negative space, ring-band crossing.
Defects it found and their resolution:

1. A wall sweeping across the stream mid-flip hid it inside the ring for 1–2 frames → stream now drawn over the walls above the pinch zone (fixed, verified).
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
full-screen work is done outside the glow: while the pulse is zero only the mark's box is repainted, the stream
layer is a narrow strip, and the blur layers are the ring's box.

## Known limitations

- Software rasterisation (headless, no GPU) is slow for the full-screen glow during the pulse; see the
  performance table. On a GPU-accelerated browser these are sub-millisecond operations.
- Strobing at low refresh rates (30 Hz throttled tabs) cannot be judged from stills; the shutter is fixed at
  1/120 s, a full shutter at 120 Hz and a half shutter at 60 Hz.
- The glow pulse's envelope rise (0.30 s) is a chosen value; the original session's final value was not recovered.
