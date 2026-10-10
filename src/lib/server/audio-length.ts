/*
 * How long a recording really is, read from the file itself, so transcription is priced on the
 * audio a provider will hear rather than on its size: Opus can fit an hour into less than a
 * megabyte. Reads Opus in Ogg (what Firefox records) and in WebM (Chrome), counting every packet's
 * length from its first byte as a decoder would (RFC 6716 §3.1), and PCM WAV from its header.
 * Every guess leans long, so a forged file is never priced as shorter than what a decoder plays.
 *
 * Players differ on broken files (one skips a page whose checksum is wrong and finds pages hidden
 * inside it, another plays it), so what is measured is also what is sent: measureAudio makes a
 * clean copy holding exactly the sound it counted, and only that copy goes to the transcriber.
 */

/** A recording's length in seconds. */
export type AudioLength = {
  // What a decoder plays: every audio packet added up.
  decoded: number;
  // What the file says it lasts (Ogg granule positions, WebM durations and times, WAV's data size), or 0.
  declared: number;
};

/** A recording Flash measured, and a copy of it with exactly the sound measured, to send on instead. */
export type MeasuredAudio = { length: AudioLength; file: { data: Buffer; mediaType: "audio/ogg" | "audio/wav"; extension: "ogg" | "wav" } };

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
 * An Opus recording in Ogg or WebM, or a plain WAV: its length, and a clean copy of it (Opus in Ogg,
 * or WAV) holding exactly the sound counted. null when the file is something else (another codec,
 * another container) or can't be read.
 */
export function measureAudio(data: Uint8Array): MeasuredAudio | null {
  if (ascii(data, 0, "OggS")) return oggLength(data);
  if (data[0] === 0x1a && data[1] === 0x45 && data[2] === 0xdf && data[3] === 0xa3) return webmLength(data);
  if ((ascii(data, 0, "RIFF") || ascii(data, 0, "RF64") || ascii(data, 0, "BW64")) && ascii(data, 8, "WAVE")) return wavLength(data);
  return null;
}

/** The length of an Opus recording in Ogg, WebM or a PCM WAV, or null (see measureAudio). */
export const audioLength = (data: Uint8Array): AudioLength | null => measureAudio(data)?.length ?? null;

/** The most seconds a provider can bill for a recording: what it plays or says it lasts, whichever is longer. */
export const billableSeconds = (length: AudioLength) => Math.max(length.decoded, length.declared);

/** One stream of Opus sound: its identification header, its comment header if it had one, and its packets. */
type OpusTrack = { head: Uint8Array; tags?: Uint8Array; packets: Uint8Array[] };

type OggStream = { track: OpusTrack | null; packets: number; granule: number; preSkip: number; partial: Uint8Array[] | null };

/*
 * Ogg: pages of packets, each page with its stream's serial number and the stream's position in
 * samples so far (the granule). A decoder that meets bytes that aren't a page looks for the next
 * one, so this does too.
 */
function oggLength(data: Uint8Array): MeasuredAudio | null {
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
    let size = 0;
    for (let i = 0; i < segments; i++) size += data[at + 27 + i];
    // A page cut off at the end of the file is never played.
    if (bodyAt + size > data.length) break;
    let stream = streams.get(serial);
    if (!stream) {
      // A stream must open with its first page; one that doesn't can't be told apart from noise.
      if (!(flags & 2)) return null;
      stream = { track: null, packets: 0, granule: 0, preSkip: 0, partial: null };
      streams.set(serial, stream);
    }
    // Packets on this page: a lacing value of 255 carries on into the next one, anything less ends
    // a packet. One left open on the page before carries on only on a page that says so; the start
    // of a packet that was never seen is skipped, as a decoder does.
    let skipping = Boolean(flags & 1) && !stream.partial;
    if (!(flags & 1)) stream.partial = null;
    let offset = bodyAt;
    let start = bodyAt;
    for (let i = 0; i < segments; i++) {
      const lace = data[at + 27 + i];
      offset += lace;
      if (lace === 255) continue;
      const piece = data.subarray(start, offset);
      start = offset;
      if (skipping) {
        skipping = false;
        continue;
      }
      const whole = stream.partial ? concat([...stream.partial, piece]) : piece;
      stream.partial = null;
      if (!packet(stream, whole)) return null;
    }
    if (start < offset && !skipping) stream.partial = [...(stream.partial ?? []), data.subarray(start, offset)];
    // A granule of all ones means no packet ends on this page.
    if (!(granuleLow === 0xffffffff && granuleHigh === 0xffffffff)) {
      stream.granule = Math.max(stream.granule, granuleHigh * 0x100000000 + granuleLow);
    }
    at = offset;
  }
  // A file with no Opus in it isn't a recording Flash can measure.
  const opus = [...streams.values()].filter((s) => s.track);
  if (!opus.length) return null;
  let declared = 0;
  for (const s of opus) declared += Math.max(0, s.granule - s.preSkip);
  return measured(
    opus.map((s) => s.track!),
    declared / OPUS_RATE,
  );
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
      stream.track = { head: bytes, packets: [] };
      stream.preSkip = bytes.length >= 12 ? u16(bytes, 10) : 0;
      return true;
    }
    return SILENT_CODECS.some((magic) => ascii(bytes, 0, magic));
  }
  if (!stream.track) return true;
  // The second Opus packet holds tags; every other is sound.
  if (index === 1 && ascii(bytes, 0, "OpusTags")) {
    stream.track.tags = bytes;
    return true;
  }
  stream.track.packets.push(bytes);
  return true;
}

