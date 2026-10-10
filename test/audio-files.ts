/*
 * Recordings built byte by byte for the tests: Opus in Ogg and in WebM, and WAV, including forged
 * ones (an hour of sound in a few kilobytes, lengths that lie). Not a test file itself.
 */

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
