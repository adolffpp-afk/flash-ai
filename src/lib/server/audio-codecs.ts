/*
 * How long MP3, AAC (raw, or in an M4A, MP4 or MOV file) and FLAC recordings really are, read from
 * their frames, with a clean copy holding exactly the frames counted (see audio-length.ts, which
 * reads Opus, Vorbis and WAV, and sends each file Flash measures on here). A low-bitrate AAC or FLAC
 * file can hold hours of silence in a few kilobytes, so their size alone can't price them.
 *
 * Every walk is one pass over the file, and a file with more frames than any real recording of its
 * size could hold (MAX_FRAMES) isn't measured, so a forged file costs little time and memory.
 */
import type { MeasuredAudio } from "./audio-length.ts";

// More frames than this in a file of at most a few megabytes is a forged one: real AAC, MP3 and
// FLAC frames hold at least tens of bytes each.
export const MAX_FRAMES = 200_000;

const be16 = (d: Uint8Array, at: number) => (d[at] << 8) | d[at + 1];
const be24 = (d: Uint8Array, at: number) => (d[at] << 16) | (d[at + 1] << 8) | d[at + 2];
const be32 = (d: Uint8Array, at: number) => d[at] * 0x1000000 + ((d[at + 1] << 16) | (d[at + 2] << 8) | d[at + 3]);
const be64 = (d: Uint8Array, at: number) => be32(d, at) * 0x100000000 + be32(d, at + 4);
const text = (d: Uint8Array, at: number, n: number) => String.fromCharCode(...d.subarray(at, at + n));

/** Where the sound starts after any ID3v2 tags (as taggers put them before MP3, AAC and FLAC). */
export function afterId3(data: Uint8Array): number {
  let at = 0;
  while (at + 10 <= data.length && text(data, at, 3) === "ID3" && data[at + 3] < 0xff) {
    const size = ((data[at + 6] & 0x7f) << 21) | ((data[at + 7] & 0x7f) << 14) | ((data[at + 8] & 0x7f) << 7) | (data[at + 9] & 0x7f);
    at += 10 + size + (data[at + 5] & 0x10 ? 10 : 0);
  }
  return at;
}

/*
 * MPEG audio (MP3, MP2, MP1): frames, each with a header giving its length and how many samples it
 * plays. A frame counts only when it fits whole in the file; bytes between frames (tags, junk) are
 * skipped, as a player does. Free-format frames (bitrate 0 in the header) are left out, so every
 * frame kept holds at least 1,000 bytes a second (8 kbps, the lowest rate): a player's guess of the
 * length from the bitrate is never longer than the size floor of transcribeCostCents. A Xing, Info
 * or VBRI frame, which only says how long the file claims to be, is left out too.
 */