const concat = (parts: Uint8Array[]) => Buffer.concat(parts);

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
const CODEC_PRIVATE = 0x63a2;
const AUDIO = 0xe1;
const CHANNELS = 0x9f;
const ENCODINGS = 0x6d80;
const CLUSTER = 0x1f43b675;
const CLUSTER_TIME = 0xe7;
const SIMPLE_BLOCK = 0xa3;
const GROUP = 0xa0;
const BLOCK = 0xa1;
const BLOCK_DURATION = 0x9b;
// Elements read through: their children follow straight after their own header.
const READ_THROUGH = new Set([EBML.segment, EBML.info, TRACKS, TRACK, AUDIO, CLUSTER, GROUP]);
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

type WebmTrack = { number: number; type: number; codec: string; encoded: boolean; head?: Uint8Array; channels: number };
type WebmBlock = { track: number; time: number; frames: Uint8Array[]; duration: number };

function webmLength(data: Uint8Array): MeasuredAudio | null {
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
        track = { number: 0, type: 0, codec: "", encoded: false, channels: 1 };
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
      case CODEC_PRIVATE:
        if (track) track.head = value;
        break;
      case CHANNELS:
        if (track) track.channels = uint(value, 0, value.length);
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
  const sound = new Map<WebmTrack, OpusTrack>();
  let first = Infinity;
  let last = -Infinity;
  for (const b of blocks) {
    const t = tracks.find((x) => x.number === b.track);
    // A block for a track that isn't described can't be played.
    if (!t) continue;
    const audio = t.type === 2 || t.codec.startsWith("A_");
    if (!audio) continue;
    if (t.codec !== "A_OPUS" || t.encoded) return null;
    let opus = sound.get(t);
    if (!opus) sound.set(t, (opus = { head: t.head && ascii(t.head, 0, "OpusHead") ? t.head : opusHead(t.channels), packets: [] }));
    opus.packets.push(...b.frames);
    const samples = b.frames.reduce((sum, f) => sum + opusPacketSamples(f), 0);
    first = Math.min(first, b.time);
    // Where the block ends, in the file's time units: its own length, or the one the file gives.
    last = Math.max(last, b.time + Math.max(b.duration, (samples / OPUS_RATE) * (1e9 / scale)));
  }
  const unit = scale / 1e9;
  const span = last > first ? (last - first) * unit : 0;
  return measured([...sound.values()], Math.max(span, infoDuration > 0 && Number.isFinite(infoDuration) ? infoDuration * unit : 0));
}

/** One WebM block: its track, time, and its Opus frames (laced ones split apart). */
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
  const frames: Uint8Array[] = [];
  for (const size of [...sizes, Math.max(0, value.length - at - sizes.reduce((a, b) => a + b, 0))]) {
    frames.push(value.subarray(at, Math.min(at + size, value.length)));
    at += size;
  }
  return { track: track.value, time: clusterTime + relative, frames, duration: 0 };
}

/*
 * WAV: a header that says how the samples are stored, then the samples. Only plain samples (PCM,
 * float, A-law and µ-law) are measured, from the data really there rather than the rate written in
 * the header, which can be anything.
 */
const PLAIN_SAMPLES = new Set([1, 3, 6, 7]);

function wavLength(data: Uint8Array): MeasuredAudio | null {
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
      const frame = format.channels * Math.ceil(format.bits / 8);
      const declaredSize = size === 0xffffffff ? bigDataSize : size;
      // The samples the data chunk says it holds, or everything after it when it says more (or nothing).
      const samples = data.subarray(body, declaredSize && body + declaredSize <= data.length ? body + declaredSize : data.length);
      const kept = samples.subarray(0, samples.length - (samples.length % frame));
      // A header can claim smaller sample frames than its format has, so it's priced on the smaller.
      const perSecond = format.rate * Math.max(1, Math.min(frame, format.align || Infinity));
      return {
        length: { decoded: samples.length / perSecond, declared: declaredSize / perSecond },
        file: { data: wavFile(format, kept), mediaType: "audio/wav", extension: "wav" },
      };
    }
    at = body + size + (size & 1);
  }
  return null;
}

