import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MAX_PACKETS, billableSeconds, measureAudio, type MeasuredAudio } from "../src/lib/server/audio-length.ts";
import { MAX_FRAMES, aacConfig, m4a } from "../src/lib/server/audio-codecs.ts";
import { transcribeCostCents } from "../src/lib/credits.ts";
import { adts, flac, mp3Frame, oggVorbis, webm, webmBlock } from "./audio-files.ts";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
const near = (actual: number, expected: number, slack = 0.15) => assert.ok(Math.abs(actual - expected) <= slack, `${actual} ≠ ${expected}`);
// What the transcriber is paid for a recording: Scribe's $0.008 a minute.
const providerCents = (seconds: number) => (seconds / 60) * 0.8;

/** Priced at least at what the transcriber charges for what it hears, which is the copy measured. */
function pricedRight(file: Buffer, m: MeasuredAudio) {
  assert.ok(transcribeCostCents(file.length, billableSeconds(m.length)) >= providerCents(m.length.decoded));
  // The copy plays exactly what was counted, and says so.
  const again = measureAudio(m.file.data)!;
  assert.equal(again.length.decoded, m.length.decoded);
  assert.ok(again.length.declared <= m.length.decoded + 0.001, `${again.length.declared} > ${m.length.decoded}`);
}

test("real recordings: MP3, AAC (raw and in M4A), FLAC and Vorbis, as ffmpeg makes them", () => {
  const kinds = { mp3: "audio/mpeg", aac: "audio/mp4", m4a: "audio/mp4", flac: "audio/flac", ogg: "audio/ogg" } as const;
  for (const [extension, mediaType] of Object.entries(kinds)) {
    const file = fixture(`tone-2s.${extension}`);
    const m = measureAudio(file)!;
    assert.ok(m, extension);
    // Two seconds, and the encoder's padding, which a decoder plays too.
    assert.ok(m.length.decoded >= 2 && m.length.decoded <= 2.15, `${extension}: ${m.length.decoded}`);
    assert.equal(m.file.mediaType, mediaType);
    pricedRight(file, m);
  }
});

test("hours of quiet in a few kilobytes are priced as hours", () => {
  // An hour of AAC frames one byte each (128 ms at 8 kHz), raw and in an M4A file.
  const hour = Array.from({ length: 28_125 }, () => Uint8Array.of(0));
  const raw = adts(hour);
  const packed = m4a(aacConfig(Uint8Array.of(0x15, 0x88))!, hour);
  // An hour of FLAC frames of 8 seconds each, and of Vorbis packets one byte each.
  const quiet = flac(440, { block: 65_535 });
  const vorbis = oggVorbis(Array.from({ length: 7032 }, () => Uint8Array.of(0)));
  for (const file of [raw, packed, quiet, vorbis]) {
    assert.ok(file.length < 250_000, String(file.length));
    const m = measureAudio(file)!;
    assert.ok(m.length.decoded >= 3600 && m.length.decoded < 3610, String(m.length.decoded));
    pricedRight(file, m);
    // Bytes alone would have priced it as a few minutes at most.
    assert.ok(transcribeCostCents(file.length) < providerCents(300));
  }
});

test("lengths that lie: the longer of what plays and what the file says is priced", () => {
  const config = aacConfig(Uint8Array.of(0x15, 0x88))!;
  // An M4A whose track says it lasts a moment, holding an hour.
  const hour = m4a(config, Array.from({ length: 28_125 }, () => Uint8Array.of(0)));
  const mdhd = hour.indexOf("mdhd") + 4;
  hour.writeUInt32BE(8, mdhd + 16);
  near(measureAudio(hour)!.length.decoded, 3600);
  // Two seconds of FLAC claiming an hour, and two of Vorbis whose pages say an hour has played.
  const flacClaims = measureAudio(flac(4, { claimed: 8000 * 3600 }))!;
  near(flacClaims.length.decoded, 2.05, 0.01);
  near(billableSeconds(flacClaims.length), 3600);
  const vorbisClaims = measureAudio(oggVorbis(Array.from({ length: 4 }, () => Uint8Array.of(0)), { granule: 8000 * 3600 }))!;
  near(vorbisClaims.length.decoded, 2.05, 0.01);
  near(billableSeconds(vorbisClaims.length), 3600);
  // The copies sent hold only the sound counted, and say how long it is.
  for (const m of [flacClaims, vorbisClaims]) near(measureAudio(m.file.data)!.length.declared, m.length.decoded, 0.01);
});

