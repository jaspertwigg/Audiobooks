# Audiobooks

An audiobook player for iPhone, built as an installable web app (PWA). There's
no App Store and no build step. Open it in Safari, add it to your Home Screen,
and it runs full-screen like a normal app, works offline, and keeps playing
with the screen locked.

Your audiobook files are stored **on your iPhone, inside the app**. Nothing is
uploaded anywhere.

## Features

**Getting around**
- The app opens on a menu with: **Continue listening** (or **Now playing**,
  with the book and chapter), **Add a book**, **Audiobook library**,
  **Sleep timer**, **Share the app** and **Settings**.
- **‹ Menu** at the top of the library goes back to it. The mini player at the
  bottom opens the full player from anywhere.

**Library**
- Add audio files from the Files app (iCloud Drive, On My iPhone, Downloads,
  etc.): MP3, M4A, M4B, AAC and WAV.
- Pick **several files at once** and choose **"Add as one book"** to combine
  them into one book that plays straight through. Files are put in order by
  their names (`Part 2` comes before `Part 10`).
- Reads the **title, author, cover art and chapters** from the files. Chapter
  markers in `.m4b` and `.mp3` files are supported. In a multi-file book, each
  file is a chapter.
- Progress bar and time left for each book, search, sort (recent, title,
  author, date added).
- **⋯** on a book: mark finished/unfinished, start over, rename, delete.

**Player**
- Remembers your place in every book, even if the app is closed.
- Skip back / forward (15s / 30s by default, changeable in Settings), previous
  / next chapter.
- The scrubber covers the **current chapter**; "time left in book" shows
  underneath.
- Chapter list and **bookmarks** (with editable notes).
- Speed from 0.75× to 3× without voices going squeaky.
- **Smart rewind**: steps back a few seconds when you resume after a pause
  (3s after 30 seconds away, 10s after 5 minutes, 30s after an hour).
- Lock screen, Control Center, AirPods and CarPlay controls, with cover art.
  Keeps playing with the silent switch on.

**Sleep timer**
- 5, 10, 15, 20, 30, 45, 60 or 90 minutes, a custom length, or **end of
  chapter**.
- **Shake your iPhone to extend the timer by its original length.** A 15-minute
  timer with 2 minutes left becomes 17 minutes. In end-of-chapter mode, a shake
  carries on to the end of the next chapter.
- A shake needs three firm back-and-forth movements, so rolling over in bed
  doesn't count. A soft two-note chime confirms it worked (can be turned off).
- The countdown only runs while audio is actually playing.

### About shaking with the screen locked

iPhone only sends motion (shake) data to web apps **while the screen is on**.
So when you start a sleep timer, the app switches to a **dim bedside screen**:
pure black with a faint countdown, and it stops the screen from auto-locking.
Shaking works the whole time it's showing. When the timer ends, playback
pauses and the phone is allowed to lock as normal.

- Tap the bedside screen to close it. The timer keeps running and the screen
  stays on, so shaking still works.
- Pressing the side button to lock the phone stops shakes from reaching the
  app until you unlock it. The timer still stops playback on time.
- Don't want the screen on? Turn off **Settings › Keep screen on for shaking**.
- Keeping the screen awake from a Home Screen web app needs **iOS 18.4 or
  later**. On older iOS, set *Settings › Display & Brightness › Auto-Lock* to a
  longer time if you want to shake later into the timer.

## Install on iPhone

1. Open the app's address in **Safari** on your iPhone:
   **https://jaspertwigg.github.io/Audiobooks/** (once GitHub Pages is turned
   on, see below).
2. Tap the **Share** icon, then **Add to Home Screen**. Use "Add to Home
   Screen", not "Add Bookmark", which just reopens Safari.
3. Open **Audiobooks** from the Home Screen icon and tap **＋** to add books.

> **Important:** your books live inside the Home Screen app. Deleting the app
> icon (or clearing Safari website data) deletes the books too. The original
> files in the Files app aren't touched, so you can always add them again.

## Turn on GitHub Pages (one-time)

1. On GitHub, open the **Audiobooks** repository.
2. Tap **Settings** (top bar; on a phone, use "Request Desktop Website" in
   Safari if you can't see it).
3. In the left sidebar, tap **Pages**.
4. Under **Build and deployment**, set **Source** to **Deploy from a branch**.
5. Set **Branch** to **main** and the folder to **/ (root)**, then tap
   **Save**.
6. Wait a minute or two. The page will show "Your site is live at
   https://jaspertwigg.github.io/Audiobooks/".

Updates pushed to `main` go live automatically. The app checks for new versions
every time it opens with signal, so you don't need to reinstall it.

## Testing locally

```bash
python3 -m http.server 8000
```

Then open `http://localhost:8000`. Shake detection, the lock screen controls
and keeping the screen awake need a real iPhone over HTTPS (GitHub Pages).

## Project structure

```
index.html            App shell: library, player, sheets, bedside screen
styles.css            Dark iOS-style UI
app.js                Library storage (IndexedDB), player, sleep timer, shake detection
metadata.js           Reads titles, authors, covers, chapters and durations from MP3/M4B/M4A/WAV
manifest.webmanifest  PWA metadata (name, icons, colours)
service-worker.js     Offline support (network-first, so updates always arrive)
icons/                Home Screen icons
```

No frameworks or build tools: plain HTML, CSS and JavaScript.
