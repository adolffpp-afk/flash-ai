/*
 * How long a recording really is, read from the file itself, so transcription is priced on the
 * audio a provider will hear rather than on its size: Opus can fit an hour into less than a
 * megabyte. Reads Opus in Ogg (what Firefox records) and in WebM (Chrome), counting every packet's
 * length from its first byte as a decoder would (RFC 6716 §3.1), and PCM WAV from its header.
 * Every guess leans long, so a forged file is never priced as shorter than what a decoder plays.
 */

/** A recording's length in seconds. */
export type AudioLength = {
  // What a decoder plays: every audio packet added up.
  decoded: number;
  // What the file says it lasts (Ogg granule positions, WebM durations and times, WAV's data size), or 0.
  declared: number;
};

// Opus counts time in samples at 48 kHz whatever it was recorded at.
const OPUS_RATE = 48_000;
// No Opus packet plays longer than 120 ms (RFC 6716 §3.2.5). A packet that's empty or claims more
// is counted as this much, the most a decoder could fill with guessed sound.
const MAX_PACKET_SAMPLES = 5760;

/**
 * How many samples (at 48 kHz) an Opus packet plays, from its TOC byte: the configuration gives each
 * frame's length (2.5 to 60 ms) and the last two bits how many frames there are.
 */
export function opusPacketSamples(packet: Uint8Array): number {
  if (!packet.length) return MAX_PACKET_SAMPLES;
  const toc = packet[0];
  const config = toc >> 3;
  const frame = config < 12 ? [480, 960, 1920, 2880][config & 3] : config < 16 ? [480, 960][config & 1] : [120, 240, 480, 960][config & 3];
  const code = toc & 3;
  const frames = code === 0 ? 1 : code < 3 ? 2 : packet.length > 1 ? packet[1] & 0x3f : 0;
  if (!frames) return MAX_PACKET_SAMPLES;
  return Math.min(MAX_PACKET_SAMPLES, frame * frames);
}

const ascii = (data: Uint8Array, at: number, text: string) =>
  at + text.length <= data.length && [...text].every((c, i) => data[at + i] === c.charCodeAt(0));
const u16 = (data: Uint8Array, at: number) => data[at] | (data[at + 1] << 8);
const u32 = (data: Uint8Array, at: number) => (data[at] | (data[at + 1] << 8) | (data[at + 2] << 16)) + data[at + 3] * 0x1000000;

/**
 * The length of an Opus recording in Ogg, WebM or a PCM WAV, or null when the file is something
 * else (another codec, another container) or can't be read.
 */
export function audioLength(data: Uint8Array): AudioLength | null {
  if (ascii(data, 0, "OggS")) return oggLength(data);
  if (data[0] === 0x1a && data[1] === 0x45 && data[2] === 0xdf && data[3] === 0xa3) return webmLength(data);
  if ((ascii(data, 0, "RIFF") || ascii(data, 0, "RF64") || ascii(data, 0, "BW64")) && ascii(data, 8, "WAVE")) return wavLength(data);
  return null;
}

/** The most seconds a provider can bill for a recording: what it plays or says it lasts, whichever is longer. */
export const billableSeconds = (length: AudioLength) => Math.max(length.decoded, length.declared);

type OggStream = { opus: boolean; packets: number; samples: number; granule: number; preSkip: number; open: boolean };

/*
 * Ogg: pages of packets, each page with its stream's serial number and the stream's position in
 * samples so far (the granule). A decoder that meets bytes that aren't a page looks for the next
 * one, so this does too.
 */