const MPEG_KBPS: Record<string, number[]> = {
  "1-1": [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  "1-2": [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  "1-3": [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  "2-1": [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  "2-2": [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  "2-3": [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
// By the version bits: MPEG-2.5, (reserved), MPEG-2, MPEG-1.
const MPEG_RATES = [[11025, 12000, 8000], [], [22050, 24000, 16000], [44100, 48000, 32000]];

type Frame = { length: number; samples: number; rate: number };

/** The MPEG audio frame starting at at, or null when there's none there. */
export function mpegFrame(d: Uint8Array, at: number): Frame | null {
  if (at + 4 > d.length || d[at] !== 0xff || (d[at + 1] & 0xe0) !== 0xe0) return null;
  const version = (d[at + 1] >> 3) & 3;
  const layer = 4 - ((d[at + 1] >> 1) & 3);
  const bitrateIndex = d[at + 2] >> 4;
  const rateIndex = (d[at + 2] >> 2) & 3;
  if (version === 1 || layer === 4 || bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) return null;
  const v1 = version === 3;
  const bitrate = MPEG_KBPS[`${v1 ? 1 : 2}-${layer}`][bitrateIndex] * 1000;
  const rate = MPEG_RATES[version][rateIndex];
  const padding = (d[at + 2] >> 1) & 1;
  const length =
    layer === 1 ? (Math.floor((12 * bitrate) / rate) + padding) * 4 : Math.floor(((layer === 3 && !v1 ? 72 : 144) * bitrate) / rate) + padding;
  const samples = layer === 1 ? 384 : layer === 3 && !v1 ? 576 : 1152;
  return { length, samples, rate };
}

/** An MP3 (or MP2) file's frames, and a copy of just them, or null when it has none. */
export function mpegLength(data: Uint8Array): MeasuredAudio | null {
  const frames: Uint8Array[] = [];
  let seconds = 0;
  let at = afterId3(data);
  while (at + 4 <= data.length) {
    const frame = mpegFrame(data, at);
    // A frame must fit in the file, and the next one start where it ends (or the file end there),
    // so bytes that only look like a header aren't taken for one.
    const fits = frame && at + frame.length <= data.length;
    const next = fits ? at + frame.length : 0;
    if (!frame || !fits || (next + 4 <= data.length && !mpegFrame(data, next) && !frames.length)) {
      at++;
      continue;
    }
    const bytes = data.subarray(at, next);
    at = next;
    // The header frame of a VBR file says how long the file claims to be; it is left out.
    if (!frames.length && /Xing|Info|VBRI/.test(text(bytes, 4, Math.min(bytes.length - 4, 40)))) continue;
    if (frames.length >= MAX_FRAMES) return null;
    frames.push(bytes);
    seconds += frame.samples / frame.rate;
  }
  if (!frames.length) return null;
  return { length: { decoded: seconds, declared: 0 }, file: { data: Buffer.concat(frames), mediaType: "audio/mpeg", extension: "mp3" } };
}

/*
 * AAC. Each frame plays 1,024 samples at the core rate (960 in some files, and HE-AAC plays twice
 * as many at twice the rate: the same time), so a file's length is its frames over that rate. The
 * clean copy is an M4A file (see m4a), whose every length (the frames, the track's, the movie's)
 * is that same count, so no player can make it out to be longer.
 */
const AAC_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
const AAC_FRAME = 1024;

/** What an AAC stream is: its AudioSpecificConfig, and the rate its frames are timed at. */
type AacConfig = { asc: Uint8Array; rate: number; channels: number };

/**
 * Reads an AudioSpecificConfig (ISO 14496-3 §1.6.2.1). Only the AAC Flash can time is accepted:
 * Main, LC, SSR and LTP, alone or with SBR or PS (HE-AAC). The rate is the core's, or for HE-AAC
 * half the output rate when that is lower, so the length leans long.
 */
export function aacConfig(asc: Uint8Array): AacConfig | null {
  let bit = 0;
  const read = (n: number) => {
    let v = 0;
    for (let i = 0; i < n; i++, bit++) {
      if (bit >> 3 >= asc.length) return -1;
      v = v * 2 + ((asc[bit >> 3] >> (7 - (bit & 7))) & 1);
    }
    return v;
  };
  const objectType = () => {
    const t = read(5);
    return t === 31 ? 32 + read(6) : t;
  };
  const rate = () => {
    const index = read(4);
    return index === 15 ? read(24) : (AAC_RATES[index] ?? 0);
  };
  let type = objectType();
  let core = rate();
  const channels = read(4);
  if (type === 5 || type === 29) {
    const output = rate();
    type = objectType();
    if (output > 0) core = Math.min(core, output / 2);
  }
  if (type < 1 || type > 4 || core <= 0 || channels < 0) return null;
  return { asc, rate: core, channels: [0, 1, 2, 3, 4, 5, 6, 8][channels] ?? 2 };
}

/** One ADTS frame (a raw AAC file's), or null when there's none at at. */
function adtsFrame(d: Uint8Array, at: number) {
  if (at + 7 > d.length || d[at] !== 0xff || (d[at + 1] & 0xf6) !== 0xf0) return null;
  const header = d[at + 1] & 1 ? 7 : 9;
  const profile = d[at + 2] >> 6;
  const rateIndex = (d[at + 2] >> 2) & 0xf;
  const channels = ((d[at + 2] & 1) << 2) | (d[at + 3] >> 6);
  const length = ((d[at + 3] & 3) << 11) | (d[at + 4] << 3) | (d[at + 5] >> 5);
  const blocks = (d[at + 6] & 3) + 1;
  if (rateIndex > 12 || length <= header) return null;
  return { header, profile, rateIndex, channels, length, blocks };
}

/** A raw AAC (ADTS) file's frames, as an M4A, or null when they can't be read as one stream. */
export function adtsLength(data: Uint8Array): MeasuredAudio | null {
  const frames: Uint8Array[] = [];
  let kind = "";
  let at = afterId3(data);
  while (at + 7 <= data.length) {
    const f = adtsFrame(data, at);
    const next = f ? at + f.length : 0;
    if (!f || next > data.length || (!frames.length && next + 7 <= data.length && !adtsFrame(data, next))) {
      at++;
      continue;
    }
    // One stream: every frame the same kind, with one block (several can't be split without decoding),
    // and channels the header names (0 needs a layout only the stream itself holds).
    const same = `${f.profile}-${f.rateIndex}-${f.channels}`;
    if ((kind && same !== kind) || f.blocks !== 1 || !f.channels) return null;
    kind = same;
    if (frames.length >= MAX_FRAMES) return null;
    frames.push(data.subarray(at + f.header, next));
    at = next;
  }
  if (!frames.length) return null;
  const [profile, rateIndex, channels] = kind.split("-").map(Number);
  // The AudioSpecificConfig the header stands for: object type, rate and channels.
  const asc = Uint8Array.of(((profile + 1) << 3) | (rateIndex >> 1), ((rateIndex & 1) << 7) | (channels << 3));
  const config = aacConfig(asc);
  return config && aacMeasured(config, frames, 0);
}

/** How long AAC frames play, and the M4A that holds just them. declared: what the file claimed. */
function aacMeasured(config: AacConfig, frames: Uint8Array[], declared: number): MeasuredAudio {
  return {
    length: { decoded: (frames.length * AAC_FRAME) / config.rate, declared },
    file: { data: m4a(config, frames), mediaType: "audio/mp4", extension: "m4a" },
  };
}

/*
 * MP4, M4A and MOV: boxes, each a size and a name, the sound's frames listed in the sound track's
 * sample tables (or, in a fragmented file, in each fragment's track runs). Only the frames listed
 * are counted and copied, whatever else the file holds.
 */
type Box = { type: string; start: number; body: number; end: number };

/** The boxes between from and to. One that runs past to (a file cut short) ends there. */
function boxes(d: Uint8Array, from: number, to: number): Box[] {
  const out: Box[] = [];
  let at = from;
  while (at + 8 <= to) {
    let size = be32(d, at);
    let body = at + 8;
    if (size === 1) {
      if (at + 16 > to) break;
      size = be64(d, at + 8);
      body = at + 16;
    } else if (size === 0) size = to - at;
    if (size < body - at) break;
    out.push({ type: text(d, at + 4, 4), start: at, body, end: Math.min(to, at + size) });
    at += size;
  }
  return out;
}

const child = (d: Uint8Array, box: Box | undefined, type: string, skip = 0) =>
  box ? boxes(d, box.body + skip, box.end).find((b) => b.type === type) : undefined;
const path = (d: Uint8Array, box: Box | undefined, ...types: string[]) => types.reduce<Box | undefined>((b, t) => child(d, b, t), box);

/** Whether a file is ISO media (MP4, M4A, MOV, 3GP), from its first box. */
export const isIsoMedia = (d: Uint8Array) => d.length >= 12 && ["ftyp", "moov", "mdat", "free", "skip", "wide", "pnot"].includes(text(d, 4, 4));

/** An MP4, M4A or MOV file's AAC sound track, as an M4A, or null when it has none Flash can read. */
export function mp4Length(data: Uint8Array): MeasuredAudio | null {
  const top = boxes(data, 0, data.length);
  const moov = top.find((b) => b.type === "moov");
  if (!moov) return null;
  // The first sound track.
  const sound = (b: Box) => {
    const hdlr = path(data, b, "mdia", "hdlr");
    return Boolean(hdlr) && text(data, hdlr!.body + 8, 4) === "soun";
  };
  const trak = boxes(data, moov.body, moov.end).find((b) => b.type === "trak" && sound(b));
  if (!trak) return null;
  const tkhd = child(data, trak, "tkhd");
  const trackId = tkhd ? be32(data, tkhd.body + (data[tkhd.body] === 1 ? 20 : 12)) : 0;
  const mdhd = path(data, trak, "mdia", "mdhd");
  if (!mdhd) return null;
  const v1 = data[mdhd.body] === 1;
  const timescale = be32(data, mdhd.body + (v1 ? 20 : 12));
  const trackDuration = v1 ? be64(data, mdhd.body + 24) : be32(data, mdhd.body + 16);
  const stbl = path(data, trak, "mdia", "minf", "stbl");
  // The first sample entry, after stsd's version and count.
  const stsd = child(data, stbl, "stsd");
  const config = aacEntry(data, stsd && boxes(data, stsd.body + 8, stsd.end)[0]);
  if (!config || !timescale) return null;

  const frames: Uint8Array[] = [];
  let ticks = 0;
  // Samples listed, empty ones too: more than MAX_FRAMES is a forged file, which isn't measured.
  let samples = 0;
  // Takes size bytes at offset as the next frame; false when the file can't hold it (cut short).
  const take = (offset: number, size: number) => {
    if (++samples > MAX_FRAMES || offset + size > data.length) return false;
    // An empty sample plays nothing, so it isn't copied.
    if (size) frames.push(data.subarray(offset, offset + size));
    return true;
  };
  const stsz = child(data, stbl, "stsz");
  const stco = child(data, stbl, "stco") ?? child(data, stbl, "co64");
  const stsc = child(data, stbl, "stsc");
  if (stsz && stco && stsc) {
    const fixed = be32(data, stsz.body + 4);
    const count = be32(data, stsz.body + 8);
    if (count > MAX_FRAMES || (!fixed && stsz.body + 12 + count * 4 > stsz.end)) return null;
    const wide = stco.type === "co64";
    const chunks = Math.min(be32(data, stco.body + 4), Math.floor((stco.end - stco.body - 8) / (wide ? 8 : 4)));
    const runs = Math.min(be32(data, stsc.body + 4), Math.floor((stsc.end - stsc.body - 8) / 12));
    let sample = 0;
    let run = 0;
    walk: for (let c = 0; c < chunks && sample < count; c++) {
      while (run + 1 < runs && be32(data, stsc.body + 8 + (run + 1) * 12) <= c + 1) run++;
      const perChunk = runs ? be32(data, stsc.body + 8 + run * 12 + 4) : 0;
      let offset = wide ? be64(data, stco.body + 8 + c * 8) : be32(data, stco.body + 8 + c * 4);
      for (let i = 0; i < perChunk && sample < count; i++, sample++) {
        const size = fixed || be32(data, stsz.body + 12 + sample * 4);
        if (!take(offset, size)) break walk;
        offset += size;
      }
    }
    const stts = child(data, stbl, "stts");
    if (stts) {
      const entries = Math.min(be32(data, stts.body + 4), Math.floor((stts.end - stts.body - 8) / 8));
      for (let i = 0; i < entries; i++) ticks += be32(data, stts.body + 8 + i * 8) * be32(data, stts.body + 12 + i * 8);
    }
  }
  // A fragmented file: its frames are in the fragments' track runs.
  const trex = boxes(data, child(data, moov, "mvex")?.body ?? 0, child(data, moov, "mvex")?.end ?? 0).find(
    (b) => b.type === "trex" && be32(data, b.body + 4) === trackId,
  );
  for (const moof of top.filter((b) => b.type === "moof")) {
    if (!fragment(data, moof, trackId, trex, take, (t) => (ticks += t))) break;
  }
  if (samples > MAX_FRAMES || !frames.length) return null;
  // What the file says the sound lasts: its sample times, or the track's own length.
  return aacMeasured(config, frames, Math.max(ticks, trackDuration === 0xffffffff ? 0 : trackDuration) / timescale);
}

/** The AAC config of a sound track's first sample entry (an mp4a box, read past stsd's count), or null. */
function aacEntry(d: Uint8Array, entry: Box | undefined): AacConfig | null {
  if (!entry || entry.type !== "mp4a") return null;
  // QuickTime's sound descriptions add 16 (version 1) or 36 (version 2) bytes before the boxes inside.
  const version = be16(d, entry.body + 8);
  const inner = 28 + (version === 1 ? 16 : version === 2 ? 36 : 0);
  const esds = child(d, entry, "esds", inner) ?? child(d, child(d, entry, "wave", inner), "esds");
  if (!esds) return null;
  // ES_Descriptor (3) holds DecoderConfigDescriptor (4), which holds DecoderSpecificInfo (5): the AudioSpecificConfig.
  let at = esds.body + 4;
  const descriptor = (tag: number) => {
    if (at >= esds.end || d[at] !== tag) return -1;
    at++;
    let size = 0;
    for (let i = 0; i < 4 && at < esds.end; i++) {
      const b = d[at++];
      size = size * 128 + (b & 0x7f);
      if (!(b & 0x80)) break;
    }
    return size;
  };
  if (descriptor(3) < 0) return null;
  // Its id and flags, then what the flags say follows: another stream's id, a URL, a clock stream's id.
  const flags = d[at + 2];
  at += 3;
  if (flags & 0x80) at += 2;
  if (flags & 0x40) at += 1 + d[at];
  if (flags & 0x20) at += 2;
  if (descriptor(4) < 0) return null;
  // MPEG-4 audio, or MPEG-2 AAC Main, LC or SSR.
  if (![0x40, 0x66, 0x67, 0x68].includes(d[at])) return null;
  at += 13;
  const size = descriptor(5);
  if (size <= 0 || at + size > esds.end) return null;
  return aacConfig(d.slice(at, at + size));
}

/**
 * Reads one fragment's runs of the track's frames (ISO 14496-12 §8.8), taking each with take and
 * adding its sample times with ticks. False when a frame can't be read, so no more are.
 */
function fragment(
  d: Uint8Array,
  moof: Box,
  trackId: number,
  trex: Box | undefined,
  take: (offset: number, size: number) => boolean,
  ticks: (t: number) => void,
): boolean {
  let first = true;
  let next = moof.start;
  for (const traf of boxes(d, moof.body, moof.end).filter((b) => b.type === "traf")) {
    const tfhd = child(d, traf, "tfhd");
    if (!tfhd || be32(d, tfhd.body + 4) !== trackId) continue;
    const flags = be24(d, tfhd.body + 1);
    let at = tfhd.body + 8;
    let base = first ? moof.start : next;
    if (flags & 0x1) {
      base = be64(d, at);
      at += 8;
    } else if (flags & 0x20000) base = moof.start;
    if (flags & 0x2) at += 4;
    const defaultDuration = flags & 0x8 ? be32(d, (at += 4) - 4) : trex ? be32(d, trex.body + 12) : 0;
    const defaultSize = flags & 0x10 ? be32(d, at) : trex ? be32(d, trex.body + 16) : 0;
    first = false;
    next = base;
    for (const trun of boxes(d, traf.body, traf.end).filter((b) => b.type === "trun")) {
      const runFlags = be24(d, trun.body + 1);
      const count = be32(d, trun.body + 4);
      let field = trun.body + 8;
      let offset = next;
      if (runFlags & 0x1) {
        offset = base + (be32(d, field) | 0);
        field += 4;
      }
      if (runFlags & 0x4) field += 4;
      const each = [0x100, 0x200, 0x400, 0x800].filter((f) => runFlags & f).length * 4;
      if (count > MAX_FRAMES || field + count * each > trun.end) return false;
      for (let i = 0; i < count; i++) {
        let read = field + i * each;
        const duration = runFlags & 0x100 ? be32(d, (read += 4) - 4) : defaultDuration;
        const size = runFlags & 0x200 ? be32(d, read) : defaultSize;
        if (!take(offset, size)) return false;
        offset += size;
        ticks(duration);
      }
      next = offset;
    }
  }
  return true;
}

/*
 * The clean copy of AAC: an M4A file with one sound track whose frames are the ones counted, each
 * timed at 1,024 samples (see AAC_FRAME), in one chunk.
 */
const box = (type: string, ...parts: Uint8Array[]) => {
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + body.length, 0);
  head.write(type, 4, "latin1");
  return Buffer.concat([head, body]);
};
const u32s = (...values: number[]) => words(values);
/** Numbers as 32-bit big-endian words (a list, so a long one isn't spread into arguments). */
const words = (values: readonly number[]) => {
  const b = Buffer.alloc(values.length * 4);
  values.forEach((v, i) => b.writeUInt32BE(v >>> 0, i * 4));
  return b;
};
// An MPEG-4 descriptor: its tag, its size in one to four bytes, and its body.
const descriptor = (tag: number, ...parts: Uint8Array[]) => {
  const body = Buffer.concat(parts);
  return Buffer.concat([Uint8Array.of(tag, 0x80 | ((body.length >> 21) & 0x7f), 0x80 | ((body.length >> 14) & 0x7f), 0x80 | ((body.length >> 7) & 0x7f), body.length & 0x7f), body]);
};
const IDENTITY = u32s(0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000);

/** An M4A file holding these AAC frames. */
export function m4a(config: AacConfig, frames: Uint8Array[]): Buffer {
  const rate = Math.round(config.rate);
  const ticks = frames.length * AAC_FRAME;
  const ms = Math.ceil((ticks / rate) * 1000);
  const sizes = words(frames.map((f) => f.length));
  const esds = box(
    "esds",
    u32s(0),
    descriptor(
      3,
      Uint8Array.of(0, 1, 0),
      descriptor(4, Uint8Array.of(0x40, 0x15, 0, 0, 0), u32s(0, 0), descriptor(5, config.asc)),
      descriptor(6, Uint8Array.of(2)),
    ),
  );
  const entry = box("mp4a", Buffer.alloc(6), Uint8Array.of(0, 1), Buffer.alloc(8), Uint8Array.of(0, config.channels, 0, 16, 0, 0, 0, 0), u32s(Math.min(rate, 0xffff) * 0x10000), esds);
  const moov = (offset: number) =>
    box(
      "moov",
      box("mvhd", u32s(0, 0, 0, 1000, ms, 0x10000), Uint8Array.of(1, 0), Buffer.alloc(10), IDENTITY, Buffer.alloc(24), u32s(2)),
      box(
        "trak",
        box("tkhd", u32s(7, 0, 0, 1, 0, ms, 0, 0), Uint8Array.of(0, 0, 0, 0, 1, 0, 0, 0), IDENTITY, u32s(0, 0)),
        box(
          "mdia",
          box("mdhd", u32s(0, 0, 0, rate, ticks), Uint8Array.of(0x55, 0xc4, 0, 0)),
          box("hdlr", u32s(0, 0), Buffer.from("soun"), Buffer.alloc(12), Buffer.from("SoundHandler\0")),
          box(
            "minf",
            box("smhd", u32s(0, 0)),
            box("dinf", box("dref", u32s(0, 1), box("url ", u32s(1)))),
            box(
              "stbl",
              box("stsd", u32s(0, 1), entry),
              box("stts", u32s(0, 1, frames.length, AAC_FRAME)),
              box("stsc", u32s(0, 1, 1, frames.length, 1)),
              box("stsz", u32s(0, 0, frames.length), sizes),
              box("stco", u32s(0, 1, offset)),
            ),
          ),
        ),
      ),
    );
  const ftyp = box("ftyp", Buffer.from("M4A "), u32s(0), Buffer.from("M4A mp42isom"));
  // The frames start after the file type, the movie and the media box's own header.
  const offset = ftyp.length + moov(0).length + 8;
  const mdat = Buffer.concat(frames);
  return Buffer.concat([ftyp, moov(offset), u32s(8 + mdat.length), Buffer.from("mdat"), mdat]);
}

/*
 * FLAC: a STREAMINFO block, then frames. A frame's header says how many samples it holds and ends
 * with a checksum (CRC-8), and the frame ends with another over all of it (CRC-16), so frames are
 * found exactly, one after the other, without decoding them. Frames must match the stream's own
 * rate, channels and sample size, as they do in any real file.
 */
const CRC8 = Array.from({ length: 256 }, (_, i) => {
  let r = i;
  for (let j = 0; j < 8; j++) r = r & 0x80 ? ((r << 1) ^ 0x07) & 0xff : (r << 1) & 0xff;
  return r;
});
const CRC16 = Array.from({ length: 256 }, (_, i) => {
  let r = i << 8;
  for (let j = 0; j < 8; j++) r = r & 0x8000 ? ((r << 1) ^ 0x8005) & 0xffff : (r << 1) & 0xffff;
  return r;
});
const FLAC_RATES = [0, 88200, 176400, 192000, 8000, 16000, 22050, 24000, 32000, 44100, 48000, 96000];
const FLAC_BITS = [0, 8, 12, 0, 16, 20, 24, 32];

type FlacInfo = { rate: number; channels: number; bits: number; maxBlock: number };

/** The FLAC frame header at at: how many samples it holds and how long it is, or null when it isn't one. */
function flacHeader(d: Uint8Array, at: number, info: FlacInfo): { samples: number; length: number } | null {
  if (at + 6 > d.length || d[at] !== 0xff || (d[at + 1] & 0xfe) !== 0xf8 || d[at + 3] & 1) return null;
  const blockCode = d[at + 2] >> 4;
  const rateCode = d[at + 2] & 0xf;
  const channelCode = d[at + 3] >> 4;
  const bitsCode = (d[at + 3] >> 1) & 7;
  if (!blockCode || rateCode === 15 || channelCode > 10 || bitsCode === 3) return null;
  // The frame or sample number, written like UTF-8.
  let p = at + 4;
  const lead = d[p];
  const extra = lead < 0x80 ? 0 : lead >= 0xc0 && lead <= 0xfe ? Math.clz32(~(lead << 24)) - 1 : -1;
  if (extra < 0) return null;
  p += 1 + extra;
  let samples = blockCode === 1 ? 192 : blockCode <= 5 ? 576 << (blockCode - 2) : blockCode >= 8 ? 256 << (blockCode - 8) : 0;
  if (blockCode === 6) samples = d[p++] + 1;
  else if (blockCode === 7) {
    samples = be16(d, p) + 1;
    p += 2;
  }
  let rate = FLAC_RATES[rateCode] ?? 0;
  if (rateCode === 12) rate = d[p++] * 1000;
  else if (rateCode === 13 || rateCode === 14) {
    rate = be16(d, p) * (rateCode === 14 ? 10 : 1);
    p += 2;
  }
  if (p >= d.length) return null;
  let crc = 0;
  for (let i = at; i < p; i++) crc = CRC8[crc ^ d[i]];
  if (crc !== d[p]) return null;
  const channels = channelCode < 8 ? channelCode + 1 : 2;
  if ((rateCode && rate !== info.rate) || channels !== info.channels || (bitsCode && FLAC_BITS[bitsCode] !== info.bits) || samples > info.maxBlock) return null;
  return { samples, length: p + 1 - at };
}

/** A FLAC file's frames, and a copy of just them with a STREAMINFO saying how many samples they hold, or null. */
export function flacLength(data: Uint8Array): MeasuredAudio | null {
  let at = afterId3(data);
  if (text(data, at, 4) !== "fLaC") return null;
  at += 4;
  let streaminfo: Uint8Array | null = null;
  // Metadata blocks: a flag for the last one, its type (0 is STREAMINFO) and its size.
  for (let last = false; !last; ) {
    if (at + 4 > data.length) return null;
    last = Boolean(data[at] & 0x80);
    const size = be24(data, at + 1);
    if ((data[at] & 0x7f) === 0 && size === 34 && !streaminfo) streaminfo = data.subarray(at + 4, at + 38);
    at += 4 + size;
  }
  if (!streaminfo || at > data.length) return null;
  const info: FlacInfo = {
    rate: (be16(streaminfo, 10) << 4) | (streaminfo[12] >> 4),
    channels: ((streaminfo[12] >> 1) & 7) + 1,
    bits: (((streaminfo[12] & 1) << 4) | (streaminfo[13] >> 4)) + 1,
    maxBlock: be16(streaminfo, 2),
  };
  const claimed = (streaminfo[13] & 0xf) * 0x100000000 + be32(streaminfo, 14);
  if (!info.rate || info.maxBlock < 16) return null;
  const frames: Uint8Array[] = [];
  let samples = 0;
  // Each frame runs to where the checksum over it comes out right and the next frame (or the file's end) starts.
  while (at < data.length) {
    if (frames.length >= MAX_FRAMES) return null;
    const head = flacHeader(data, at, info);
    if (!head) break;
    let crc = 0;
    let end = 0;
    for (let i = at; i < data.length; i++) {
      crc = ((crc << 8) & 0xffff) ^ CRC16[(crc >> 8) ^ data[i]];
      if (crc === 0 && i + 1 - at > head.length + 2 && (i + 1 === data.length || flacHeader(data, i + 1, info))) {
        end = i + 1;
        break;
      }
    }
    // A frame whose end can't be found is broken, and so is what follows: none of it is played.
    if (!end) break;
    frames.push(data.subarray(at, end));
    samples += head.samples;
    at = end;
  }
  if (!frames.length) return null;
  const copy = Buffer.from(streaminfo);
  // The samples counted, and no checksum of the sound, which is no longer the file's.
  copy[13] = (copy[13] & 0xf0) | Math.floor(samples / 0x100000000);
  copy.writeUInt32BE(samples % 0x100000000, 14);
  copy.fill(0, 18, 34);
  return {
    length: { decoded: samples / info.rate, declared: claimed / info.rate },
    file: { data: Buffer.concat([Buffer.from("fLaC"), Uint8Array.of(0x80, 0, 0, 34), copy, ...frames]), mediaType: "audio/flac", extension: "flac" },
  };
}
