/*
 * Recordings built byte by byte for the tests: Opus and Vorbis in Ogg, Opus in WebM, WAV, MP3, raw
 * AAC and FLAC, including forged ones (an hour of sound in a few kilobytes, lengths that lie, pages
 * hidden in a broken one), and a player that hears an Ogg file the way libogg and ffmpeg do. Not a
 * test file itself.
 */
import { opusPacketSamples } from "../src/lib/server/audio-length.ts";

// Ogg's page checksum: CRC-32 with polynomial 0x04c11db7, not reflected.
const CRC = Array.from({ length: 256 }, (_, i) => {
  let r = i << 24;
  for (let j = 0; j < 8; j++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
  return r >>> 0;
});
const crc = (bytes: Uint8Array) => bytes.reduce((c, b) => ((c << 8) ^ CRC[((c >>> 24) ^ b) & 0xff]) >>> 0, 0);

export type OggPage = {
  packets: Uint8Array[];
  serial?: number;
  // 2: the stream's first page; 1: its first packet carries on from the page before; 4: its last page.
  flags?: number;
  granule?: number;
  // The last packet goes on into the next page (its length must be a multiple of 255).
  open?: boolean;
};

/** One Ogg page with a correct checksum. */
export function oggPage({ packets, serial = 1, flags = 0, granule = 0, open = false }: OggPage, sequence = 0): Buffer {
  const lacing: number[] = [];
  packets.forEach((p, i) => {
    for (let n = p.length; n >= 255; n -= 255) lacing.push(255);
    if (!(open && i === packets.length - 1)) lacing.push(p.length % 255);
  });
  const header = Buffer.alloc(27 + lacing.length);
  header.write("OggS", 0);
  header[5] = flags;
  header.writeBigUInt64LE(BigInt(granule), 6);
  header.writeUInt32LE(serial, 14);
  header.writeUInt32LE(sequence, 18);
  header[26] = lacing.length;
  lacing.forEach((v, i) => (header[27 + i] = v));
  const page = Buffer.concat([header, ...packets]);
  page.writeUInt32LE(crc(page), 22);
  return page;
}

/** Opus's identification header: one channel, 312 samples of pre-skip. */
export const opusHead = (preSkip = 312) => {
  const b = Buffer.alloc(19);
  b.write("OpusHead", 0);
  b[8] = 1;
  b[9] = 1;
  b.writeUInt16LE(preSkip, 10);
  b.writeUInt32LE(48000, 12);
  return b;
};

/** Opus's comment header; the vendor string can carry a word for a test's stand-in service to read. */
export const opusTags = (vendor = "flash test") => {
  const b = Buffer.alloc(16 + vendor.length);
  b.write("OpusTags", 0);
  b.writeUInt32LE(vendor.length, 8);
  b.write(vendor, 12);
  return b;
};

// TOC bytes (RFC 6716 §3.1): SILK narrowband 20 ms in one frame, and 60 ms twice (120 ms) in a packet of one byte.
export const OPUS_20MS = 0x08;
export const OPUS_120MS = 0x19;

/**
 * Opus in Ogg: the two headers, then the packets, 255 to a page. granule: what each page claims
 * (by default the true position); vendor: a word in the comment header.
 */
export function oggOpus(packets: Uint8Array[], { granule, vendor, serial = 1 }: { granule?: (truth: number) => number; vendor?: string; serial?: number } = {}): Buffer {
  const pages = [oggPage({ packets: [opusHead()], serial, flags: 2 }), oggPage({ packets: [opusTags(vendor)], serial }, 1)];
  let position = 312;
  for (let i = 0; i < packets.length || i === 0; i += 255) {
    const chunk = packets.slice(i, i + 255);
    position += chunk.reduce((sum, p) => sum + samplesOf(p), 0);
    const last = i + 255 >= packets.length;
    pages.push(oggPage({ packets: chunk, serial, flags: last ? 4 : 0, granule: granule ? granule(position) : position }, pages.length));
  }
  return Buffer.concat(pages);
}

const samplesOf = (p: Uint8Array) => (p[0] === OPUS_120MS ? 5760 : 960);

/** Seconds of speech in packets of 20 ms. */
export const opusSpeech = (seconds: number) => Array.from({ length: Math.round(seconds * 50) }, () => Uint8Array.from([OPUS_20MS, 1, 2, 3]));

/** An EBML element: its id, its size (or unknown), then its body. */
export function ebml(id: number, body: Uint8Array[] | Uint8Array | number | string, { unknown = false } = {}): Buffer {
  const idBytes = Buffer.from(id.toString(16).padStart(Math.ceil(id.toString(16).length / 2) * 2, "0"), "hex");
  const data =
    typeof body === "number"
      ? Buffer.from(body.toString(16).padStart(Math.ceil(body.toString(16).length / 2) * 2, "0"), "hex")
      : typeof body === "string"
        ? Buffer.from(body)
        : Array.isArray(body)
          ? Buffer.concat(body)
          : Buffer.from(body);
  // Sizes as 8-byte numbers; unknown is all ones.
  const size = Buffer.alloc(8);
  if (unknown) size.fill(0xff, 1);
  else size.writeBigUInt64BE(BigInt(data.length), 0);
  size[0] = 0x01;
  return Buffer.concat([idBytes, size, data]);
}

/** A WebM block's body: its track, time and flags, then frames (laced when there are several). */
export function webmBlock(track: number, time: number, frames: Uint8Array[], lacing: "none" | "xiph" | "fixed" | "ebml" = "none"): Buffer {
  const head = Buffer.alloc(4);
  head[0] = 0x80 | track;
  head.writeInt16BE(time, 1);
  head[3] = 0x80 | ({ none: 0, xiph: 1, fixed: 2, ebml: 3 }[lacing] << 1);
  if (lacing === "none") return Buffer.concat([head, ...frames]);
  const sizes: number[] = [];
  if (lacing === "xiph") {
    for (const f of frames.slice(0, -1)) {
      for (let n = f.length; n >= 255; n -= 255) sizes.push(255);
      sizes.push(f.length % 255);
    }
  } else if (lacing === "ebml") {
    // The first size, then differences, as one-byte numbers (biased by 63).
    sizes.push(0x80 | frames[0].length);
    for (let i = 1; i < frames.length - 1; i++) sizes.push(0x80 | (frames[i].length - frames[i - 1].length + 63));
  }
  return Buffer.concat([head, Buffer.from([frames.length - 1, ...sizes]), ...frames]);
}

/**
 * Opus in WebM the way Chrome records it: a segment and clusters of unknown size. tracks: extra
 * track entries; blocks: the clusters' contents, each a [time, block body] pair.
 */
export function webm({
  clusters,
  codec = "A_OPUS",
  extraTracks = [],
  info = [],
  encoded = false,
}: {
  clusters: { time: number; blocks: Buffer[] }[];
  codec?: string;
  extraTracks?: Buffer[];
  info?: Buffer[];
  encoded?: boolean;
}): Buffer {
  const header = ebml(0x1a45dfa3, [ebml(0x4282, "webm")]);
  const track = ebml(0xae, [ebml(0xd7, 1), ebml(0x83, 2), ebml(0x86, codec), ...(encoded ? [ebml(0x6d80, [ebml(0x6240, [])])] : [])]);
  const segment = [ebml(0x1549a966, [ebml(0x2ad7b1, 1_000_000), ...info]), ebml(0x1654ae6b, [track, ...extraTracks])];
  for (const c of clusters) segment.push(ebml(0x1f43b675, [ebml(0xe7, c.time), ...c.blocks.map((b) => ebml(0xa3, b))], { unknown: true }));
  return Buffer.concat([header, ebml(0x18538067, segment, { unknown: true })]);
}

/** A WAV file: format tag, channels, sample rate and bits, then the samples (dataSize: what the header says). */
export function wav({ tag = 1, channels = 1, rate = 8000, bits = 16, data, dataSize }: { tag?: number; channels?: number; rate?: number; bits?: number; data: Buffer; dataSize?: number }): Buffer {
  const fmt = Buffer.alloc(24);
  fmt.write("fmt ", 0);
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(tag, 8);
  fmt.writeUInt16LE(channels, 10);
  fmt.writeUInt32LE(rate, 12);
  fmt.writeUInt32LE((rate * channels * bits) / 8, 16);
  fmt.writeUInt16LE((channels * bits) / 8, 20);
  fmt.writeUInt16LE(bits, 22);
  const head = Buffer.alloc(8);
  head.write("data", 0);
  head.writeUInt32LE(dataSize ?? data.length, 4);
  const riff = Buffer.alloc(12);
  riff.write("RIFF", 0);
  riff.writeUInt32LE(4 + fmt.length + head.length + data.length, 4);
  riff.write("WAVE", 8);
  return Buffer.concat([riff, fmt, head, data]);
}

/**
 * Seconds of Opus a player that checks every page's checksum hears in an Ogg file, as libogg and
 * ffmpeg do: a page whose checksum is wrong is skipped, and the search for the next page starts
 * inside it. Each stream's first two packets are its headers.
 */
export function playedSeconds(file: Uint8Array): number {
  const packets = new Map<number, number>();
  const first = new Map<number, Uint8Array>();
  let samples = 0;
  let at = 0;
  while (at + 27 <= file.length) {
    if (!(file[at] === 0x4f && file[at + 1] === 0x67 && file[at + 2] === 0x67 && file[at + 3] === 0x53)) {
      at++;
      continue;
    }
    const segments = file[at + 26];
    const bodyAt = at + 27 + segments;
    let size = 0;
    for (let i = 0; i < segments && at + 27 + i < file.length; i++) size += file[at + 27 + i];
    if (bodyAt + size > file.length) {
      at++;
      continue;
    }
    const page = Buffer.from(file.subarray(at, bodyAt + size));
    const want = page.readUInt32LE(22);
    page.writeUInt32LE(0, 22);
    if (crc(page) !== want) {
      at++;
      continue;
    }
    const serial = page.readUInt32LE(14);
    let start = bodyAt;
    let offset = bodyAt;
    for (let i = 0; i < segments; i++) {
      const lace = file[at + 27 + i];
      offset += lace;
      if (lace === 255) continue;
      const head = first.get(serial) ?? file.subarray(start, offset);
      first.delete(serial);
      const n = packets.get(serial) ?? 0;
      packets.set(serial, n + 1);
      if (n >= 2) samples += opusPacketSamples(head);
      start = offset;
    }
    if (start < offset && !first.has(serial)) first.set(serial, file.subarray(start, offset));
    at = bodyAt + size;
  }
  return samples / 48000;
}

/**
 * An Ogg Opus file whose real sound hides inside pages with broken checksums: a player that checks
 * checksums finds pages minutes long within them, while the pages themselves hold one 20 ms packet.
 */
export function hiddenPages(minutes: number): Buffer {
  const pages: Buffer[] = [];
  let sequence = 2;
  for (let i = 0; i < Math.ceil((minutes * 60) / (255 * 0.12)); i++) {
    pages.push(oggPage({ packets: Array.from({ length: 255 }, () => Uint8Array.of(OPUS_120MS)), granule: 0 }, sequence++));
  }
  const inner = Buffer.concat(pages);
  const outer: Buffer[] = [];
  for (let at = 0; at < inner.length; at += 255 * 254) {
    const page = oggPage({ packets: [Buffer.concat([Uint8Array.of(OPUS_20MS), inner.subarray(at, at + 255 * 254)])] }, sequence++);
    page[22] ^= 0xff;
    outer.push(page);
  }
  return Buffer.concat([oggPage({ packets: [opusHead()], flags: 2 }), oggPage({ packets: [opusTags()] }, 1), ...outer]);
}

/**
 * An Ogg Vorbis file: its three headers (8 kHz, 256- and 2^long-sample blocks), then the packets
 * given, which a player takes for sound when their first bit is clear.
 */
export function oggVorbis(packets: Uint8Array[], { rate = 8000, long = 13, granule = 0 }: { rate?: number; long?: number; granule?: number } = {}): Buffer {
  const id = Buffer.alloc(30);
  id.write("\x01vorbis", 0, "latin1");
  id[11] = 1;
  id.writeUInt32LE(rate, 12);
  id[28] = (long << 4) | 8;
  id[29] = 1;
  const comment = Buffer.concat([Buffer.from("\x03vorbis", "latin1"), Buffer.from([5, 0, 0, 0]), Buffer.from("flash"), Buffer.alloc(4), Buffer.from([1])]);
  const setup = Buffer.concat([Buffer.from("\x05vorbis", "latin1"), Buffer.alloc(20, 0x42)]);
  const pages = [oggPage({ packets: [id], flags: 2 }), oggPage({ packets: [comment, setup] }, 1)];
  for (let i = 0; i < packets.length; i += 255) pages.push(oggPage({ packets: packets.slice(i, i + 255), granule }, pages.length));
  return Buffer.concat(pages);
}

/** An MPEG-1 Layer III frame at 128 kbps and 44.1 kHz, mono: 417 bytes playing 1,152 samples. */
export function mp3Frame(note = ""): Buffer {
  const frame = Buffer.alloc(417);
  frame.set([0xff, 0xfb, 0x90, 0xc4]);
  // After the side information, where an encoder writes its Xing or Info frame.
  frame.write(note, 21, "latin1");
  return frame;
}

/** A raw AAC file: an ADTS header (AAC-LC, 8 kHz by default, no checksum) before each payload. */
export function adts(payloads: Uint8Array[], { rateIndex = 11, channels = 1, blocks = 1 } = {}): Buffer {
  return Buffer.concat(
    payloads.flatMap((p) => {
      const length = p.length + 7;
      const header = Uint8Array.of(
        0xff,
        0xf1,
        (1 << 6) | (rateIndex << 2) | (channels >> 2),
        ((channels & 3) << 6) | (length >> 11),
        (length >> 3) & 0xff,
        ((length & 7) << 5) | 0x1f,
        0xfc | (blocks - 1),
      );
      return [header, p];
    }),
  );
}

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

/** A frame number as FLAC writes it, like UTF-8. */
const flacNumber = (n: number) =>
  n < 0x80 ? [n] : n < 0x800 ? [0xc0 | (n >> 6), 0x80 | (n & 63)] : [0xe0 | (n >> 12), 0x80 | ((n >> 6) & 63), 0x80 | (n & 63)];

/**
 * A FLAC file of quiet at 8 kHz, 16-bit mono: frames blocks of block samples each (one constant
 * value per frame, about 14 bytes), with a STREAMINFO claiming claimed samples (the truth by default).
 */
export function flac(frames: number, { block = 4096, claimed = frames * block }: { block?: number; claimed?: number } = {}): Buffer {
  const info = Buffer.alloc(34);
  info.writeUInt16BE(block, 0);
  info.writeUInt16BE(block, 2);
  // Rate (20 bits), channels - 1 (3), bits - 1 (5) and total samples (36).
  info.writeUInt32BE((8000 << 12) | (0 << 9) | (15 << 4) | Math.floor(claimed / 0x100000000), 10);
  info.writeUInt32BE(claimed % 0x100000000, 14);
  const out: Uint8Array[] = [Buffer.from("fLaC"), Uint8Array.of(0x80, 0, 0, 34), info];
  for (let i = 0; i < frames; i++) {
    // Block size from the end of the header (7), 8 kHz (4); mono, 16-bit (4).
    const header = [0xff, 0xf8, 0x74, 0x08, ...flacNumber(i), (block - 1) >> 8, (block - 1) & 0xff];
    header.push(header.reduce((c, b) => CRC8[c ^ b], 0));
    // A constant subframe of 0.
    const frame = [...header, 0x00, 0x00, 0x00];
    const check = frame.reduce((c, b) => ((c << 8) & 0xffff) ^ CRC16[(c >> 8) ^ b], 0);
    out.push(Uint8Array.from([...frame, check >> 8, check & 0xff]));
  }
  return Buffer.concat(out);
}