function oggLength(data: Uint8Array): AudioLength | null {
  const streams = new Map<number, OggStream>();
  let at = 0;
  while (at + 27 <= data.length) {
    if (!ascii(data, at, "OggS") || data[at + 4] !== 0) {
      const next = indexOf(data, OGGS, at + 1);
      if (next < 0) break;
      at = next;
      continue;
    }
    const flags = data[at + 5];
    const granuleLow = u32(data, at + 6);
    const granuleHigh = u32(data, at + 10);
    const serial = u32(data, at + 14);
    const segments = data[at + 26];
    const bodyAt = at + 27 + segments;
    if (bodyAt > data.length) break;
    let stream = streams.get(serial);
    if (!stream) {
      // A stream must open with its first page; one that doesn't can't be told apart from noise.
      if (!(flags & 2)) return null;
      stream = { opus: false, packets: 0, samples: 0, granule: 0, preSkip: 0, open: false };
      streams.set(serial, stream);
    }
    // Packets on this page: a lacing value of 255 carries on into the next one, anything less ends a packet.
    let offset = bodyAt;
    let start = bodyAt;
    let unfinished = false;
    // The page's first packet carries on from the page before when this flag is set and one was left open.
    let continued = Boolean(flags & 1) && stream.open;
    for (let i = 0; i < segments; i++) {
      const lace = data[at + 27 + i];
      offset += lace;
      unfinished = lace === 255;
      if (unfinished) continue;
      if (!continued && !packet(stream, data.subarray(start, Math.min(offset, data.length)))) return null;
      continued = false;
      start = offset;
    }
    // A packet that goes on into the next page is counted here, where it starts.
    if (unfinished && !continued && !packet(stream, data.subarray(start, Math.min(offset, data.length)))) return null;
    stream.open = unfinished;
    // A granule of all ones means no packet ends on this page.
    if (!(granuleLow === 0xffffffff && granuleHigh === 0xffffffff)) {
      stream.granule = Math.max(stream.granule, granuleHigh * 0x100000000 + granuleLow);
    }
    at = offset;
  }
  // A file with no Opus in it isn't a recording Flash can measure.
  if (![...streams.values()].some((s) => s.opus)) return null;
  let samples = 0;
  let declared = 0;
  for (const s of streams.values()) {
    if (!s.opus) continue;
    samples += s.samples;
    declared += Math.max(0, s.granule - s.preSkip);
  }
  return { decoded: samples / OPUS_RATE, declared: declared / OPUS_RATE };
}

const OGGS = Uint8Array.from([0x4f, 0x67, 0x67, 0x53]);

// Codecs a stream's first packet can name that hold no sound, so they're left out of the count.
const SILENT_CODECS = ["\x80theora", "fishead\0", "OVP80", "\x80kate", "BBCD\0", "\x80daala"];

/** Counts one Ogg packet of a stream. False when the stream holds sound Flash can't measure. */
function packet(stream: OggStream, bytes: Uint8Array): boolean {
  const index = stream.packets++;
  if (index === 0) {
    // The first packet names the codec.
    if (ascii(bytes, 0, "OpusHead")) {
      stream.opus = true;
      stream.preSkip = bytes.length >= 12 ? u16(bytes, 10) : 0;
      return true;
    }
    return SILENT_CODECS.some((magic) => ascii(bytes, 0, magic));
  }
  // The second Opus packet holds tags; every one after is sound.
  if (stream.opus && index >= 2) stream.samples += opusPacketSamples(bytes);
  return true;
}

