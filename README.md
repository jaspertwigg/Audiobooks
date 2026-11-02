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
  **Share the app** and **Settings**. The sleep timer is in the player.
- **‹ Menu** at the top of the library goes back to it. The mini player at the
  bottom opens the full player from anywhere.

**Library**
- Add audio files from the Files app (iCloud Drive, On My iPhone, Downloads,
  etc.): MP3, M4A, M4B, AAC and WAV.
- After picking files, choose:
  - **New book**. With several files, choose one book that plays straight
    through or separate books. Files are put in order by their names (`Part 2`
    comes before `Part 10`).
  - **Add to an existing book**. The files go on the end, so a new chapter
    slots in after the rest. You can also use **⋯ › Add Files to This Book**
    on a book.
- **Folders**, e.g. one per series: tap **＋ › New Folder**, then
  **⋯ › Move to Folder** on a book. Tap a folder to open it; its books are in
  title order (Book 1, Book 2…). Tapping **＋** inside a folder adds new books
  straight into it. Deleting a folder keeps its books and moves them back to
  the main library.
- **Search** at the top of the library looks through titles, authors, folder
  names, chapter names and file names, including books inside folders.
- Reads the **title, author, cover art and chapters** from the files. Chapter
  markers in `.m4b` and `.mp3` files are supported. In a multi-file book, each
  file is a chapter.
- Progress bar and time left for each book, sort (recent, title, author, date
  added).
- **⋯** on a book: mark finished/unfinished, start over, move to folder, add
  files, rename, delete.

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
- **＋** in the sleep timer panel adds the timer's original length again (or,
  in end-of-chapter mode, carries on to the end of the next chapter).
- The countdown only runs while audio is actually playing, and the phone can
  lock as normal while it counts down. The time left shows on the **lock
  screen**, under the book's title (e.g. "☾ 12 min left").
- **Still awake when it stops?** Press **play** within 15 minutes (on the lock
  screen, in Control Center, by tapping your AirPods/headphones, or in the
  app) and the book carries on with the same timer started again. Pressing
  play later than that just plays. If you switch the timer off yourself,
  play won't bring it back.

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

## Publishing (GitHub Pages)

The site is published by GitHub Actions (`.github/workflows/deploy.yml`) on
every push to `main`, the same as the other JT apps. One-time setting:

1. On GitHub, open the **Audiobooks** repository and tap **Settings** (on a
   phone, use "Request Desktop Website" in Safari if you can't see it).
2. In the left sidebar, tap **Pages**.
3. Under **Build and deployment**, set **Source** to **GitHub Actions**.

The address stays **https://jaspertwigg.github.io/Audiobooks/**. Updates go
live a minute or two after each push, and the app picks them up the next time
it opens with signal, so you don't need to reinstall it.

## Testing locally

```bash
python3 -m http.server 8000
```

Then open `http://localhost:8000`. The lock screen controls need a real iPhone
over HTTPS (GitHub Pages).

## Project structure

```
index.html            App shell: menu, library, player, sheets
styles.css            Dark iOS-style UI
app.js                Library storage (IndexedDB), player, sleep timer
metadata.js           Reads titles, authors, covers, chapters and durations from MP3/M4B/M4A/WAV
manifest.webmanifest  PWA metadata (name, icons, colours)
service-worker.js     Offline support (network-first, so updates always arrive)
icons/                Home Screen icons
```

No frameworks or build tools: plain HTML, CSS and JavaScript.
