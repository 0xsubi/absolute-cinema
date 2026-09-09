# Chrome Web Store listing — paste-ready copy

Fields below map 1:1 to the Developer Dashboard form.

---

## Store listing tab

**Name** (45 max)

```
Absolute Cinema
```

**Summary** (132 max)

```
Pin YouTube to a default quality, and cap 60fps videos to a 24 or 30fps cinematic cadence.
```

**Description**

```
Absolute Cinema does two things to the YouTube player.

DEFAULT QUALITY
Every video starts at the quality you pick — up to 8K. The setting acts as a
ceiling: if a video doesn't offer your choice, the next best available quality
is used instead. The preference is pinned, so YouTube's adaptive switcher won't
quietly walk it back down mid-video.

FRAME RATE CAP
Music videos uploaded at 60fps can look uncannily smooth. Set a 24 or 30fps cap
and Absolute Cinema restores a film-like motion cadence. Videos already at or
below your cap are left completely untouched.

Two methods are available:

• Cinematic — keeps the full 4K/8K image and presents it on a 24 or 30fps
  cadence. Pacing is locked to the display's refresh, so on a 120Hz screen a
  24fps cap lands on a perfectly even grid. Note that this does not reduce CPU
  or GPU load: the 60fps stream is still decoded in full. It changes how the
  motion looks, nothing else.

• Lower-fps stream — selects a stream that is genuinely at or below your target
  frame rate. This does cut decode load, but because YouTube only encodes 60fps
  uploads at 60fps above 720p, it will drop such videos to roughly 480p. The
  options screen warns you about this when the mode is selected.

ALSO INCLUDED
• An optional status badge in the player corner showing what was applied.
• An optional diagnostics panel reporting measured cadence, timing jitter
  against the best your display can physically do, repaint cost, and the
  decoder's dropped-frame count — so you can tell a browser problem from a
  hardware one.

PRIVACY
No accounts, no tracking, no analytics, no network requests. Your settings are
the only data, and they stay in your browser. Fonts are bundled in the package
rather than fetched from a CDN.

Not affiliated with or endorsed by YouTube or Google LLC.
```

**Category** — `Photos & Video` (alternative: `Productivity > Tools`)

**Language** — English

---

## Privacy tab

**Single purpose**

```
Control the playback quality and presented frame rate of videos on YouTube.
```

**Justification — `storage` permission**

```
The storage permission holds the user's own settings and nothing else: default video quality, frame rate cap (off / 24 / 30), which of the two frame rate methods to use, and two toggles controlling whether an optional status badge and diagnostics readout appear inside the player.

chrome.storage.sync is used so these preferences follow the user's Chrome profile across devices. chrome.storage.local is written alongside it as a fallback for cases where sync is unavailable, so the two cannot disagree.

No browsing history, page content, personal information, or identifiers are stored. Nothing is transmitted anywhere: the extension makes no network requests at runtime, and all code and fonts ship inside the package.
```

**Justification — host access to youtube.com**

```
The extension's entire function is performed on the YouTube player, so it has to run there and nowhere else.

A content script is injected only on www.youtube.com, m.youtube.com and www.youtube-nocookie.com. It reads the player's list of available quality levels and their frame rates, applies the user's chosen default quality, and, when a frame rate cap is set, draws the video into a canvas so it can be presented at 24 or 30fps instead of 60.

It does not read page text, form fields, cookies, watch history, or account information, and it does not run on any other site. No broader host access such as <all_urls> is requested, and the tabs, scripting, webRequest and cookies permissions are not used. No data leaves the browser.
```

Note: the manifest declares no `host_permissions` key. The field appears
because the Web Store counts `content_scripts.matches` as host access.

**Remote code** — select **No, I am not using remote code**.

```
All JavaScript, CSS and font files are contained in the package. The extension
loads no external scripts and makes no network requests at runtime.
```

**Data usage** — tick nothing. Then certify all three:

- Not being sold to third parties
- Not being used or transferred for purposes unrelated to the item's single purpose
- Not being used or transferred to determine creditworthiness or for lending

A privacy policy URL is not required while no user data is collected.

---

## Graphic assets

| Asset | Size | Required |
| --- | --- | --- |
| Store icon | 128×128 PNG | yes — `icons/icon128.png` |
| Screenshot | 1280×800 or 640×400 | yes, at least 1 (max 5) |
| Small promo tile | 440×280 | optional |
| Marquee promo tile | 1400×560 | optional |

Screenshots must be **exactly** those dimensions — pad, don't stretch.
Suggested set:

1. The popup open over a YouTube video page.
2. A 4K60 video playing with the status badge showing `AC 2160p60 → 24fps`.
3. The diagnostics panel with real numbers.
4. The options page in a full tab, with the stream-mode warning visible.

Do not use YouTube's logo, wordmark, or player chrome as branding in promo
tiles — Google rejects listings that imply affiliation.
