// Reads title, author, cover art and chapter markers from audio files in the
// browser, without loading whole files into memory (only the tag / header
// sections are read via Blob.slice).
//
// Supported:
//   - MP3: ID3v2.2 / 2.3 / 2.4 tags, APIC/PIC cover art, CHAP chapter frames
//   - M4B / M4A / MP4 / AAC-in-MP4: iTunes metadata (ilst), cover art,
//     QuickTime chapter tracks (what iTunes/Audible-style .m4b files use)
//     and Nero "chpl" chapters
// Anything else falls back to the file name.

(function (global) {
  "use strict";

  const latin1 = new TextDecoder("iso-8859-1");
  const utf8 = new TextDecoder("utf-8");
  const utf16le = new TextDecoder("utf-16le");
  const utf16be = new TextDecoder("utf-16be");

  async function readBytes(blob, start, end) {
    const buf = await blob.slice(start, end).arrayBuffer();
    return new Uint8Array(buf);
  }

  function clean(str) {
    if (!str) return null;
    const s = str.replace(/\u0000+$/g, "").replace(/\u0000/g, " ").trim();
    return s || null;
  }

  // ---------------------------------------------------------------- ID3v2

  function synchsafe(b, o) {
    return ((b[o] & 0x7f) << 21) | ((b[o + 1] & 0x7f) << 14) | ((b[o + 2] & 0x7f) << 7) | (b[o + 3] & 0x7f);
  }

  function uint32(b, o) {
    return ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
  }

  function decodeText(bytes, encoding) {
    if (!bytes.length) return "";
    switch (encoding) {
      case 0:
        return latin1.decode(bytes);
      case 1: {
        // UTF-16 with BOM
        if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return utf16be.decode(bytes.subarray(2));
        if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return utf16le.decode(bytes.subarray(2));
        return utf16le.decode(bytes);
      }
      case 2:
        return utf16be.decode(bytes);
      default:
        return utf8.decode(bytes);
    }
  }

  // Finds the end of a null-terminated string starting at `start`.
  function terminator(bytes, start, encoding) {
    const wide = encoding === 1 || encoding === 2;
    if (wide) {
      for (let i = start; i + 1 < bytes.length; i += 2) {
        if (bytes[i] === 0 && bytes[i + 1] === 0) return { end: i, next: i + 2 };
      }
    } else {
      for (let i = start; i < bytes.length; i++) {
        if (bytes[i] === 0) return { end: i, next: i + 1 };
      }
    }
    return { end: bytes.length, next: bytes.length };
  }

  function textFrame(data) {
    if (!data.length) return null;
    return clean(decodeText(data.subarray(1), data[0]));
  }

  function parseFrames(bytes, start, end, version, out) {
    const idLen = version === 2 ? 3 : 4;
    const headerLen = version === 2 ? 6 : 10;
    let o = start;
    while (o + headerLen <= end) {
      const id = latin1.decode(bytes.subarray(o, o + idLen));
      if (!/^[A-Z0-9]+$/.test(id)) break; // padding
      let size;
      if (version === 2) size = (bytes[o + 3] << 16) | (bytes[o + 4] << 8) | bytes[o + 5];
      else if (version === 4) size = synchsafe(bytes, o + 4);
      else size = uint32(bytes, o + 4);
      const dataStart = o + headerLen;
      const dataEnd = Math.min(dataStart + size, end);
      if (size <= 0 || dataStart > end) break;
      const data = bytes.subarray(dataStart, dataEnd);
      handleFrame(id, data, version, out);
      o = dataEnd;
    }
  }

  function handleFrame(id, data, version, out) {
    switch (id) {
      case "TIT2":
      case "TT2":
        if (!out.title) out.title = textFrame(data);
        break;
      case "TPE1":
      case "TP1":
        if (!out.artist) out.artist = textFrame(data);
        break;
      case "TPE2":
      case "TP2":
        if (!out.albumArtist) out.albumArtist = textFrame(data);
        break;
      case "TALB":
      case "TAL":
        if (!out.album) out.album = textFrame(data);
        break;
      case "TCOM":
      case "TCM":
        if (!out.composer) out.composer = textFrame(data);
        break;
      case "TRCK":
      case "TRK": {
        const t = textFrame(data);
        if (t && !out.track) out.track = parseInt(t, 10) || null;
        break;
      }
      case "APIC":
      case "PIC": {
        if (out.cover) break;
        const enc = data[0];
        let mime, o;
        if (id === "PIC") {
          const fmt = latin1.decode(data.subarray(1, 4)).toLowerCase();
          mime = fmt === "png" ? "image/png" : "image/jpeg";
          o = 4;
        } else {
          const t = terminator(data, 1, 0);
          mime = latin1.decode(data.subarray(1, t.end)).toLowerCase() || "image/jpeg";
          if (!mime.includes("/")) mime = "image/" + (mime === "png" ? "png" : "jpeg");
          o = t.next;
        }
        o += 1; // picture type
        o = terminator(data, o, enc).next; // description
        if (o < data.length) out.cover = new Blob([data.slice(o)], { type: mime });
        break;
      }
      case "CHAP": {
        const t = terminator(data, 0, 0);
        let o = t.next;
        if (o + 16 > data.length) break;
        const startMs = uint32(data, o);
        const endMs = uint32(data, o + 4);
        o += 16;
        const sub = {};
        parseFrames(data, o, data.length, version, sub);
        out.chapters.push({ title: sub.title || null, start: startMs / 1000, end: endMs / 1000 });
        break;
      }
    }
  }

  async function parseID3(blob) {
    const head = await readBytes(blob, 0, 10);
    const version = head[3];
    const flags = head[5];
    const size = synchsafe(head, 6);
    const bytes = await readBytes(blob, 0, 10 + size);
    let start = 10;
    if (flags & 0x40) {
      // extended header
      if (version === 4) start += synchsafe(bytes, 10);
      else start += 4 + uint32(bytes, 10);
    }
    const out = { chapters: [] };
    parseFrames(bytes, start, bytes.length, version, out);
    out.chapters.sort((a, b) => a.start - b.start);
    return out;
  }

  // ---------------------------------------------------------------- MP4

  // Iterates child boxes inside bytes[start, end).
  function* boxes(bytes, start, end) {
    let o = start;
    while (o + 8 <= end) {
      let size = uint32(bytes, o);
      const type = latin1.decode(bytes.subarray(o + 4, o + 8));
      let header = 8;
      if (size === 1) {
        size = uint32(bytes, o + 8) * 4294967296 + uint32(bytes, o + 12);
        header = 16;
      } else if (size === 0) {
        size = end - o;
      }
      if (size < header || o + size > end) return;
      yield { type, start: o, dataStart: o + header, end: o + size };
      o += size;
    }
  }

  function child(bytes, box, type) {
    for (const b of boxes(bytes, box.dataStart, box.end)) if (b.type === type) return b;
    return null;
  }

  function children(bytes, box, type) {
    const list = [];
    for (const b of boxes(bytes, box.dataStart, box.end)) if (b.type === type) list.push(b);
    return list;
  }

  // Finds the top-level moov box by reading only box headers.
  async function findMoov(blob) {
    let o = 0;
    while (o + 8 <= blob.size) {
      const h = await readBytes(blob, o, o + 16);
      let size = uint32(h, 0);
      const type = latin1.decode(h.subarray(4, 8));
      if (size === 1) size = uint32(h, 8) * 4294967296 + uint32(h, 12);
      else if (size === 0) size = blob.size - o;
      if (size < 8) return null;
      if (type === "moov") {
        if (size > 200 * 1024 * 1024) return null;
        return readBytes(blob, o, o + size);
      }
      o += size;
    }
    return null;
  }

  function parseIlst(bytes, ilst, out) {
    for (const item of boxes(bytes, ilst.dataStart, ilst.end)) {
      const data = child(bytes, item, "data");
      if (!data) continue;
      const kind = uint32(bytes, data.dataStart) & 0xffffff;
      const payload = bytes.subarray(data.dataStart + 8, data.end);
      const text = () => clean(utf8.decode(payload));
      switch (item.type) {
        case "©nam":
          out.title = text();
          break;
        case "©ART":
          out.artist = text();
          break;
        case "aART":
          out.albumArtist = text();
          break;
        case "©alb":
          out.album = text();
          break;
        case "©wrt":
          out.composer = text();
          break;
        case "trkn":
          if (payload.length >= 4) out.track = (payload[2] << 8) | payload[3];
          break;
        case "covr":
          if (!out.cover && payload.length) {
            out.cover = new Blob([payload.slice()], { type: kind === 14 ? "image/png" : "image/jpeg" });
          }
          break;
      }
    }
  }

  function findMeta(bytes, moov) {
    const udta = child(bytes, moov, "udta");
    if (!udta) return null;
    const meta = child(bytes, udta, "meta");
    if (!meta) return null;
    // "meta" is normally a full box (4 bytes of version/flags before children),
    // but QuickTime-style files omit them.
    const looksFull = uint32(bytes, meta.dataStart) === 0;
    const inner = { dataStart: meta.dataStart + (looksFull ? 4 : 0), end: meta.end };
    return child(bytes, inner, "ilst");
  }

  function parseChpl(bytes, moov) {
    const udta = child(bytes, moov, "udta");
    const chpl = udta && child(bytes, udta, "chpl");
    if (!chpl) return [];
    let o = chpl.dataStart;
    const version = bytes[o];
    o += 4;
    if (version) o += 4;
    const count = bytes[o++];
    const list = [];
    for (let i = 0; i < count && o + 9 <= chpl.end; i++) {
      const start = (uint32(bytes, o) * 4294967296 + uint32(bytes, o + 4)) / 1e7;
      const len = bytes[o + 8];
      const title = clean(utf8.decode(bytes.subarray(o + 9, o + 9 + len)));
      list.push({ title, start });
      o += 9 + len;
    }
    return list;
  }

  function trackInfo(bytes, trak) {
    const info = { id: null, handler: null, timescale: 0, chapRefs: [], stbl: null };
    const tkhd = child(bytes, trak, "tkhd");
    if (tkhd) {
      const v = bytes[tkhd.dataStart];
      info.id = uint32(bytes, tkhd.dataStart + (v === 1 ? 20 : 12));
    }
    const tref = child(bytes, trak, "tref");
    const chap = tref && child(bytes, tref, "chap");
    if (chap) {
      for (let o = chap.dataStart; o + 4 <= chap.end; o += 4) info.chapRefs.push(uint32(bytes, o));
    }
    const mdia = child(bytes, trak, "mdia");
    if (mdia) {
      const mdhd = child(bytes, mdia, "mdhd");
      if (mdhd) {
        const v = bytes[mdhd.dataStart];
        info.timescale = uint32(bytes, mdhd.dataStart + (v === 1 ? 20 : 12));
      }
      const hdlr = child(bytes, mdia, "hdlr");
      if (hdlr) info.handler = latin1.decode(bytes.subarray(hdlr.dataStart + 8, hdlr.dataStart + 12));
      const minf = child(bytes, mdia, "minf");
      info.stbl = minf && child(bytes, minf, "stbl");
    }
    return info;
  }

  // Reads the titles and start times of a QuickTime text (chapter) track.
  async function readChapterTrack(blob, bytes, track) {
    const stbl = track.stbl;
    if (!stbl || !track.timescale) return [];
    const stts = child(bytes, stbl, "stts");
    const stsz = child(bytes, stbl, "stsz");
    const stsc = child(bytes, stbl, "stsc");
    const stco = child(bytes, stbl, "stco") || child(bytes, stbl, "co64");
    if (!stts || !stsz || !stsc || !stco) return [];

    // Sample start times
    const starts = [];
    let t = 0;
    let n = uint32(bytes, stts.dataStart + 4);
    for (let i = 0, o = stts.dataStart + 8; i < n; i++, o += 8) {
      const count = uint32(bytes, o);
      const delta = uint32(bytes, o + 4);
      for (let k = 0; k < count && starts.length < 5000; k++) {
        starts.push(t);
        t += delta;
      }
    }

    // Sample sizes
    const fixedSize = uint32(bytes, stsz.dataStart + 4);
    const sampleCount = uint32(bytes, stsz.dataStart + 8);
    const sizes = [];
    for (let i = 0; i < Math.min(sampleCount, 5000); i++) {
      sizes.push(fixedSize || uint32(bytes, stsz.dataStart + 12 + i * 4));
    }

    // Chunk offsets
    const isCo64 = stco.type === "co64";
    const chunkCount = uint32(bytes, stco.dataStart + 4);
    const chunkOffsets = [];
    for (let i = 0; i < chunkCount; i++) {
      const o = stco.dataStart + 8 + i * (isCo64 ? 8 : 4);
      chunkOffsets.push(isCo64 ? uint32(bytes, o) * 4294967296 + uint32(bytes, o + 4) : uint32(bytes, o));
    }

    // Samples-per-chunk runs
    const runs = [];
    n = uint32(bytes, stsc.dataStart + 4);
    for (let i = 0, o = stsc.dataStart + 8; i < n; i++, o += 12) {
      runs.push({ first: uint32(bytes, o), perChunk: uint32(bytes, o + 4) });
    }

    // Offset of every sample
    const offsets = [];
    let sample = 0;
    for (let c = 0; c < chunkOffsets.length && sample < sizes.length; c++) {
      let perChunk = 1;
      for (const r of runs) if (c + 1 >= r.first) perChunk = r.perChunk;
      let o = chunkOffsets[c];
      for (let k = 0; k < perChunk && sample < sizes.length; k++) {
        offsets.push(o);
        o += sizes[sample++];
      }
    }

    const list = [];
    for (let i = 0; i < offsets.length; i++) {
      const raw = await readBytes(blob, offsets[i], offsets[i] + sizes[i]);
      let title = null;
      if (raw.length >= 2) {
        const len = (raw[0] << 8) | raw[1];
        const text = raw.subarray(2, 2 + len);
        title = text.length >= 2 && text[0] === 0xfe && text[1] === 0xff
          ? clean(utf16be.decode(text.subarray(2)))
          : clean(utf8.decode(text));
      }
      list.push({ title, start: (starts[i] || 0) / track.timescale });
    }
    return list;
  }

  async function parseMP4(blob) {
    const out = { chapters: [] };
    const bytes = await findMoov(blob);
    if (!bytes) return out;
    const moov = { dataStart: 8, end: bytes.length };

    const ilst = findMeta(bytes, moov);
    if (ilst) parseIlst(bytes, ilst, out);

    const tracks = children(bytes, moov, "trak").map((t) => trackInfo(bytes, t));
    const refIds = new Set(tracks.flatMap((t) => t.chapRefs));
    const chapterTrack =
      tracks.find((t) => refIds.has(t.id)) || tracks.find((t) => t.handler === "text" || t.handler === "sbtl");
    if (chapterTrack) {
      try {
        out.chapters = await readChapterTrack(blob, bytes, chapterTrack);
      } catch (e) {
        out.chapters = [];
      }
    }
    if (!out.chapters.length) out.chapters = parseChpl(bytes, moov);
    out.chapters.sort((a, b) => a.start - b.start);
    return out;
  }

  function mp4Duration(bytes) {
    const moov = { dataStart: 8, end: bytes.length };
    const mvhd = child(bytes, moov, "mvhd");
    if (!mvhd) return 0;
    const o = mvhd.dataStart;
    const v = bytes[o];
    const timescale = uint32(bytes, o + (v === 1 ? 20 : 12));
    const duration = v === 1 ? uint32(bytes, o + 24) * 4294967296 + uint32(bytes, o + 28) : uint32(bytes, o + 16);
    return timescale ? duration / timescale : 0;
  }

  // ---------------------------------------------------------------- MP3 duration

  const MP3_BITRATES = {
    v1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
    v2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  };
  const MP3_RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

  // Uses the Xing/Info or VBRI header when present (VBR files), otherwise
  // estimates from the bitrate (CBR files).
  async function mp3Duration(blob, audioStart) {
    const bytes = await readBytes(blob, audioStart, audioStart + 65536);
    for (let i = 0; i + 4 < bytes.length; i++) {
      if (bytes[i] !== 0xff || (bytes[i + 1] & 0xe0) !== 0xe0) continue;
      const versionBits = (bytes[i + 1] >> 3) & 3; // 3 = MPEG1, 2 = MPEG2, 0 = MPEG2.5
      const layerBits = (bytes[i + 1] >> 1) & 3; // 1 = Layer III
      const bitrateIdx = bytes[i + 2] >> 4;
      const rateIdx = (bytes[i + 2] >> 2) & 3;
      if (versionBits === 1 || layerBits !== 1 || bitrateIdx === 0 || bitrateIdx === 15 || rateIdx === 3) continue;
      const mono = (bytes[i + 3] >> 6) === 3;
      const mpeg1 = versionBits === 3;
      const sampleRate = MP3_RATES[versionBits][rateIdx];
      const samplesPerFrame = mpeg1 ? 1152 : 576;
      const bitrate = (mpeg1 ? MP3_BITRATES.v1 : MP3_BITRATES.v2)[bitrateIdx] * 1000;

      const xingAt = i + 4 + (mpeg1 ? (mono ? 17 : 32) : mono ? 9 : 17);
      const tag = latin1.decode(bytes.subarray(xingAt, xingAt + 4));
      if ((tag === "Xing" || tag === "Info") && xingAt + 12 <= bytes.length) {
        const flags = uint32(bytes, xingAt + 4);
        if (flags & 1) return (uint32(bytes, xingAt + 8) * samplesPerFrame) / sampleRate;
      }
      const vbriAt = i + 36;
      if (latin1.decode(bytes.subarray(vbriAt, vbriAt + 4)) === "VBRI" && vbriAt + 18 <= bytes.length) {
        return (uint32(bytes, vbriAt + 14) * samplesPerFrame) / sampleRate;
      }
      return ((blob.size - audioStart - i) * 8) / bitrate;
    }
    return 0;
  }

  async function wavDuration(blob) {
    const bytes = await readBytes(blob, 0, 65536);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let o = 12;
    let byteRate = 0;
    while (o + 8 <= bytes.length) {
      const id = latin1.decode(bytes.subarray(o, o + 4));
      const size = view.getUint32(o + 4, true);
      if (id === "fmt " && o + 16 <= bytes.length) byteRate = view.getUint32(o + 16, true);
      if (id === "data") return byteRate ? Math.min(size, blob.size - o - 8) / byteRate : 0;
      o += 8 + size + (size & 1);
    }
    return 0;
  }

  // ---------------------------------------------------------------- Public

  async function readMetadata(file) {
    try {
      const head = await readBytes(file, 0, 12);
      const ascii = latin1.decode(head);
      if (head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33) {
        const out = await parseID3(file);
        const tagEnd = 10 + synchsafe(head, 6) + (head[5] & 0x10 ? 10 : 0);
        out.duration = await mp3Duration(file, tagEnd);
        return out;
      }
      if (ascii.slice(4, 8) === "ftyp") {
        const out = await parseMP4(file);
        const moov = await findMoov(file);
        out.duration = moov ? mp4Duration(moov) : 0;
        return out;
      }
      if (ascii.slice(0, 4) === "RIFF" && ascii.slice(8, 12) === "WAVE") {
        return { chapters: [], duration: await wavDuration(file) };
      }
      if (head[0] === 0xff && (head[1] & 0xe0) === 0xe0) {
        return { chapters: [], duration: await mp3Duration(file, 0) };
      }
    } catch (e) {
      console.warn("Couldn't read tags from", file.name, e);
    }
    return { chapters: [], duration: 0 };
  }

  global.AudioMetadata = { readMetadata };
})(typeof window !== "undefined" ? window : globalThis);
