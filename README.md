# Audiobooks

A native iPhone app (SwiftUI, iOS 17+) for listening to your own audiobook files.

## Features

**Library**
- Import audio files or whole folders from the Files app, iCloud Drive, AirDrop or "Open in…" (MP3, M4A, M4B, AAC, WAV, AIFF, CAF, FLAC).
- A **folder becomes one book**; its files play back-to-back as a single timeline (sub-folders such as `CD 1`, `CD 2` are included, in natural order).
- You can also drop files straight into **Files › On My iPhone › Audiobooks**, or use Finder's Files tab from a Mac. Pull down on the library to refresh.
- Reads title, author, cover art and **chapter markers** (e.g. from `.m4b` files). For folder books, each file is a chapter. `cover.jpg` / `folder.jpg` in a folder is used as the cover.
- Progress bar and time left for every book, search, sorting (recent, title, author, date added), mark finished, start over, swipe to delete.

**Player**
- Remembers your place in every book.
- Skip back / forward (15s / 30s by default, configurable), previous / next chapter.
- Chapter-aware scrubber, chapter list, and bookmarks.
- Playback speed 0.75× to 3×, with pitch correction.
- **Smart rewind**: steps back a few seconds when you resume after a pause (longer after longer breaks).
- Plays in the background, with lock screen, Control Center, headphone, AirPods and CarPlay controls. Pauses for phone calls and resumes afterwards.

**Sleep timer**
- 5 / 10 / 15 / 20 / 30 / 45 / 60 / 90 minutes, a custom length, or **end of chapter**.
- **Shake your iPhone to extend the timer by its original length.** A 15-minute timer with 2 minutes left becomes 17 minutes. In end-of-chapter mode a shake carries on to the end of the next chapter.
  - This uses Core Motion rather than UIKit's shake gesture, so it **works with the screen locked** while a book is playing.
  - It needs a few firm back-and-forth shakes, so rolling over in bed won't trigger it.
  - You get a vibration to confirm (can be turned off).
- The volume fades out over the last 15 seconds. Shake during the fade to keep listening.
- The countdown pauses whenever playback is paused.

## Running it

Requires a Mac with **Xcode 16 or later**.

1. Open `Audiobooks.xcodeproj`.
2. Select the **Audiobooks** target → *Signing & Capabilities* → choose your Team (a free Apple ID works for your own phone). Change the bundle identifier if Xcode asks.
3. Plug in your iPhone, select it as the run destination, and press **Run** (⌘R).
   - First time only: on the iPhone, trust the developer under *Settings › General › VPN & Device Management*. On iOS 16+ you may also need to turn on *Settings › Privacy & Security › Developer Mode*.

Shake detection needs a real device; the simulator has no motion sensors (use *Device › Shake* there only for UI testing).

## Project layout

```
Audiobooks/
  AudiobooksApp.swift        App entry point, wires up the shared objects
  Models/Book.swift          Book, Track, Chapter, Bookmark
  Services/
    LibraryStore.swift       Importing, scanning the Documents folder, saving state
    MetadataLoader.swift     Durations, titles, authors, chapters and cover art from files
    PlayerEngine.swift       AVPlayer playback over multi-file books, lock-screen controls
    SleepTimer.swift         Countdown, fade-out, extend-on-shake
    ShakeDetector.swift      Core Motion shake detection (works in the background)
  Views/                     Library, player, mini player, sleep timer, chapters, settings
```