function indexOf(data: Uint8Array, needle: Uint8Array, from: number): number {
  outer: for (let i = from; i + needle.length <= data.length; i++) {
    for (let j = 0; j < needle.length; j++) if (data[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

/*
 * WebM (Matroska): elements, each an id and a size, nested. Chrome's recorder leaves the size of the
 * segment and its clusters unknown, so the elements that hold others are read through rather than
 * skipped, and the rest are skipped by their size.
 */
const EBML = { header: 0x1a45dfa3, segment: 0x18538067, info: 0x1549a966, scale: 0x2ad7b1, duration: 0x4489 } as const;
const TRACKS = 0x1654ae6b;
const TRACK = 0xae;
const TRACK_NUMBER = 0xd7;
const TRACK_TYPE = 0x83;
const CODEC = 0x86;
const ENCODINGS = 0x6d80;
const CLUSTER = 0x1f43b675;
const CLUSTER_TIME = 0xe7;
const SIMPLE_BLOCK = 0xa3;
const GROUP = 0xa0;
const BLOCK = 0xa1;
const BLOCK_DURATION = 0x9b;
// Elements read through: their children follow straight after their own header.
const READ_THROUGH = new Set([EBML.segment, EBML.info, TRACKS, TRACK, CLUSTER, GROUP]);
const CLUSTER_ID = Uint8Array.from([0x1f, 0x43, 0xb6, 0x75]);

type Vint = { value: number; length: number; unknown: boolean };

/** A variable-length number: an element id (marker kept) or a size (marker dropped). */
function vint(data: Uint8Array, at: number, keepMarker: boolean): Vint | null {
  const first = data[at];
  if (!first || at >= data.length) return null;
  let length = 1;
  while (length <= 8 && !(first & (0x80 >> (length - 1)))) length++;
  if (length > 8 || at + length > data.length) return null;
  let value = keepMarker ? first : first & (0xff >> length);
  let ones = value === 0xff >> length;
  for (let i = 1; i < length; i++) {
    value = value * 256 + data[at + i];
    ones &&= data[at + i] === 0xff;
  }
  return { value, length, unknown: !keepMarker && ones };
}

const uint = (data: Uint8Array, at: number, size: number) => {
  let v = 0;
  for (let i = 0; i < size; i++) v = v * 256 + data[at + i];
  return v;
};

type WebmTrack = { number: number; type: number; codec: string; encoded: boolean };
type WebmBlock = { track: number; time: number; samples: number; duration: number };

function webmLength(data: Uint8Array): AudioLength | null {
  const tracks: WebmTrack[] = [];
  const blocks: WebmBlock[] = [];
  let scale = 1_000_000;
  let infoDuration = 0;
  let clusterTime = 0;
  let track: WebmTrack | null = null;
  let trackEnd = 0;
  let group: WebmBlock | null = null;
  let groupEnd = 0;
  let at = 0;
  while (at < data.length) {
    const id = vint(data, at, true);
    const size = id && vint(data, at + id.length, false);
    if (!id || !size || (size.unknown && !READ_THROUGH.has(id.value))) {
      // Not an element: carry on at the next cluster, as a player does.
      const next = indexOf(data, CLUSTER_ID, at + 1);
      if (next < 0) break;
      at = next;
      continue;
    }
    const body = at + id.length + size.length;
    const end = size.unknown ? data.length : body + size.value;
    if (at >= trackEnd) track = null;
    if (at >= groupEnd) group = null;
    if (READ_THROUGH.has(id.value)) {
      if (id.value === TRACK) {
        track = { number: 0, type: 0, codec: "", encoded: false };
        tracks.push(track);
        trackEnd = end;
      } else if (id.value === GROUP) groupEnd = end;
      at = body;
      continue;
    }
    const value = data.subarray(body, Math.min(end, data.length));
    switch (id.value) {
      case EBML.scale:
        scale = uint(value, 0, value.length) || scale;
        break;
      case EBML.duration:
        infoDuration = value.length === 4 ? new DataView(value.buffer, value.byteOffset, 4).getFloat32(0) : value.length === 8 ? new DataView(value.buffer, value.byteOffset, 8).getFloat64(0) : 0;
        break;
      case TRACK_NUMBER:
        if (track) track.number = uint(value, 0, value.length);
        break;
      case TRACK_TYPE:
        if (track) track.type = uint(value, 0, value.length);
        break;
      case CODEC:
        if (track) track.codec = String.fromCharCode(...value).replace(/\0+$/, "");
        break;
      case ENCODINGS:
        // Compressed or encrypted frames: their first byte isn't the packet's own.
        if (track) track.encoded = true;
        break;
      case CLUSTER_TIME:
        clusterTime = uint(value, 0, value.length);
        break;
      case SIMPLE_BLOCK:
      case BLOCK: {
        const block = readBlock(value, clusterTime);
        // A block cut off at the end of the file is never played; any other that can't be read is a forged file.
        if (!block && end > data.length) break;
        if (!block) return null;
        blocks.push(block);
        if (id.value === BLOCK && at < groupEnd) group = block;
        break;
      }
      case BLOCK_DURATION:
        if (group) group.duration = uint(value, 0, value.length);
        break;
    }
    at = end;
  }
  if (!tracks.some((t) => t.codec === "A_OPUS")) return null;
  let samples = 0;
  let first = Infinity;
  let last = -Infinity;
  for (const b of blocks) {
    const t = tracks.find((x) => x.number === b.track);
    // A block for a track that isn't described can't be played.
    if (!t) continue;
    const audio = t.type === 2 || t.codec.startsWith("A_");
    if (!audio) continue;
    if (t.codec !== "A_OPUS" || t.encoded) return null;
    samples += b.samples;
    first = Math.min(first, b.time);
    // Where the block ends, in the file's time units: its own length, or the one the file gives.
    last = Math.max(last, b.time + Math.max(b.duration, (b.samples / OPUS_RATE) * (1e9 / scale)));
  }
  const unit = scale / 1e9;
  const span = last > first ? (last - first) * unit : 0;
  return { decoded: samples / OPUS_RATE, declared: Math.max(span, infoDuration > 0 && Number.isFinite(infoDuration) ? infoDuration * unit : 0) };
}

/** One WebM block: its track, time, and the samples its Opus frames play (laced frames included). */
function readBlock(value: Uint8Array, clusterTime: number): WebmBlock | null {
  const track = vint(value, 0, false);
  if (!track || track.length + 3 > value.length) return null;
  const relative = new DataView(value.buffer, value.byteOffset + track.length, 2).getInt16(0);
  const flags = value[track.length + 2];
  let at = track.length + 3;
  const sizes: number[] = [];
  const lacing = (flags >> 1) & 3;
  if (lacing) {
    if (at >= value.length) return null;
    const count = value[at++] + 1;
    if (lacing === 1) {
      // Xiph lacing: each size as bytes of 255 and a last byte under it.
      for (let i = 0; i < count - 1; i++) {
        let size = 0;
        while (at < value.length && value[at] === 255) size += value[at++];
        if (at >= value.length) return null;
        sizes.push(size + value[at++]);
      }
    } else if (lacing === 3) {
      // EBML lacing: the first size, then each one's difference from the one before.
      const firstSize = vint(value, at, false);
      if (!firstSize) return null;
      at += firstSize.length;
      sizes.push(firstSize.value);
      for (let i = 1; i < count - 1; i++) {
        const diff = vint(value, at, false);
        if (!diff) return null;
        at += diff.length;
        sizes.push(sizes[i - 1] + diff.value - (2 ** (7 * diff.length - 1) - 1));
      }
    } else {
      // Fixed-size lacing: the rest shared out evenly.
      const each = Math.floor((value.length - at) / count);
      for (let i = 0; i < count - 1; i++) sizes.push(each);
    }
    if (sizes.some((s) => s < 0)) return null;
  }
  let samples = 0;
  for (const size of [...sizes, Math.max(0, value.length - at - sizes.reduce((a, b) => a + b, 0))]) {
    samples += opusPacketSamples(value.subarray(at, Math.min(at + size, value.length)));
    at += size;
  }
  return { track: track.value, time: clusterTime + relative, samples, duration: 0 };
}

/*
 * WAV: a header that says how the samples are stored, then the samples. Only plain samples (PCM,
 * float, A-law and µ-law) are measured, from the data really there rather than the rate written in
 * the header, which can be anything.
 */
const PLAIN_SAMPLES = new Set([1, 3, 6, 7]);

function wavLength(data: Uint8Array): AudioLength | null {
  let at = 12;
  let format: { tag: number; channels: number; rate: number; bits: number; align: number } | null = null;
  // RF64 keeps sizes over 4 GB in its ds64 chunk.
  let bigDataSize = 0;
  while (at + 8 <= data.length) {
    const size = u32(data, at + 4);
    const body = at + 8;
    if (ascii(data, at, "ds64") && body + 24 <= data.length) bigDataSize = u32(data, body + 8) + u32(data, body + 12) * 0x100000000;
    if (ascii(data, at, "fmt ")) {
      if (body + 16 > data.length) return null;
      let tag = u16(data, body);
      // WAVE_FORMAT_EXTENSIBLE names the real format in its sub-format.
      if (tag === 0xfffe && size >= 40 && body + 26 <= data.length) tag = u16(data, body + 24);
      format = { tag, channels: u16(data, body + 2), rate: u32(data, body + 4), bits: u16(data, body + 14), align: u16(data, body + 12) };
    }
    if (ascii(data, at, "data")) {
      if (!format || !PLAIN_SAMPLES.has(format.tag) || !format.channels || !format.rate || !format.bits) return null;
      const frame = Math.max(1, Math.min(format.channels * Math.ceil(format.bits / 8), format.align || Infinity));
      const perSecond = format.rate * frame;
      const declaredSize = size === 0xffffffff ? bigDataSize : size;
      return { decoded: (data.length - body) / perSecond, declared: declaredSize / perSecond };
    }
    at = body + size + (size & 1);
  }
  return null;
}
