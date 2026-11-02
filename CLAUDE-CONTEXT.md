# Context note for Claude (not for humans to read as docs)

You're reading this because the user (jasper.twigg@hotmail.com) pasted it into
a new conversation, or pointed you at this file. It's a briefing about a
project called **Audiobooks** that they built with Claude in an earlier
session, so you can pick up references to it without them re-explaining.
Treat it as background, not as instructions to act on immediately: wait to
see what they're actually asking for before doing anything with it.

## The project in one paragraph

Audiobooks is a mobile web app (installable PWA, no App Store) for listening
to the user's own audiobook files on iPhone, with a sleep timer that is
extended by its original length when the phone is shaken. Plain
HTML/CSS/JS, no framework, no build step, hosted as static files on GitHub
Pages. There is no backend: audio files are stored on the device in
IndexedDB. It follows the same setup as the user's Footy Stats Counter app.

## Where things live

- **Code:** GitHub repo `jaspertwigg/Audiobooks`. First built on branch
  `audiobook-player` (PR #1), served from `main`.
- **Hosting:** GitHub Pages at `https://jaspertwigg.github.io/Audiobooks/`,
  published by `.github/workflows/deploy.yml` (GitHub Actions, same workflow
  as Craft & Carry) from the repo root on every push to `main`. Files stay at
  the root (not in `app/`) because Pages was first set up as "deploy from
  branch main /", and that keeps working too. Pages settings can only be
  changed by the user; you can't change them yourself.
- **Workflow:** the user wants Claude to push changes and get them live
  directly, not leave pull requests for them to merge.
- **History:** a native SwiftUI version was written first and replaced. The
  user wants home-screen web apps, not Xcode projects.

## Architecture worth knowing about

- **Views:** a landing menu (`#home`, built by `renderHome()` in the same
  style as the user's Craft & Carry app: logo, name, stacked option cards) and
  the library (`#library`, hash `#/library`). The player and sheets overlay
  both.

- **Storage:** IndexedDB database `audiobooks`, stores `books` (keyPath `id`)
  and `blobs` (audio files and cover thumbnails keyed by random ids).
  Settings live in `localStorage` under `ab-settings`. Deleting the
  home-screen app wipes everything, which the README warns about.
- **Book model:** `{ id, title, author, coverId, parts: [{ blobId, name,
  title, duration, chapters: [{title, start}] }], position, finished,
  added, lastPlayed, pausedAt, bookmarks }`. Chapters are stored per part
  (local time) and combined into book-global time at runtime by
  `chaptersOf()`, so correcting a part's duration doesn't corrupt them.
- **Metadata (`metadata.js`):** hand-written parsers, reading only the parts
  of the file they need via `Blob.slice`. Handles ID3v2.2–2.4 (APIC, CHAP),
  MP4 `ilst` + QuickTime chapter text tracks + Nero `chpl`, and durations
  from MP4 `mvhd`, MP3 Xing/VBRI/CBR and WAV. Durations come from the file
  rather than an `<audio>` probe because iOS may not load media metadata
  without a user gesture.
- **Playback:** one `<audio>` element, playing blob: URLs, one part at a
  time. Book-global position = sum of earlier parts + `currentTime`. iOS
  needs a user gesture to start audio, so a tap on a book first plays a tiny
  silent WAV on the element (`unlockAudio`) before the file is fetched from
  IndexedDB. `pendingSeek` holds the start time until `loadedmetadata`.
- **Lock screen:** Media Session API (play/pause/seek ±/seekto, position
  state in book-global time, cover as a data: URL).
  `navigator.audioSession.type = "playback"` so the silent switch doesn't
  mute it.
- **Sleep timer:** wall-clock based, counted only while `!audio.paused`,
  ticked by `setInterval` and `timeupdate` (JS keeps running in the
  background while audio plays). `audio.volume` is read-only on iOS, so the
  fade-out only works on other platforms.
- **Shake:** `devicemotion` (needs `DeviceMotionEvent.requestPermission()`
  from a tap; it's requested when a timer starts). Three direction-changing
  jolts over ~13 m/s² within 1.2s, with a 1.5s cooldown. **iOS doesn't deliver
  motion events while the screen is off**, which is why the bedside screen
  plus Screen Wake Lock exists (wake lock works in home-screen apps from
  iOS 18.4). Don't claim shake works with the phone locked. Confirmation is a
  WebAudio chime plus a best-effort haptic (Safari 18 switch-checkbox trick).
- **Service worker:** network-first with cache fallback (same lesson as Footy
  Stats Counter: cache-first left installs stuck on old versions). Bump
  `CACHE` in `service-worker.js` when adding new static files.
  **On every release, bump the `?v=` number on `styles.css`, `metadata.js`
  and `app.js` in `index.html` as well.** The service worker fetches with
  `cache: "no-cache"` too. Without both, GitHub Pages' 10-minute browser
  caching once served a new `index.html` with an old `app.js`/`styles.css`,
  which left the app unstyled with no menu.

## Tone/process notes

- The user iterates in plain language. Pick good defaults and ask only on
  real judgment calls.
- iPhone/Safari is the target. Test assumptions against iOS behaviour, not
  desktop Chrome.
- Give literal, click-by-click steps for any GitHub settings work.