test("MP3: junk and tags are skipped, and the Xing frame isn't sound", () => {
  const id3 = Buffer.concat([Buffer.from("ID3\x04\0\0\0\0\0\x0a", "latin1"), Buffer.alloc(10)]);
  const frames = Array.from({ length: 10 }, () => mp3Frame());
  const file = Buffer.concat([id3, Buffer.alloc(100, 0x20), mp3Frame("Xing"), ...frames]);
  const m = measureAudio(file)!;
  near(m.length.decoded, (10 * 1152) / 44100, 0.0001);
  assert.equal(m.length.declared, 0);
  assert.deepEqual(m.file.data, Buffer.concat(frames));
  // Free-format frames (no bitrate in the header) can be any length, so they aren't measured.
  const free = Buffer.concat(Array.from({ length: 10 }, () => mp3Frame()));
  for (let at = 0; at < free.length; at += 417) free[at + 2] &= 0x0f;
  assert.equal(measureAudio(free), null);
});

test("files Flash can't measure aren't transcribed", () => {
  const config = aacConfig(Uint8Array.of(0x15, 0x88))!;
  const frames = Array.from({ length: 20 }, () => Uint8Array.of(1, 2, 3));
  // Opus, or anything but AAC, in an MP4 file.
  const opus = m4a(config, frames);
  opus.write("Opus", opus.indexOf("mp4a"));
  assert.equal(measureAudio(opus), null);
  // Raw AAC with several blocks a frame, or frames of different kinds.
  assert.equal(measureAudio(adts(frames, { blocks: 2 })), null);
  assert.equal(measureAudio(Buffer.concat([adts(frames), adts(frames, { rateIndex: 4 })])), null);
  // More frames than a real recording of a few megabytes holds: forged.
  assert.equal(measureAudio(adts(Array.from({ length: MAX_FRAMES + 1 }, () => Uint8Array.of(0)))), null);
  // Vorbis without its setup header.
  const vorbis = oggVorbis([Uint8Array.of(0)]);
  assert.ok(measureAudio(vorbis));
  const broken = Buffer.from(vorbis);
  broken.write("\x06", broken.indexOf("\x05vorbis", 0, "latin1"), "latin1");
  assert.equal(measureAudio(broken), null);
  // Other kinds of file: AMR, AIFF, Windows Media.
  for (const head of ["#!AMR\n", "FORM\0\0\0\x20AIFF", "\x30\x26\xb2\x75\x8e\x66\xcf\x11"]) {
    assert.equal(measureAudio(Buffer.concat([Buffer.from(head, "latin1"), Buffer.alloc(2000, 0x11)])), null, head);
  }
});

test("a forged MP4 whose fragments list millions of empty samples is turned away quickly", () => {
  const box = (type: string, ...parts: Buffer[]) => {
    const body = Buffer.concat(parts);
    const head = Buffer.alloc(8);
    head.writeUInt32BE(8 + body.length);
    head.write(type, 4, "latin1");
    return Buffer.concat([head, body]);
  };
  const words = (...values: number[]) => Buffer.concat(values.map((v) => Buffer.from([v >>> 24, (v >> 16) & 255, (v >> 8) & 255, v & 255])));
  // Track 1, samples of no size by default, in runs that each claim the most samples a file may hold.
  const moof = box("moof", box("traf", box("tfhd", words(0x020010, 1, 0)), box("trun", words(0, MAX_FRAMES))));
  const file = Buffer.concat([m4a(aacConfig(Uint8Array.of(0x15, 0x88))!, [Uint8Array.of(1, 2, 3)]), ...Array.from({ length: 1000 }, () => moof)]);
  const start = performance.now();
  assert.equal(measureAudio(file), null);
  assert.ok(performance.now() - start < 1000);
});

test("a forged file with millions of empty packets is turned away quickly", () => {
  // WebM blocks of 256 empty laced frames, five bytes each.
  const empty = Array.from({ length: 256 }, () => new Uint8Array());
  const block = webmBlock(1, 0, empty, "fixed");
  const file = webm({ clusters: [{ time: 0, blocks: Array.from({ length: Math.ceil(MAX_PACKETS / 256) + 1 }, () => block) }] });
  const start = performance.now();
  assert.equal(measureAudio(file), null);
  assert.ok(performance.now() - start < 2000);
});