/** A plain WAV file of samples stored as format says. */
function wavFile(format: { tag: number; channels: number; rate: number; bits: number }, samples: Uint8Array): Buffer {
  const frame = format.channels * Math.ceil(format.bits / 8);
  const head = Buffer.alloc(44);
  head.write("RIFF", 0);
  head.writeUInt32LE(36 + samples.length, 4);
  head.write("WAVEfmt ", 8);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(format.tag, 20);
  head.writeUInt16LE(format.channels, 22);
  head.writeUInt32LE(format.rate, 24);
  head.writeUInt32LE(Math.min(0xffffffff, format.rate * frame), 28);
  head.writeUInt16LE(frame, 32);
  head.writeUInt16LE(format.bits, 34);
  head.write("data", 36);
  head.writeUInt32LE(samples.length, 40);
  return Buffer.concat([head, samples]);
}

/*
 * The clean copy of Opus sound: each stream in Ogg, one after the other, with the packets counted and
 * nothing else, and granule positions that say exactly how long they play.
 */

/** How long the Opus streams play, and the clean copy that plays just that. declared: what the file claimed. */
function measured(tracks: OpusTrack[], declared: number): MeasuredAudio {
  const samples = tracks.reduce((sum, t) => sum + t.packets.reduce((s, p) => s + opusPacketSamples(p), 0), 0);
  return {
    length: { decoded: samples / OPUS_RATE, declared },
    file: { data: Buffer.concat(tracks.map((t, i) => oggStream(t, i + 1))), mediaType: "audio/ogg", extension: "ogg" },
  };
}

/** Opus's identification header for a stream that came without one: no pre-skip, one or two channels. */
function opusHead(channels: number): Uint8Array {
  const head = Buffer.alloc(19);
  head.write("OpusHead", 0);
  head[8] = 1;
  head[9] = channels === 2 ? 2 : 1;
  head.writeUInt32LE(OPUS_RATE, 12);
  return head;
}

/** Opus's comment header, naming Flash as what wrote the file. */
const OPUS_TAGS = (() => {
  const vendor = Buffer.from("Flash");
  const tags = Buffer.alloc(16 + vendor.length);
  tags.write("OpusTags", 0);
  tags.writeUInt32LE(vendor.length, 8);
  vendor.copy(tags, 12);
  return tags;
})();

/** One Opus stream in Ogg: its two headers on pages of their own, then its packets. */
function oggStream(track: OpusTrack, serial: number): Buffer {
  const preSkip = track.head.length >= 12 ? u16(track.head, 10) : 0;
  const pages = [oggPage([track.head], serial, 0, 2, 0, false), oggPage([track.tags ?? OPUS_TAGS], serial, 1, 0, 0, false)];
  let position = preSkip;
  let packets: Uint8Array[] = [];
  let laces = 0;
  // A page holds up to 255 lacing values; a longer packet goes on into the pages after.
  const flush = (last: boolean) => {
    pages.push(oggPage(packets, serial, pages.length, last ? 4 : 0, position, false));
    packets = [];
    laces = 0;
  };
  for (const p of track.packets) {
    const need = Math.floor(p.length / 255) + 1;
    if (laces && laces + need > 255) flush(false);
    if (need > 255) {
      // Only a packet bigger than a page: its first pieces fill pages of their own.
      let rest = p;
      while (Math.floor(rest.length / 255) + 1 > 255) {
        pages.push(oggPage([rest.subarray(0, 255 * 255)], serial, pages.length, rest === p ? 0 : 1, -1, true));
        rest = rest.subarray(255 * 255);
      }
      position += opusPacketSamples(p);
      pages.push(oggPage([rest], serial, pages.length, 1, position, false));
      continue;
    }
    packets.push(p);
    laces += need;
    position += opusPacketSamples(p);
  }
  flush(true);
  return Buffer.concat(pages);
}

// Ogg's page checksum: CRC-32 with polynomial 0x04c11db7, not reflected.
const CRC = Array.from({ length: 256 }, (_, i) => {
  let r = i << 24;
  for (let j = 0; j < 8; j++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
  return r >>> 0;
});

/**
 * One Ogg page: flags 2 opens the stream, 1 carries a packet on from the page before, 4 ends the
 * stream. granule -1 says no packet ends on it; open leaves its last packet going on to the next page.
 */
function oggPage(packets: Uint8Array[], serial: number, sequence: number, flags: number, granule: number, open: boolean): Buffer {
  const lacing: number[] = [];
  packets.forEach((p, i) => {
    for (let n = p.length; n >= 255; n -= 255) lacing.push(255);
    if (!(open && i === packets.length - 1)) lacing.push(p.length % 255);
  });
  const header = Buffer.alloc(27 + lacing.length);
  header.write("OggS", 0);
  header[5] = flags;
  header.writeBigInt64LE(BigInt(granule), 6);
  header.writeUInt32LE(serial, 14);
  header.writeUInt32LE(sequence, 18);
  header[26] = lacing.length;
  lacing.forEach((v, i) => (header[27 + i] = v));
  const page = Buffer.concat([header, ...packets]);
  let crc = 0;
  for (const b of page) crc = ((crc << 8) ^ CRC[((crc >>> 24) ^ b) & 0xff]) >>> 0;
  page.writeUInt32LE(crc, 22);
  return page;
}
