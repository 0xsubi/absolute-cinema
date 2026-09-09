# Absolute Cinema

A Chrome + Firefox extension that pins YouTube to a default video quality, and
caps the frame rate of 60fps videos to 24 or 30.

## What it does

**Default quality.** Every video starts at the quality you pick. The setting is
a *ceiling*: if the video doesn't offer it, the next best available quality is
used instead. The pin is applied with `setPlaybackQualityRange`, so YouTube's
adaptive switcher won't quietly walk it back down.

**Frame rate cap.** Two engines, because the obvious one and the useful one are
not the same thing. See below.

## The frame rate problem

YouTube encodes 60fps and 30fps as **separate streams**. On a 60fps upload the
ladder looks like this:

| Quality | 2160p60 | 1440p60 | 1080p60 | 720p60 | 480p | 360p | 240p |
| ------- | ------- | ------- | ------- | ------ | ---- | ---- | ---- |
| fps     | 60      | 60      | 60      | 60     | 30   | 30   | 30   |

There is no 2160p30. There is no 24fps stream at any resolution. And a
`<video>` element offers no way to tell the decoder to skip frames.

So there are exactly two honest options, and the extension ships both.

### Cinematic (default)

Keeps the full 4K/8K stream. The source video keeps decoding and keeps its
audio, but is made invisible; a `<canvas>` laid over it is repainted only when
media time crosses a 24 or 30fps boundary.

```
video ──decodes 60fps──▶ [hidden, opacity:0]
                             │
            requestVideoFrameCallback
                             │
     repaint only when floor(mediaTime × 24) changes
                             ▼
  canvas ──presents 24fps──▶ [visible, on top]
```

- Resolution: preserved.
- Cadence: genuinely 24 or 30fps.
- CPU/GPU: slightly **higher**, not lower — the 60fps stream still decodes in
  full. This mode is for how the motion looks, not for performance.
- Pacing is keyed to media time, so it stays correct through seeks, pauses and
  playback-rate changes.
- Backing store is capped at the source frame size and at 2× DPR, so an 8K
  stream in a 1080p window is downscaled once on the GPU rather than
  rasterised at 8K.

#### Why the repaint is paced by `requestAnimationFrame`

The obvious clock is `requestVideoFrameCallback`, which fires once per decoded
video frame. It is the wrong one. rVFC only fires on vsyncs where a *video*
frame was also presented — with a 60fps source on a 120Hz display, that is
every other vsync. A 24fps cadence that should land on a clean 5-5-5 grid gets
forced onto 6-4-6-4 instead:

```
target 24fps, source 60fps      gaps between repaints, in vsyncs

  rVFC clock @  60Hz :  3 2 3 2 3 2 3 2
  rVFC clock @ 120Hz :  6 4 6 4 6 4 6 4   <- ±8.3ms wobble, 24×/sec
  rAF  clock @  60Hz :  3 2 3 2 3 2 3 2
  rAF  clock @ 120Hz :  5 5 5 5 5 5 5 5   <- what we ship
```

rAF fires on every vsync, so the media-time gate can pick the nearest one and
the grid comes out as even as the panel allows. On 60Hz both clocks agree —
the 3:2 pulldown there is inherent, since 60/24 is not an integer.

The canvas context is also **not** created with `desynchronized: true`. Low
latency mode lets a canvas present out of band with the rest of the page, which
is precisely wrong for an overlay that must stay locked to the player.

Known trade-offs: picture-in-picture and right-click → save frame fall back to
the untouched 60fps video (the extension detects PiP and steps aside). Ad
breaks are detected and left alone.

### Lower-fps stream

Picks the highest quality whose stream is genuinely at or below your target.
Real decode savings — but on a 60fps upload this lands around **480p**, which
is usually not what you want for a music video. Since no 24fps stream exists,
a 24 target falls through to the lowest rate on offer (30).

The options page shows this warning inline when the mode is selected.

## Install

**Chrome** — `chrome://extensions` → enable *Developer mode* → *Load unpacked*
→ pick this folder.

**Firefox** — `about:debugging#/runtime/this-firefox` → *Load Temporary Add-on*
→ pick `manifest.json`. For a permanent install, run `./build.sh` and submit
`dist/absolute-cinema.zip` to AMO, or install it in Firefox Developer Edition
with `xpinstall.signatures.required` disabled.

## Settings

Click the toolbar icon, or open the extension's options page — same UI either
way. Settings live in `storage.sync` (falling back to `storage.local`) and take
effect immediately, without a reload.

- **Default quality** — Auto, or 8K down to 144p.
- **Frame rate cap** — Off, 24fps, 30fps. Videos already at or under the cap are
  left untouched.
- **Method** — Cinematic or Lower-fps stream.
- **Status badge** — a small readout in the player corner (`AC 2160p60 → 24fps`)
  that fades after a few seconds.
