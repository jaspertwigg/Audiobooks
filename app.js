// Audiobooks — an installable web app for listening to your own audiobook files.
// Plain JS, no build step. Audio files are stored on the device in IndexedDB.

(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const FADE_SECONDS = 10;
  const RATES = [0.75, 0.9, 1, 1.1, 1.2, 1.25, 1.3, 1.5, 1.75, 2, 2.5, 3];
  const SLEEP_PRESETS = [5, 10, 15, 20, 30, 45, 60, 90];

  // ================================================================ Settings

  const DEFAULTS = {
    skipBack: 15,
    skipFwd: 30,
    smartRewind: true,
    fade: true,
    rate: 1,
    sort: "recent",
    customMinutes: 20,
    currentBookId: null,
  };
  const settings = Object.assign({}, DEFAULTS, readJSON("ab-settings"));

  function readJSON(key) {
    try {
      return JSON.parse(localStorage.getItem(key)) || {};
    } catch (e) {
      return {};
    }
  }
  function saveSettings() {
    try {
      localStorage.setItem("ab-settings", JSON.stringify(settings));
    } catch (e) {}
  }

  // ================================================================ IndexedDB

  let dbPromise = null;
  function openDB() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open("audiobooks", 2);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains("books")) db.createObjectStore("books", { keyPath: "id" });
          if (!db.objectStoreNames.contains("blobs")) db.createObjectStore("blobs");
          if (!db.objectStoreNames.contains("folders")) db.createObjectStore("folders", { keyPath: "id" });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return dbPromise;
  }

  async function withStore(name, mode, fn) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(name, mode);
      const req = fn(tx.objectStore(name));
      let result;
      if (req) req.onsuccess = () => (result = req.result);
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  const idb = {
    all: (store) => withStore(store, "readonly", (s) => s.getAll()),
    get: (store, key) => withStore(store, "readonly", (s) => s.get(key)),
    put: (store, value, key) => withStore(store, "readwrite", (s) => (key === undefined ? s.put(value) : s.put(value, key))),
    del: (store, key) => withStore(store, "readwrite", (s) => s.delete(key)),
  };

  // ================================================================ Helpers

  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const stripExt = (name) => name.replace(/\.[^.]+$/, "").replace(/[_]+/g, " ").trim();
  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

  function clock(sec) {
    if (!isFinite(sec)) return "--:--";
    const t = Math.max(0, Math.floor(sec));
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const s = t % 60;
    return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
  }
  function short(sec) {
    const t = Math.max(0, Math.floor(sec || 0));
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    if (h) return m ? `${h}h ${m}m` : `${h}h`;
    if (m) return `${m}m`;
    return `${t}s`;
  }
  function minutesLabel(sec) {
    const total = Math.round(sec / 60);
    const h = Math.floor(total / 60);
    const m = total % 60;
    if (!h) return `${m} min`;
    return m ? `${h} hr ${m} min` : `${h} hr`;
  }
  const rateLabel = (r) => `${String(+r.toFixed(2))}×`;

  let toastTimer = null;
  function toast(msg, ms = 2200) {
    const el = $("toast");
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), ms);
  }

  function isAudioFile(file) {
    return /^audio\//.test(file.type) || /\.(mp3|m4a|m4b|aac|mp4|wav|aiff?|caf|flac|ogg|opus)$/i.test(file.name);
  }

  // ================================================================ Library state

  let books = [];
  const coverURLs = new Map(); // coverId -> object URL
  const coverDataURLs = new Map(); // coverId -> data URL (lock screen)

  function bookDuration(book) {
    return book.parts.reduce((sum, p) => sum + (p.duration || 0), 0);
  }
  function partOffset(book, index) {
    let t = 0;
    for (let i = 0; i < index && i < book.parts.length; i++) t += book.parts[i].duration || 0;
    return t;
  }
  function locate(book, time) {
    let acc = 0;
    for (let i = 0; i < book.parts.length; i++) {
      const d = book.parts[i].duration || 0;
      if (time < acc + d || i === book.parts.length - 1) return { index: i, local: Math.max(0, time - acc) };
      acc += d;
    }
    return { index: 0, local: 0 };
  }

  // Chapters in book-global time. Embedded chapter markers are used when present;
  // otherwise each file of a multi-file book is a chapter.
  const chapterCache = new WeakMap();
  function chaptersOf(book) {
    if (!book) return [];
    if (chapterCache.has(book)) return chapterCache.get(book);
    const list = [];
    let offset = 0;
    book.parts.forEach((part) => {
      if (part.chapters && part.chapters.length) {
        part.chapters.forEach((c) => list.push({ title: c.title, start: offset + c.start }));
      } else if (book.parts.length > 1) {
        list.push({ title: part.title || stripExt(part.name), start: offset });
      }
      offset += part.duration || 0;
    });
    list.forEach((c, i) => {
      c.end = i + 1 < list.length ? list[i + 1].start : offset;
      if (!c.title) c.title = `Chapter ${i + 1}`;
    });
    chapterCache.set(book, list);
    return list;
  }
  function chapterIndexAt(book, time) {
    const list = chaptersOf(book);
    let idx = -1;
    for (let i = 0; i < list.length; i++) if (list[i].start <= time + 0.05) idx = i;
    return list.length ? Math.max(idx, 0) : -1;
  }

  function persist(book) {
    return idb.put("books", book).catch((e) => console.warn("save failed", e));
  }

  async function coverURL(book) {
    if (!book.coverId) return null;
    if (coverURLs.has(book.coverId)) return coverURLs.get(book.coverId);
    const blob = await idb.get("blobs", book.coverId);
    if (!blob) return null;
    const url = URL.createObjectURL(blob);
    coverURLs.set(book.coverId, url);
    return url;
  }

  async function coverDataURL(book) {
    if (!book.coverId) return null;
    if (coverDataURLs.has(book.coverId)) return coverDataURLs.get(book.coverId);
    const blob = await idb.get("blobs", book.coverId);
    if (!blob) return null;
    const data = await new Promise((resolve) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => resolve(null);
      r.readAsDataURL(blob);
    });
    if (data) coverDataURLs.set(book.coverId, data);
    return data;
  }

  // Fills an <img class="cover"> (or replaces it with a placeholder) for a book.
  function applyCover(img, book) {
    const hue = [...book.id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
    img.style.setProperty("--hue", hue);
    img.dataset.initial = (book.title || "?").trim().charAt(0).toUpperCase();
    img.classList.add("placeholder");
    img.removeAttribute("src");
    coverURL(book).then((url) => {
      if (url && img.dataset.bookId === book.id) {
        img.src = url;
        img.classList.remove("placeholder");
      }
    });
    img.dataset.bookId = book.id;
  }

  // ================================================================ Importing

  function requestPersistentStorage() {
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  }

  // Fallback when a file's own headers don't tell us its length.
  function probeDuration(blob) {
    return new Promise((resolve) => {
      const a = document.createElement("audio");
      const url = URL.createObjectURL(blob);
      let done = false;
      const finish = (d) => {
        if (done) return;
        done = true;
        URL.revokeObjectURL(url);
        a.removeAttribute("src");
        resolve(isFinite(d) && d > 0 ? d : 0);
      };
      a.preload = "metadata";
      a.onloadedmetadata = () => finish(a.duration);
      a.onerror = () => finish(0);
      setTimeout(() => finish(a.duration), 8000);
      a.src = url;
    });
  }

  async function makeCoverThumbnail(blob) {
    try {
      const bitmap = await createImageBitmap(blob);
      const scale = Math.min(1, 600 / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(bitmap.width * scale);
      canvas.height = Math.round(bitmap.height * scale);
      canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      return await new Promise((resolve) => canvas.toBlob((b) => resolve(b || blob), "image/jpeg", 0.85));
    } catch (e) {
      return blob;
    }
  }

  function setImportStatus(text) {
    $("import-status").textContent = text;
  }

  // Reads and stores each file; returns the parts plus the first file's tags and any cover.
  async function readParts(files, label) {
    const parts = [];
    let first = null;
    let cover = null;
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      setImportStatus(files.length > 1 ? `${label}\nFile ${i + 1} of ${files.length}` : label || `Adding ${file.name}`);
      const meta = await window.AudioMetadata.readMetadata(file);
      const duration = meta.duration || (await probeDuration(file));
      const blobId = uid();
      await idb.put("blobs", file, blobId);
      if (!first) first = meta;
      if (!cover && meta.cover) cover = meta.cover;
      parts.push({
        blobId,
        name: file.name,
        title: meta.title || null,
        track: meta.track || null,
        duration,
        chapters: (meta.chapters || []).map((c) => ({ title: c.title, start: c.start })),
      });
    }
    return { parts, first, cover };
  }

  async function importBook(files, label, folderId) {
    const { parts, first, cover } = await readParts(files, label);

    let title;
    if (files.length > 1) title = first.album || commonTitle(files.map((f) => stripExt(f.name)));
    else title = first.title || first.album || stripExt(files[0].name);

    const book = {
      id: uid(),
      title: title || stripExt(files[0].name),
      author: first.artist || first.albumArtist || first.composer || "",
      coverId: null,
      parts,
      position: 0,
      finished: false,
      added: Date.now(),
      lastPlayed: 0,
      pausedAt: 0,
      bookmarks: [],
      folderId: folderId || null,
    };
    if (cover) {
      book.coverId = uid();
      await idb.put("blobs", await makeCoverThumbnail(cover), book.coverId);
    }
    await persist(book);
    books.push(book);
    return book;
  }

  // Adds files to the end of an existing book (e.g. a new chapter).
  async function appendToBook(book, files) {
    const { parts, cover } = await readParts(files, `Adding to ${book.title}`);
    book.parts.push(...parts);
    chapterCache.delete(book);
    if (book.finished) book.finished = false;
    if (!book.coverId && cover) {
      book.coverId = uid();
      await idb.put("blobs", await makeCoverThumbnail(cover), book.coverId);
    }
    await persist(book);
    if (current && current.id === book.id) {
      updatePositionState();
      if (playerOpen) renderPlayer();
    }
  }

  // "Harry Potter 01", "Harry Potter 02" -> "Harry Potter"
  function commonTitle(names) {
    if (!names.length) return "";
    let prefix = names[0];
    for (const n of names) while (!n.startsWith(prefix)) prefix = prefix.slice(0, -1);
    prefix = prefix.replace(/[\s\-_.:(\[]*(part|chapter|track|cd|disc|pt)?[\s\-_.]*\d*$/i, "").trim();
    return prefix.length >= 3 ? prefix : names[0];
  }

  async function handleFiles(fileList) {
    const files = [...fileList].filter(isAudioFile);
    if (!files.length) {
      toast("Those don't look like audio files");
      return;
    }
    files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));

    const folderId = importFolderId;
    importFolderId = null;
    const directTarget = addToBookId && books.find((b) => b.id === addToBookId);
    addToBookId = null;
    if (directTarget) {
      requestPersistentStorage();
      $("import-overlay").hidden = false;
      try {
        await appendToBook(directTarget, files);
        toast(`Added ${files.length === 1 ? "1 file" : `${files.length} files`} to ${directTarget.title}`);
      } catch (e) {
        console.error(e);
        alert("Something went wrong adding that file: " + (e && e.message ? e.message : e));
      } finally {
        $("import-overlay").hidden = true;
        clearFileInput();
      }
      renderLibrary();
      return;
    }
    const options = files.length > 1
      ? [
          { label: `New book (${files.length} parts)`, value: "one" },
          { label: `${files.length} separate new books`, value: "many" },
        ]
      : [{ label: "New book", value: "one" }];
    if (books.length) options.push({ label: "Add to an existing book…", value: "existing" });

    let choice = "one";
    if (options.length > 1) {
      choice = await chooseAction(files.length > 1 ? `${files.length} files selected` : files[0].name, options);
      if (!choice) return clearFileInput();
    }

    let target = null;
    if (choice === "existing") {
      target = await chooseBook("Add to which book?", folderId);
      if (!target) return clearFileInput();
    }

    requestPersistentStorage();
    $("import-overlay").hidden = false;
    let message = "";
    try {
      if (target) {
        await appendToBook(target, files);
        message = `Added ${files.length === 1 ? "1 file" : `${files.length} files`} to ${target.title}`;
      } else if (choice === "one") {
        await importBook(files, "Adding book", folderId);
        message = "Book added";
      } else {
        for (let i = 0; i < files.length; i++) {
          await importBook([files[i]], `Adding book ${i + 1} of ${files.length}`, folderId);
        }
        message = `${files.length} books added`;
      }
    } catch (e) {
      console.error(e);
      const quota = e && (e.name === "QuotaExceededError" || /quota/i.test(e.message || ""));
      alert(quota
        ? "There isn't enough storage space on this iPhone to add that. Free up some space and try again."
        : "Something went wrong adding that file: " + (e && e.message ? e.message : e));
    } finally {
      $("import-overlay").hidden = true;
      clearFileInput();
    }
    if (message) {
      $("search").value = "";
      showView("library", { folderId: target ? target.folderId : folderId });
      toast(message);
    }
    renderLibrary();
  }

  function clearFileInput() {
    $("file-input").value = "";
  }

  // Opens the file picker; new books land in `folderId` (or the main library).
  let importFolderId = null;
  let addToBookId = null;
  function pickFiles(folderId) {
    importFolderId = folderId || null;
    addToBookId = null;
    $("file-input").click();
  }

  // Lets you pick a book; books in `preferFolderId` are listed first.
  function chooseBook(title, preferFolderId) {
    const list = books.slice().sort((a, b) => {
      const fa = a.folderId === preferFolderId && preferFolderId ? 0 : 1;
      const fb = b.folderId === preferFolderId && preferFolderId ? 0 : 1;
      return fa - fb || (b.lastPlayed || b.added) - (a.lastPlayed || a.added);
    });
    return chooseAction(title, list.map((b) => {
      const folder = folderOf(b);
      return { label: b.title, sub: [b.author, folder && `📁 ${folder.name}`].filter(Boolean).join(" · "), value: b.id };
    })).then((id) => books.find((b) => b.id === id) || null);
  }

  async function deleteBook(book) {
    if (current && current.id === book.id) unloadBook();
    for (const p of book.parts) await idb.del("blobs", p.blobId).catch(() => {});
    if (book.coverId) {
      await idb.del("blobs", book.coverId).catch(() => {});
      const url = coverURLs.get(book.coverId);
      if (url) URL.revokeObjectURL(url);
      coverURLs.delete(book.coverId);
      coverDataURLs.delete(book.coverId);
    }
    await idb.del("books", book.id);
    books = books.filter((b) => b.id !== book.id);
    renderLibrary();
  }

  // ================================================================ Folders (e.g. a series)

  let folders = [];
  let openFolderId = null;

  const folderOf = (book) => (book.folderId && folders.find((f) => f.id === book.folderId)) || null;
  const booksIn = (folder) => books.filter((b) => b.folderId === folder.id);

  async function createFolder(suggested) {
    const name = prompt("Folder name (for example, a series)", suggested || "");
    if (!name || !name.trim()) return null;
    const folder = { id: uid(), name: name.trim(), created: Date.now() };
    folders.push(folder);
    await idb.put("folders", folder);
    return folder;
  }

  async function moveToFolder(book, folderId) {
    book.folderId = folderId || null;
    await persist(book);
  }

  async function folderActions(folder) {
    const choice = await chooseAction(folder.name, [
      { label: "Rename Folder…", value: "rename" },
      { label: "Delete Folder (keep its books)", value: "delete", danger: true },
    ]);
    if (choice === "rename") {
      const name = prompt("Folder name", folder.name);
      if (name && name.trim()) {
        folder.name = name.trim();
        await idb.put("folders", folder);
      }
    } else if (choice === "delete") {
      const inside = booksIn(folder);
      if (!confirm(`Delete the folder “${folder.name}”? ${inside.length ? `Its ${inside.length} book${inside.length === 1 ? "" : "s"} will move back to the main library.` : ""}`)) return;
      for (const b of inside) await moveToFolder(b, null);
      folders = folders.filter((f) => f.id !== folder.id);
      await idb.del("folders", folder.id);
      if (openFolderId === folder.id) return showView("library");
    }
    renderLibrary();
  }

  async function chooseFolderFor(book) {
    const options = folders
      .filter((f) => f.id !== book.folderId)
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
      .map((f) => ({ label: `📁 ${f.name}`, value: f.id }));
    options.push({ label: "＋ New Folder…", value: "new" });
    if (book.folderId) options.push({ label: "Remove from Folder", value: "none" });
    const choice = await chooseAction(`Move “${book.title}” to`, options);
    if (!choice) return;
    if (choice === "new") {
      const folder = await createFolder(book.author ? "" : "");
      if (!folder) return;
      await moveToFolder(book, folder.id);
      toast(`Moved to ${folder.name}`);
    } else if (choice === "none") {
      await moveToFolder(book, null);
      toast("Moved to the main library");
    } else {
      await moveToFolder(book, choice);
      toast(`Moved to ${folders.find((f) => f.id === choice).name}`);
    }
    renderLibrary();
  }

  async function addMenu() {
    const folder = openFolderId && folders.find((f) => f.id === openFolderId);
    const options = [{
      label: folder ? `Add Audiobook Files to “${folder.name}”` : "Add Audiobook Files",
      value: "files",
      now: () => pickFiles(folder ? folder.id : null),
    }];
    if (!folder) options.push({ label: "New Folder", value: "folder" });
    const choice = await chooseAction("Add", options);
    if (choice === "folder") {
      const f = await createFolder();
      if (f) {
        toast(`Folder “${f.name}” created. Use ⋯ › Move to Folder on a book to add it.`, 3500);
        renderLibrary();
      }
    }
  }

  // ================================================================ Player

  const audio = $("audio");
  let current = null; // the loaded book
  let partIndex = -1;
  let partURL = null;
  let pendingSeek = null; // local time to apply once the part's metadata loads
  let loadToken = 0;
  let switchingPart = false;
  let lastSaved = 0;
  let unlocked = false;

  // iOS 17+: keep playing with the silent switch on, like a proper audio app.
  try {
    if (navigator.audioSession) navigator.audioSession.type = "playback";
  } catch (e) {}

  // A tiny silent WAV, played inside a tap so the audio element is allowed to
  // start playback later (after we've fetched the file from storage).
  const SILENT_WAV = (() => {
    const samples = 800;
    const buf = new ArrayBuffer(44 + samples);
    const v = new DataView(buf);
    const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
    w(0, "RIFF"); v.setUint32(4, 36 + samples, true); w(8, "WAVE"); w(12, "fmt ");
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, 8000, true); v.setUint32(28, 8000, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true);
    w(36, "data"); v.setUint32(40, samples, true);
    for (let i = 0; i < samples; i++) v.setUint8(44 + i, 128);
    let bin = "";
    new Uint8Array(buf).forEach((b) => (bin += String.fromCharCode(b)));
    return "data:audio/wav;base64," + btoa(bin);
  })();

  // `force`: we're about to switch to a different file asynchronously, so unlock
  // with the silent clip even if a file is already loaded.
  function unlockAudio(force) {
    if (unlocked) return;
    if (audio.src && audio.src !== SILENT_WAV && !force) return; // play() will run directly in this tap
    unlocked = true;
    audio.src = SILENT_WAV;
    audio.play().catch(() => {});
  }

  const isPlaying = () => switchingPart || !audio.paused;

  function livePosition() {
    if (!current) return 0;
    if (pendingSeek == null && (!audio.src || audio.src === SILENT_WAV)) return current.position || 0;
    const local = pendingSeek != null ? pendingSeek : audio.currentTime || 0;
    return partOffset(current, Math.max(partIndex, 0)) + local;
  }

  function currentChapter() {
    if (!current) return null;
    const i = chapterIndexAt(current, livePosition());
    return i >= 0 ? chaptersOf(current)[i] : null;
  }

  function applyRate() {
    audio.defaultPlaybackRate = settings.rate;
    audio.playbackRate = settings.rate;
  }

  async function loadPart(index, local, autoplay) {
    const token = ++loadToken;
    partIndex = index;
    pendingSeek = local;
    switchingPart = autoplay;
    const blob = await idb.get("blobs", current.parts[index].blobId);
    if (token !== loadToken) return;
    if (!blob) {
      switchingPart = false;
      toast("This book's audio file is missing");
      return;
    }
    if (partURL) URL.revokeObjectURL(partURL);
    partURL = URL.createObjectURL(blob);
    audio.src = partURL;
    applyRate();
    audio.load();
    if (autoplay) {
      try {
        await audio.play();
      } catch (e) {
        if (token === loadToken) toast("Tap play to start");
      }
    }
    if (token === loadToken) switchingPart = false;
    renderPlayState();
  }

  function seekTo(time, { autoplay } = {}) {
    if (!current || !current.parts.length) return;
    const total = bookDuration(current);
    const t = clamp(time, 0, total > 0 ? Math.max(total - 0.25, 0) : time);
    const { index, local } = locate(current, t);
    const play = autoplay != null ? autoplay : isPlaying();
    if (index !== partIndex || !audio.src || audio.src === SILENT_WAV) {
      loadPart(index, local, play);
    } else if (pendingSeek != null) {
      pendingSeek = local;
    } else {
      audio.currentTime = local;
    }
    current.position = t;
    savePosition(true);
    renderProgress();
    updatePositionState();
  }

  function openBook(book, { autoplay = true } = {}) {
    if (current && current.id === book.id) {
      if (autoplay && !isPlaying()) play();
      return;
    }
    savePosition(true);
    audio.pause();
    current = book;
    settings.currentBookId = book.id;
    saveSettings();
    partIndex = -1;
    if (book.finished) {
      book.finished = false;
      book.position = 0;
    }
    if (autoplay) {
      book.lastPlayed = Date.now();
      book.pausedAt = 0;
    }
    persist(book);
    seekTo(book.position || 0, { autoplay });
    updateMediaSession();
    renderPlayer();
    renderMini();
  }

  function unloadBook() {
    loadToken++;
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
    if (partURL) URL.revokeObjectURL(partURL);
    partURL = null;
    current = null;
    partIndex = -1;
    pendingSeek = null;
    settings.currentBookId = null;
    saveSettings();
    stopSleep();
    if ("mediaSession" in navigator) navigator.mediaSession.metadata = null;
    closePlayer();
    renderMini();
  }

  function play() {
    if (!current) return;
    unlockAudio();
    const restart = takeSleepRestart();
    const total = bookDuration(current);
    let pos = livePosition();
    if (total && pos >= total - 1) {
      pos = 0;
      seekTo(0, { autoplay: true });
    } else if (settings.smartRewind && current.pausedAt) {
      const away = (Date.now() - current.pausedAt) / 1000;
      const back = away > 3600 ? 30 : away > 300 ? 10 : away > 30 ? 3 : 0;
      if (back) seekTo(pos - back, { autoplay: true });
    }
    current.pausedAt = 0;
    current.lastPlayed = Date.now();
    persist(current);
    if (!audio.src || audio.src === SILENT_WAV || switchingPart) {
      if (!switchingPart) seekTo(livePosition(), { autoplay: true });
    } else {
      applyRate();
      unlocked = true;
      audio.play().catch(() => toast("Tap play to start"));
    }
    renderPlayState();
    if (restart) restartSleep(restart);
  }

  function pause() {
    switchingPart = false;
    audio.pause();
    renderPlayState();
  }

  const togglePlay = () => (isPlaying() ? pause() : play());

  function skip(seconds) {
    if (!current) return;
    seekTo(livePosition() + seconds);
  }

  function nextChapter() {
    if (!current) return;
    const list = chaptersOf(current);
    const i = chapterIndexAt(current, livePosition());
    if (i >= 0 && i + 1 < list.length) seekTo(list[i + 1].start);
  }

  function previousChapter() {
    if (!current) return;
    const list = chaptersOf(current);
    const pos = livePosition();
    const i = chapterIndexAt(current, pos);
    if (i < 0) return seekTo(0);
    if (pos - list[i].start > 3 || i === 0) seekTo(list[i].start);
    else seekTo(list[i - 1].start);
  }

  function savePosition(force) {
    if (!current) return;
    const now = Date.now();
    if (!force && now - lastSaved < 5000) return;
    lastSaved = now;
    current.position = livePosition();
    persist(current);
  }

  function addBookmark() {
    if (!current) return;
    const pos = livePosition();
    const ch = currentChapter();
    current.bookmarks = current.bookmarks || [];
    current.bookmarks.push({ id: uid(), position: pos, note: ch ? ch.title : "Bookmark", created: Date.now() });
    persist(current);
    toast(`Bookmark added at ${clock(pos)}`);
  }

  // ---- audio element events

  audio.addEventListener("loadedmetadata", () => {
    if (!current || audio.src === SILENT_WAV) return;
    const part = current.parts[partIndex];
    if (part && isFinite(audio.duration) && audio.duration > 0 && Math.abs(audio.duration - (part.duration || 0)) > 1) {
      // Trust the browser's measurement over our estimate.
      part.duration = audio.duration;
      chapterCache.delete(current);
      persist(current);
    }
    if (pendingSeek != null) {
      try {
        audio.currentTime = pendingSeek;
      } catch (e) {}
      pendingSeek = null;
    }
    applyRate();
  });

  audio.addEventListener("timeupdate", () => {
    if (!current || pendingSeek != null || audio.src === SILENT_WAV) return;
    current.position = livePosition();
    savePosition(false);
    sleepTick();
    if (playerOpen) renderProgress();
    renderMiniProgress();
    maybeUpdateChapterInfo();
  });

  audio.addEventListener("play", () => {
    renderPlayState();
    updatePositionState();
  });

  audio.addEventListener("pause", () => {
    if (audio.ended || switchingPart || audio.src === SILENT_WAV || !current) return;
    sleepTick();
    current.pausedAt = Date.now();
    savePosition(true);
    renderPlayState();
  });

  audio.addEventListener("ended", () => {
    if (!current || audio.src === SILENT_WAV) return;
    if (partIndex + 1 < current.parts.length) {
      loadPart(partIndex + 1, 0, true);
    } else {
      current.finished = true;
      current.position = bookDuration(current);
      current.pausedAt = 0;
      persist(current);
      stopSleep();
      renderPlayState();
      toast("Finished — well done!");
    }
  });

  audio.addEventListener("error", () => {
    if (!current || audio.src === SILENT_WAV || !audio.src) return;
    switchingPart = false;
    renderPlayState();
    toast("This file can't be played on this device");
  });

  // ---- lock screen / Control Center / headphones

  let lastChapterIndex = -2;
  function maybeUpdateChapterInfo() {
    const i = current ? chapterIndexAt(current, livePosition()) : -1;
    if (i !== lastChapterIndex) {
      lastChapterIndex = i;
      updateMediaSession();
      if (playerOpen) renderPlayer();
      renderMini();
    }
  }

  async function updateMediaSession() {
    if (!("mediaSession" in navigator) || !current) return;
    const book = current;
    const ch = currentChapter();
    const art = await coverDataURL(book);
    if (book !== current) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: book.title,
      artist: [sleepLockScreenText(), ch ? ch.title : book.author || ""].filter(Boolean).join(" · "),
      album: book.author || book.title,
      artwork: art
        ? [{ src: art, sizes: "600x600", type: "image/jpeg" }]
        : [{ src: "icons/icon-512.png", sizes: "512x512", type: "image/png" }],
    });
    updatePositionState();
  }

  function updatePositionState() {
    if (!("mediaSession" in navigator) || !navigator.mediaSession.setPositionState || !current) return;
    const duration = bookDuration(current);
    if (!duration) return;
    try {
      navigator.mediaSession.setPositionState({
        duration,
        position: clamp(livePosition(), 0, duration),
        playbackRate: settings.rate,
      });
    } catch (e) {}
  }

  if ("mediaSession" in navigator) {
    const handlers = {
      play: () => play(),
      pause: () => pause(),
      seekbackward: (d) => skip(-(d && d.seekOffset ? d.seekOffset : settings.skipBack)),
      seekforward: (d) => skip(d && d.seekOffset ? d.seekOffset : settings.skipFwd),
      seekto: (d) => d && d.seekTime != null && seekTo(d.seekTime),
    };
    for (const [action, fn] of Object.entries(handlers)) {
      try {
        navigator.mediaSession.setActionHandler(action, fn);
      } catch (e) {}
    }
  }

  // ================================================================ Sleep timer

  const sleep = { mode: "off", original: 0, remaining: 0, chapterEnd: 0, lastTick: 0 };
  let sleepInterval = null;
  let volumeWorks = null;

  function canSetVolume() {
    if (volumeWorks === null) {
      // iOS ignores audio.volume (the hardware buttons own it).
      const before = audio.volume;
      audio.volume = 0.5;
      volumeWorks = audio.volume === 0.5;
      audio.volume = before;
    }
    return volumeWorks;
  }
  function setVolume(v) {
    if (canSetVolume()) audio.volume = clamp(v, 0, 1);
  }

  function startSleep(seconds) {
    sleep.mode = "duration";
    sleep.original = seconds;
    sleep.remaining = seconds;
    beginSleep();
  }

  // `after`: when restarting, play to the end of the chapter that follows the
  // one the timer last stopped at (smart rewind may have stepped back into it).
  function startSleepAtChapterEnd(after) {
    const ch = after != null
      ? chaptersOf(current).find((c) => c.start >= after - 0.5) || currentChapter()
      : currentChapter();
    if (!ch) return;
    sleep.mode = "chapter";
    sleep.original = 0;
    sleep.chapterEnd = ch.end;
    sleep.remaining = Math.max(0, (ch.end - livePosition()) / settings.rate);
    beginSleep();
  }

  function beginSleep() {
    clearSleepRestart();
    lastLockMinute = null;
    sleep.lastTick = Date.now();
    setVolume(1);
    clearInterval(sleepInterval);
    sleepInterval = setInterval(sleepTick, 250);
    if (!isPlaying()) play();
    renderSleep();
  }

  function stopSleep() {
    sleep.mode = "off";
    sleep.remaining = 0;
    clearInterval(sleepInterval);
    sleepInterval = null;
    setVolume(1);
    renderSleep();
    updateMediaSession();
  }

  function sleepTick() {
    if (sleep.mode === "off") return;
    const now = Date.now();
    const delta = (now - sleep.lastTick) / 1000;
    sleep.lastTick = now;
    const playing = !audio.paused;

    if (sleep.mode === "duration") {
      if (playing) sleep.remaining = Math.max(0, sleep.remaining - delta);
    } else {
      sleep.remaining = Math.max(0, (sleep.chapterEnd - livePosition()) / settings.rate);
    }

    if (sleep.mode === "duration" && settings.fade && playing && sleep.remaining < FADE_SECONDS) {
      setVolume(sleep.remaining / FADE_SECONDS);
    }

    if (sleep.remaining <= 0) {
      const ended = { mode: sleep.mode, original: sleep.original, chapterEnd: sleep.chapterEnd, at: Date.now() };
      pause();
      stopSleep();
      settings.sleepRestart = ended;
      saveSettings();
      toast(`Sleep timer ended. Press play within ${RESTART_MINUTES} min to start it again.`, 4000);
      return;
    }
    renderSleepCountdown();

    // Keep the lock screen countdown current (it shows whole minutes).
    const minute = Math.ceil(sleep.remaining / 60);
    if (minute !== lastLockMinute) {
      lastLockMinute = minute;
      updateMediaSession();
    }
  }

  // ---- press play soon after the timer ends to start it again

  const RESTART_MINUTES = 15;
  let lastLockMinute = null;

  function takeSleepRestart() {
    const r = settings.sleepRestart;
    if (!r || sleep.mode !== "off") return null;
    clearSleepRestart();
    return Date.now() - r.at <= RESTART_MINUTES * 60 * 1000 ? r : null;
  }

  function clearSleepRestart() {
    if (!settings.sleepRestart) return;
    settings.sleepRestart = null;
    saveSettings();
  }

  function restartSleep(r) {
    if (r.mode === "chapter") {
      startSleepAtChapterEnd(r.chapterEnd);
      toast("Sleep timer restarted: end of this chapter");
    } else {
      startSleep(r.original);
      toast(`Sleep timer restarted: ${minutesLabel(r.original)}`);
    }
  }

  function sleepLockScreenText() {
    if (sleep.mode === "off") return "";
    if (sleep.mode === "chapter") return "☾ end of chapter";
    const m = Math.ceil(sleep.remaining / 60);
    return m <= 1 ? "☾ under 1 min left" : `☾ ${m} min left`;
  }

  function extendSleep() {
    if (sleep.mode === "off") return;
    if (sleep.mode === "duration") {
      sleep.remaining += sleep.original;
    } else {
      const next = chaptersOf(current).find((c) => c.start >= sleep.chapterEnd - 0.5);
      sleep.chapterEnd = next ? next.end : bookDuration(current);
      sleep.remaining = Math.max(0, (sleep.chapterEnd - livePosition()) / settings.rate);
    }
    setVolume(1);
    lastLockMinute = null;
    toast(sleep.mode === "duration" ? `Sleep timer +${minutesLabel(sleep.original)}` : "Playing to the end of the next chapter");
    renderSleep();
  }

  // ================================================================ Rendering: library

  const byTitle = (a, b) => a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: "base" });

  function sortBooks(list) {
    switch (settings.sort) {
      case "title":
        return list.sort(byTitle);
      case "author":
        return list.sort((a, b) => (a.author || "~").localeCompare(b.author || "~") || byTitle(a, b));
      case "added":
        return list.sort((a, b) => b.added - a.added);
      default:
        return list.sort((a, b) => (b.lastPlayed || b.added) - (a.lastPlayed || a.added));
    }
  }

  // Search looks at the title, author, folder, chapter names and file names.
  function matches(book, words) {
    const folder = folderOf(book);
    const hay = [
      book.title,
      book.author,
      folder && folder.name,
      ...chaptersOf(book).map((c) => c.title),
      ...book.parts.map((p) => p.name),
    ].filter(Boolean).join("\n").toLowerCase();
    return words.every((w) => hay.includes(w));
  }

  function bookStatus(book) {
    const total = bookDuration(book);
    if (book.finished) return "Finished";
    if (!book.position || book.position < 1) return `${short(total)} · New`;
    return `${short(total - book.position)} left`;
  }

  function bookRow(book, { showFolder } = {}) {
    const total = bookDuration(book);
    const progress = book.finished ? 1 : total ? clamp(book.position / total, 0, 1) : 0;
    const li = document.createElement("li");
    li.className = "book" + (current && current.id === book.id ? " current" : "");
    li.innerHTML = `
      <button class="book-main">
        <img class="cover" alt="" />
        <span class="book-text">
          <span class="book-title"></span>
          <span class="book-author"></span>
          <span class="book-progress">
            <span class="bar"><i style="width:${(progress * 100).toFixed(1)}%"></i></span>
            <span class="book-status"></span>
          </span>
        </span>
        <span class="now-badge" aria-hidden="true">${current && current.id === book.id ? "♪" : ""}</span>
      </button>
      <button class="book-more icon-btn" aria-label="More options">⋯</button>`;
    const folder = showFolder && folderOf(book);
    li.querySelector(".book-title").textContent = book.title;
    li.querySelector(".book-author").textContent = [book.author, folder && `📁 ${folder.name}`].filter(Boolean).join(" · ");
    li.querySelector(".book-status").textContent = bookStatus(book);
    if (book.finished) li.querySelector(".bar").classList.add("done");
    applyCover(li.querySelector(".cover"), book);
    li.querySelector(".book-main").addEventListener("click", () => {
      unlockAudio(!current || current.id !== book.id);
      openBook(book, { autoplay: true });
      openPlayer();
    });
    li.querySelector(".book-more").addEventListener("click", () => bookActions(book));
    return li;
  }

  function folderRow(folder) {
    const inside = booksIn(folder);
    const finished = inside.filter((b) => b.finished).length;
    const li = document.createElement("li");
    li.className = "book folder";
    li.innerHTML = `
      <button class="book-main">
        <span class="cover folder-cover" aria-hidden="true">📁</span>
        <span class="book-text">
          <span class="book-title"></span>
          <span class="book-author"></span>
        </span>
        <span class="option-chevron" aria-hidden="true">›</span>
      </button>
      <button class="book-more icon-btn" aria-label="Folder options">⋯</button>`;
    li.querySelector(".book-title").textContent = folder.name;
    li.querySelector(".book-author").textContent = inside.length
      ? `${inside.length} book${inside.length === 1 ? "" : "s"}${finished ? ` · ${finished} finished` : ""}`
      : "Empty";
    li.querySelector(".book-main").addEventListener("click", () => {
      $("search").value = "";
      showView("library", { folderId: folder.id });
    });
    li.querySelector(".book-more").addEventListener("click", () => folderActions(folder));
    return li;
  }

  function renderLibrary() {
    const list = $("book-list");
    list.innerHTML = "";
    const folder = openFolderId && folders.find((f) => f.id === openFolderId);
    if (openFolderId && !folder) openFolderId = null;

    $("library-title").textContent = folder ? folder.name : "Library";
    $("home-btn").textContent = folder ? "‹ Library" : "‹ Menu";
    $("home-btn").setAttribute("aria-label", folder ? "Back to library" : "Back to menu");
    $("search").placeholder = folder ? `Search ${folder.name}` : "Search title, author, chapter…";
    $("sort").value = settings.sort;
    $("sort").hidden = !!folder;
    const anything = books.length > 0 || folders.length > 0;
    $("library-tools").hidden = !anything;
    $("empty-state").hidden = anything;

    const words = $("search").value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    let shown = 0;
    if (words.length) {
      // Search results: matching folders, then matching books from everywhere (or this folder).
      if (!folder) {
        folders
          .filter((f) => words.every((w) => f.name.toLowerCase().includes(w)))
          .forEach((f) => (list.appendChild(folderRow(f)), shown++));
      }
      sortBooks(books.filter((b) => (!folder || b.folderId === folder.id) && matches(b, words)))
        .forEach((b) => (list.appendChild(bookRow(b, { showFolder: !folder })), shown++));
      $("folder-empty").hidden = true;
      $("search-empty").hidden = shown > 0;
    } else if (folder) {
      // Inside a folder: books in title order (Book 1, Book 2…).
      booksIn(folder).sort(byTitle).forEach((b) => (list.appendChild(bookRow(b)), shown++));
      $("folder-empty").hidden = shown > 0;
      $("search-empty").hidden = true;
    } else {
      folders
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }))
        .forEach((f) => list.appendChild(folderRow(f)));
      sortBooks(books.filter((b) => !folderOf(b))).forEach((b) => list.appendChild(bookRow(b)));
      $("folder-empty").hidden = true;
      $("search-empty").hidden = true;
    }
    renderStorage();
    renderHome();
  }

  async function renderStorage() {
    if (!navigator.storage || !navigator.storage.estimate) return;
    try {
      const { usage, quota } = await navigator.storage.estimate();
      const gb = (n) => (n / 1e9 >= 1 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`);
      const text = books.length ? `${books.length} book${books.length === 1 ? "" : "s"} · ${gb(usage)} used` : "";
      $("storage-note").textContent = text;
      $("storage-detail").textContent = `Using ${gb(usage)} of about ${gb(quota)} available to this app.`;
    } catch (e) {}
  }

  async function bookActions(book) {
    const choice = await chooseAction(book.title, [
      { label: book.finished ? "Mark as Unfinished" : "Mark as Finished", value: "finish" },
      { label: "Start Over", value: "restart" },
      { label: book.folderId ? "Move to Another Folder…" : "Move to Folder…", value: "move" },
      { label: "Add Files to This Book…", value: "add", now: () => {
        pickFiles(null);
        addToBookId = book.id;
      } },
      { label: "Rename…", value: "rename" },
      { label: "Delete Book", value: "delete", danger: true },
    ]);
    if (choice === "finish") {
      book.finished = !book.finished;
      if (!book.finished && book.position >= bookDuration(book) - 1) book.position = 0;
      persist(book);
    } else if (choice === "restart") {
      book.finished = false;
      book.position = 0;
      persist(book);
      if (current && current.id === book.id) seekTo(0);
    } else if (choice === "rename") {
      const title = prompt("Book title", book.title);
      if (title && title.trim()) book.title = title.trim();
      const author = prompt("Author", book.author || "");
      if (author !== null) book.author = author.trim();
      persist(book);
      if (current && current.id === book.id) {
        updateMediaSession();
        renderPlayer();
        renderMini();
      }
    } else if (choice === "move") {
      return chooseFolderFor(book);
    } else if (choice === "add") {
      return;
    } else if (choice === "delete") {
      if (confirm(`Delete “${book.title}”? Its audio will be removed from this iPhone.`)) await deleteBook(book);
      return;
    }
    renderLibrary();
  }

  // ================================================================ Home (landing page)

  function viewFromHash() {
    const m = location.hash.match(/^#\/library(?:\/f\/([\w-]+))?$/);
    return m ? { name: "library", folderId: m[1] || null } : { name: "home", folderId: null };
  }

  function showView(name, { fromHash, folderId } = {}) {
    const library = name === "library";
    openFolderId = library ? folderId || null : null;
    $("home").hidden = library;
    $("library").hidden = !library;
    $("library-header").hidden = !library;
    if (!fromHash) {
      const hash = library ? (openFolderId ? `#/library/f/${openFolderId}` : "#/library") : "#/";
      if (location.hash !== hash) history.pushState(null, "", hash);
    }
    window.scrollTo(0, 0);
    if (library) renderLibrary();
    else renderHome();
  }

  async function shareApp() {
    const url = location.href.split("#")[0];
    if (navigator.share) {
      try {
        await navigator.share({ title: "Audiobooks", text: "An audiobook player for your iPhone", url });
      } catch (e) {}
    } else if (navigator.clipboard) {
      await navigator.clipboard.writeText(url).catch(() => {});
      toast("Link copied");
    }
  }

  function lastBook() {
    if (current) return current;
    return books.slice().sort((a, b) => (b.lastPlayed || 0) - (a.lastPlayed || 0)).find((b) => b.lastPlayed) || null;
  }

  function homeOption(icon, title, sub, onClick) {
    const b = document.createElement("button");
    b.className = "option";
    b.innerHTML = `<span class="option-icon"></span><span class="option-text"><span class="option-title"></span><span class="option-sub"></span></span><span class="option-chevron">›</span>`;
    b.querySelector(".option-icon").textContent = icon;
    b.querySelector(".option-title").textContent = title;
    b.querySelector(".option-sub").textContent = sub;
    b.addEventListener("click", onClick);
    return b;
  }

  function renderHome() {
    if ($("home").hidden) return;
    const box = $("home-options");
    box.innerHTML = "";
    const resume = lastBook();
    if (resume) {
      const ch = resume === current ? currentChapter() : null;
      const left = Math.max(bookDuration(resume) - (resume === current ? livePosition() : resume.position || 0), 0);
      const sub = resume.finished ? `${resume.title} · finished` : `${resume.title} · ${ch ? ch.title : `${short(left)} left`}`;
      const playing = resume === current && isPlaying();
      box.appendChild(homeOption(playing ? "🎧" : "▶️", playing ? "Now playing" : "Continue listening", sub, () => {
        unlockAudio(!current || current.id !== resume.id);
        openBook(resume, { autoplay: true });
        openPlayer();
      }));
    }
    box.appendChild(homeOption("➕", "Add a book", "New book, or more files for one you have", () => pickFiles(null)));
    box.appendChild(homeOption("📚", "Audiobook library",
      books.length
        ? `${books.length} book${books.length === 1 ? "" : "s"}${folders.length ? ` · ${folders.length} folder${folders.length === 1 ? "" : "s"}` : ""} · search`
        : "No books yet",
      () => showView("library")));
    box.appendChild(homeOption("🔗", "Share the app", "Send the link to someone", shareApp));
    box.appendChild(homeOption("⚙️", "Settings", "Skip times and smart rewind", () => {
      renderSettings();
      openSheet("settings-sheet");
    }));
  }

  // ================================================================ Rendering: player

  let playerOpen = false;
  let scrubbing = false;

  function openPlayer() {
    if (!current) return;
    playerOpen = true;
    $("player").classList.add("open");
    $("player").setAttribute("aria-hidden", "false");
    renderPlayer();
  }
  function closePlayer() {
    playerOpen = false;
    $("player").classList.remove("open");
    $("player").setAttribute("aria-hidden", "true");
    $("player").style.transform = "";
    renderLibrary();
  }

  function scrubRange() {
    const ch = currentChapter();
    if (ch && ch.end - ch.start > 1) return { start: ch.start, end: ch.end, chapter: true };
    return { start: 0, end: Math.max(bookDuration(current), 1), chapter: false };
  }

  function renderPlayer() {
    if (!current) return;
    $("player-title").textContent = current.title;
    $("player-author").textContent = current.author || "";
    applyCover($("player-cover"), current);
    const ch = currentChapter();
    const hasChapters = chaptersOf(current).length > 0;
    $("chapter-btn").hidden = !ch;
    if (ch) $("chapter-btn").textContent = ch.title + "  ›";
    $("prev-chapter").disabled = !hasChapters;
    $("next-chapter").disabled = !hasChapters;
    $("list-label").textContent = hasChapters ? "Chapters" : "Bookmarks";
    $("skip-back-label").textContent = settings.skipBack;
    $("skip-fwd-label").textContent = settings.skipFwd;
    $("skip-back").setAttribute("aria-label", `Back ${settings.skipBack} seconds`);
    $("skip-fwd").setAttribute("aria-label", `Forward ${settings.skipFwd} seconds`);
    $("speed-label").textContent = rateLabel(settings.rate);
    renderPlayState();
    renderProgress();
    renderSleep();
  }

  function renderPlayState() {
    const playing = isPlaying();
    $("play-btn").textContent = playing ? "❚❚" : "▶";
    $("play-btn").classList.toggle("is-playing", playing);
    $("play-btn").setAttribute("aria-label", playing ? "Pause" : "Play");
    $("mini-play").textContent = playing ? "❚❚" : "▶";
    $("mini-play").setAttribute("aria-label", playing ? "Pause" : "Play");
    $("player-cover").classList.toggle("paused", !playing);
    if ("mediaSession" in navigator) navigator.mediaSession.playbackState = playing ? "playing" : "paused";
    if (playing !== lastHomePlaying) {
      lastHomePlaying = playing;
      renderHome();
    }
  }
  let lastHomePlaying = null;

  function renderProgress() {
    if (!current || scrubbing) return;
    const pos = livePosition();
    const r = scrubRange();
    const within = clamp(pos, r.start, r.end);
    $("scrub").value = String(Math.round(((within - r.start) / (r.end - r.start)) * 1000));
    paintScrub();
    $("time-elapsed").textContent = clock(within - r.start);
    $("time-remaining").textContent = "-" + clock(r.end - within);
    const left = Math.max(bookDuration(current) - pos, 0) / settings.rate;
    $("book-left").textContent = `${short(left)} left in book${settings.rate !== 1 ? ` at ${rateLabel(settings.rate)}` : ""}`;
  }

  function paintScrub() {
    const el = $("scrub");
    el.style.setProperty("--fill", `${(el.value / 10).toFixed(1)}%`);
  }

  function renderMini() {
    const mini = $("mini-player");
    mini.hidden = !current;
    document.body.classList.toggle("has-mini", !!current);
    if (!current) return;
    applyCover($("mini-cover"), current);
    $("mini-title").textContent = current.title;
    const ch = currentChapter();
    $("mini-sub").textContent = ch ? ch.title : current.author || "";
    $("mini-fwd").textContent = `↻${settings.skipFwd}`;
    renderMiniProgress();
    renderPlayState();
  }

  function renderMiniProgress() {
    if (!current) return;
    const total = bookDuration(current);
    $("mini-progress-fill").style.width = total ? `${(clamp(livePosition() / total, 0, 1) * 100).toFixed(2)}%` : "0";
  }

  // ---- sleep timer UI

  function renderSleep() {
    const active = sleep.mode !== "off";
    $("sleep-btn").classList.toggle("active", active);
    $("sleep-active").hidden = !active;
    $("sleep-extend").textContent = sleep.mode === "chapter" ? "＋ Next Chapter" : `＋ ${minutesLabel(sleep.original)}`;
    $("sleep-active-sub").textContent = sleep.mode === "chapter" ? "until the end of this chapter" : "remaining";
    $("sleep-chapter").disabled = !currentChapter();
    $("sleep-chapter").classList.toggle("selected", sleep.mode === "chapter");
    document.querySelectorAll("#sleep-presets button").forEach((b) => {
      b.classList.toggle("selected", sleep.mode === "duration" && Number(b.dataset.min) * 60 === sleep.original);
    });
    $("custom-value").textContent = minutesLabel(settings.customMinutes * 60);
    renderSleepCountdown();
  }

  function renderSleepCountdown() {
    const active = sleep.mode !== "off";
    const t = clock(sleep.remaining);
    $("sleep-label").textContent = active ? t : "Sleep";
    $("sleep-countdown").textContent = t;
    $("sleep-paused-note").hidden = !active || !audio.paused;
    $("mini-sub").dataset.sleep = active ? `☾ ${t}` : "";
  }

  // ================================================================ Sheets

  let openSheetEl = null;
  let sheetResolve = null;

  function openSheet(id) {
    closeSheet();
    openSheetEl = $(id);
    openSheetEl.hidden = false;
    $("backdrop").hidden = false;
    requestAnimationFrame(() => {
      openSheetEl.classList.add("open");
      $("backdrop").classList.add("open");
    });
  }
  function closeSheet(value) {
    if (sheetResolve) {
      const r = sheetResolve;
      sheetResolve = null;
      r(value);
    }
    if (!openSheetEl) return;
    const el = openSheetEl;
    openSheetEl = null;
    el.classList.remove("open");
    $("backdrop").classList.remove("open");
    setTimeout(() => {
      if (openSheetEl !== el) el.hidden = true;
      if (!openSheetEl) $("backdrop").hidden = true;
    }, 250);
  }

  function chooseAction(title, options) {
    $("action-title").textContent = title;
    const body = $("action-body");
    body.innerHTML = "";
    for (const opt of options) {
      const b = document.createElement("button");
      b.className = "row-btn" + (opt.danger ? " danger" : "");
      b.textContent = opt.label;
      if (opt.sub) {
        const sub = document.createElement("span");
        sub.className = "row-sub";
        sub.textContent = opt.sub;
        b.appendChild(sub);
      }
      // `now` runs inside the tap itself; iPhone only opens the file picker from a tap.
      b.addEventListener("click", () => {
        if (opt.now) opt.now();
        closeSheet(opt.value);
      });
      body.appendChild(b);
    }
    openSheet("action-sheet");
    return new Promise((resolve) => (sheetResolve = resolve));
  }

  function renderChapterList() {
    const list = $("chapter-list");
    list.innerHTML = "";
    const chapters = chaptersOf(current);
    const ci = chapterIndexAt(current, livePosition());
    const pos = livePosition();
    chapters.forEach((c, i) => {
      const li = document.createElement("li");
      li.className = "item" + (i === ci ? " current" : c.end <= pos ? " done" : "");
      li.innerHTML = `<button class="item-main"><span class="item-num"></span><span class="item-text"><span class="item-title"></span><span class="item-sub"></span></span><span class="item-right"></span></button>`;
      li.querySelector(".item-num").textContent = i === ci ? "♪" : String(i + 1);
      li.querySelector(".item-title").textContent = c.title;
      li.querySelector(".item-sub").textContent = clock(c.start);
      li.querySelector(".item-right").textContent = short(c.end - c.start);
      li.querySelector(".item-main").addEventListener("click", () => {
        seekTo(c.start, { autoplay: true });
        closeSheet();
        renderPlayer();
      });
      list.appendChild(li);
    });
    const cur = list.querySelector(".current");
    if (cur) setTimeout(() => cur.scrollIntoView({ block: "center" }), 50);
  }

  function renderBookmarkList() {
    const list = $("bookmark-list");
    list.innerHTML = "";
    const marks = (current.bookmarks || []).slice().sort((a, b) => a.position - b.position);
    $("bookmark-empty").hidden = marks.length > 0;
    for (const m of marks) {
      const li = document.createElement("li");
      li.className = "item";
      li.innerHTML = `<button class="item-main"><span class="item-num">🔖</span><span class="item-text"><span class="item-title"></span><span class="item-sub"></span></span></button><button class="icon-btn item-edit" aria-label="Edit note">✎</button><button class="icon-btn item-del" aria-label="Delete bookmark">✕</button>`;
      li.querySelector(".item-title").textContent = m.note;
      li.querySelector(".item-sub").textContent = `${clock(m.position)} · ${new Date(m.created).toLocaleDateString()}`;
      li.querySelector(".item-main").addEventListener("click", () => {
        seekTo(m.position, { autoplay: true });
        closeSheet();
        renderPlayer();
      });
      li.querySelector(".item-edit").addEventListener("click", () => {
        const note = prompt("Bookmark note", m.note);
        if (note !== null) {
          m.note = note.trim() || m.note;
          persist(current);
          renderBookmarkList();
        }
      });
      li.querySelector(".item-del").addEventListener("click", () => {
        current.bookmarks = current.bookmarks.filter((b) => b.id !== m.id);
        persist(current);
        renderBookmarkList();
      });
      list.appendChild(li);
    }
  }

  function showListTab(tab) {
    document.querySelectorAll("#list-tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
    $("chapter-list").hidden = tab !== "chapters";
    $("bookmark-list").hidden = tab !== "bookmarks";
    if (tab === "chapters") {
      $("bookmark-empty").hidden = true;
      renderChapterList();
    } else {
      renderBookmarkList();
    }
  }

  function openListSheet(tab) {
    if (!current) return;
    const hasChapters = chaptersOf(current).length > 0;
    $("list-tabs").querySelector('[data-tab="chapters"]').hidden = !hasChapters;
    showListTab(hasChapters ? tab || "chapters" : "bookmarks");
    openSheet("list-sheet");
  }

  function buildStaticUI() {
    const presets = $("sleep-presets");
    for (const m of SLEEP_PRESETS) {
      const b = document.createElement("button");
      b.className = "preset";
      b.dataset.min = m;
      b.textContent = m >= 60 ? minutesLabel(m * 60) : `${m} min`;
      b.addEventListener("click", () => {
        startSleep(m * 60);
        closeSheet();
      });
      presets.appendChild(b);
    }
    const speeds = $("speed-grid");
    for (const r of RATES) {
      const b = document.createElement("button");
      b.className = "preset";
      b.textContent = rateLabel(r);
      b.addEventListener("click", () => {
        settings.rate = r;
        saveSettings();
        applyRate();
        updatePositionState();
        renderPlayer();
        renderSpeedGrid();
        closeSheet();
      });
      speeds.appendChild(b);
    }
  }

  function renderSpeedGrid() {
    $("speed-grid").querySelectorAll("button").forEach((b, i) => b.classList.toggle("selected", RATES[i] === settings.rate));
  }

  function renderSettings() {
    $("set-skip-back").value = String(settings.skipBack);
    $("set-skip-fwd").value = String(settings.skipFwd);
    $("set-smart-rewind").checked = settings.smartRewind;
    $("set-fade").checked = settings.fade;
    // iPhone ignores volume changes from web pages, so fading isn't possible there.
    $("fade-row").hidden = !canSetVolume();
    $("fade-row").previousElementSibling.hidden = !canSetVolume();
    renderStorage();
  }

  // ================================================================ Wiring

  function wire() {
    $("add-btn").addEventListener("click", addMenu);
    $("empty-add-btn").addEventListener("click", () => pickFiles(null));
    $("folder-add-btn").addEventListener("click", () => pickFiles(openFolderId));
    $("file-input").addEventListener("change", (e) => handleFiles(e.target.files));
    $("search").addEventListener("input", renderLibrary);
    $("sort").addEventListener("change", (e) => {
      settings.sort = e.target.value;
      saveSettings();
      renderLibrary();
    });

    $("home-btn").addEventListener("click", () => {
      $("search").value = "";
      if (openFolderId) showView("library");
      else showView("home");
    });
    window.addEventListener("hashchange", () => {
      const v = viewFromHash();
      showView(v.name, { fromHash: true, folderId: v.folderId });
    });

    // Mini player
    $("mini-open").addEventListener("click", openPlayer);
    $("mini-play").addEventListener("click", togglePlay);
    $("mini-fwd").addEventListener("click", () => skip(settings.skipFwd));

    // Player
    $("player-close").addEventListener("click", closePlayer);
    $("player-more").addEventListener("click", () => current && bookActions(current));
    $("play-btn").addEventListener("click", togglePlay);
    $("skip-back").addEventListener("click", () => skip(-settings.skipBack));
    $("skip-fwd").addEventListener("click", () => skip(settings.skipFwd));
    $("prev-chapter").addEventListener("click", () => {
      previousChapter();
      renderPlayer();
    });
    $("next-chapter").addEventListener("click", () => {
      nextChapter();
      renderPlayer();
    });
    $("chapter-btn").addEventListener("click", () => openListSheet("chapters"));
    $("list-btn").addEventListener("click", () => openListSheet());
    $("bookmark-btn").addEventListener("click", addBookmark);
    $("speed-btn").addEventListener("click", () => {
      renderSpeedGrid();
      openSheet("speed-sheet");
    });
    $("sleep-btn").addEventListener("click", () => {
      renderSleep();
      openSheet("sleep-sheet");
    });

    const scrub = $("scrub");
    scrub.addEventListener("input", () => {
      scrubbing = true;
      paintScrub();
      const r = scrubRange();
      const t = r.start + (scrub.value / 1000) * (r.end - r.start);
      $("time-elapsed").textContent = clock(t - r.start);
      $("time-remaining").textContent = "-" + clock(r.end - t);
    });
    scrub.addEventListener("change", () => {
      const r = scrubRange();
      const t = r.start + (scrub.value / 1000) * (r.end - r.start);
      scrubbing = false;
      seekTo(t);
    });

    // Swipe the player down to close it
    let dragY = null;
    const top = document.querySelector(".player-top");
    top.addEventListener("touchstart", (e) => (dragY = e.touches[0].clientY), { passive: true });
    top.addEventListener("touchmove", (e) => {
      if (dragY == null) return;
      const dy = Math.max(0, e.touches[0].clientY - dragY);
      $("player").style.transform = `translateY(${dy}px)`;
    }, { passive: true });
    top.addEventListener("touchend", (e) => {
      if (dragY == null) return;
      const dy = e.changedTouches[0].clientY - dragY;
      dragY = null;
      $("player").style.transform = "";
      if (dy > 110) closePlayer();
    });

    // Sheets
    $("backdrop").addEventListener("click", () => closeSheet());
    document.querySelectorAll(".sheet-done").forEach((b) => b.addEventListener("click", () => closeSheet()));
    document.querySelectorAll("#list-tabs button").forEach((b) => b.addEventListener("click", () => showListTab(b.dataset.tab)));

    // Sleep timer sheet
    $("sleep-chapter").addEventListener("click", () => {
      startSleepAtChapterEnd();
      closeSheet();
    });
    $("sleep-extend").addEventListener("click", () => extendSleep());
    $("sleep-off").addEventListener("click", () => {
      stopSleep();
      clearSleepRestart();
      toast("Sleep timer off");
    });
    $("custom-minus").addEventListener("click", () => {
      settings.customMinutes = Math.max(1, settings.customMinutes - (settings.customMinutes > 30 ? 10 : 5));
      saveSettings();
      renderSleep();
    });
    $("custom-plus").addEventListener("click", () => {
      settings.customMinutes = Math.min(600, settings.customMinutes + (settings.customMinutes >= 30 ? 10 : 5));
      saveSettings();
      renderSleep();
    });
    $("custom-start").addEventListener("click", () => {
      startSleep(settings.customMinutes * 60);
      closeSheet();
    });

    // Settings
    const bindSelect = (id, key) =>
      $(id).addEventListener("change", (e) => {
        settings[key] = Number(e.target.value);
        saveSettings();
        renderPlayer();
        renderMini();
      });
    bindSelect("set-skip-back", "skipBack");
    bindSelect("set-skip-fwd", "skipFwd");
    const bindToggle = (id, key, after) =>
      $(id).addEventListener("change", (e) => {
        settings[key] = e.target.checked;
        saveSettings();
        renderSettings();
        renderSleep();
        if (after) after();
      });
    bindToggle("set-smart-rewind", "smartRewind");
    bindToggle("set-fade", "fade", () => setVolume(1));

    // Lifecycle: save often.
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") savePosition(true);
      else {
        sleepTick();
        renderProgress();
      }
    });
    window.addEventListener("pagehide", () => savePosition(true));
  }

  // ================================================================ Start-up

  async function start() {
    buildStaticUI();
    wire();
    try {
      books = await idb.all("books");
      folders = await idb.all("folders");
    } catch (e) {
      console.error(e);
      toast("Couldn't open your library storage");
      books = [];
    }
    const v = viewFromHash();
    showView(v.name, { fromHash: true, folderId: v.folderId });
    const last = settings.currentBookId && books.find((b) => b.id === settings.currentBookId);
    if (last) openBook(last, { autoplay: false });
    renderMini();

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("service-worker.js").catch(() => {});
    }
  }

  // Exposed for automated tests only.
  window.__audiobooks = {
    get sleep() { return { ...sleep }; },
    get current() { return current; },
    livePosition,
    extendSleep,
    startSleep,
    get restart() { return settings.sleepRestart; },
  };

  start();
})();