- **Cadence diagnostics** — replaces the badge with a live panel.

## Diagnosing choppiness

Turn on **Show cadence diagnostics**. The panel reports:

```
CADENCE   23.98 / 24 fps
JITTER    0.31 ms  (floor 0.00 ms)
DRAW      0.28 ms  peak 1.9 ms
DISPLAY   120 Hz
CANVAS    3840 × 2160
DECODER   0 dropped / 4128  (0.0%)
SOURCE    2160p60
```

Values turn red when they are out of band. How to read it:

- **jitter** is peak-to-peak timing error against an ideal grid. `floor` is the
  best the display can physically do: 0 when the refresh rate divides the
  target evenly (120Hz÷24, 60Hz÷30), half a refresh interval otherwise
  (~8.3ms for 60Hz÷24). Jitter near the floor means the cadence is as good as
  it gets and any remaining judder is the panel, not the extension.
- **draw** is the `drawImage` call. Tenths of a millisecond means the GPU path.
  Consistent multiples of a millisecond at 4K means a software fallback —
  check `chrome://gpu` for *Canvas: Hardware accelerated*.
- **decoder** counts frames the browser gave up on. Anything above ~1% means
  the machine cannot decode the stream in real time, and no amount of canvas
  work will fix that. Macs have no hardware VP9/AV1 decoder before M3, so 4K
  and 8K YouTube is often decoded in software; dropping to 1440p is the fix.

A quick way to separate the two: set the cap to **30fps**. On a 60Hz display
that is a clean 2:2 and should look perfectly smooth. If 30 is smooth and 24 is
not, you are seeing 3:2 pulldown, which is inherent to 24fps on a 60Hz panel
and is also what 24fps looks like in a cinema.

## Design

The UI follows CRED's [NeoPOP](https://github.com/CRED-CLUB/neopop-web) design
language. The library itself is **not** a dependency: it ships as React +
styled-components with no CSS export, and pulling React, styled-components,
react-spring and a bundler into a four-control popup would cost ~200KB of JS
and force an `npm run build` before the folder could ever be loaded unpacked.

Instead `src/neopop.css` ports the system by hand, with values taken verbatim
from the library source:

| Token | Source |
| --- | --- |
| `--ac-plunk: 3px`, `--ac-angle: 45deg` | `src/primitives/index.ts` → `PlunkProps` |
| palette, card stroke, edge colours | `src/primitives/colors.ts` |
| text opacities (0.9 / 0.7 / 0.5 / 0.3) | `src/primitives/opacity.ts` |
| elevation geometry | `src/components/Button/styles.ts` |

The signature "plunk" is reproduced exactly: a face inset by 3px, plus two
45°-skewed strips standing in for the extruded right and bottom sides. Pressing
translates face and edges together by the plunk width so the solid appears to
sink into the surface. The frame-rate segments use it for their selected state,
so the active cap reads as pushed into the card.

Accent is `#EA333E`. It is not a stock palette entry, but its `600` and `800`
steps are derived with NeoPOP's own ramp — every hue in `colorPalette` sits at
exactly x0.70, x0.50 and x0.30 of its `500` — so the plunk edges shade the way
a built-in colour would. The extension icon matches.

### Typography

- **Space Grotesk** — all prose: headings, labels, descriptions, HUD keys.
- **Overpass Mono** — the values you set and read: the quality dropdown, the
  `OFF / 24 FPS / 30 FPS` segments, and every number in the diagnostics panel.

Both are variable fonts, latin subset, bundled in `fonts/` (44KB total) so the
UI makes **no network request** when it opens. Licences in `fonts/OFL.txt`.

### Previewing without installing

`preview.html` in the repo root is a standalone, fully interactive copy of the
settings UI with the extension storage API stubbed out. Open it directly in any
browser — no install, no server. Settings are held in memory only.

## Layout

```
manifest.json      MV3, no background script — nothing to keep alive
src/inject.js      page (MAIN) world: YouTube's player API lives here
src/content.js     isolated world: settings, the cinematic engine, the badge
src/neopop.css     NeoPOP tokens, @font-face, plunk primitives (shared)
src/overlay.css    canvas + badge styling injected into the player
src/ui.html/css/js settings UI, used as both popup and options page
fonts/             Space Grotesk + Overpass Mono, latin subset, bundled
preview.html       standalone UI preview, storage stubbed (not packaged)
test/run.mjs       headless tests for quality selection and the cadence gate
build.sh           zips a distributable
```

`inject.js` exists because YouTube hangs its player API off `#movie_player` as
expando properties, which a content script's isolated world cannot see. The two
halves talk over `window.postMessage`.

## Tests

```
node test/run.mjs
```

Covers quality-ceiling behaviour, the fallback ladder, the stream-mode fps
filter, and the cadence gate — including a regression test that pins the
rAF-vs-rVFC pacing difference at 120Hz.
