import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { audioLength, billableSeconds, measureAudio, opusPacketSamples } from "../src/lib/server/audio-length.ts";
import { OPUS_120MS, OPUS_20MS, ebml, hiddenPages, oggOpus, oggPage, opusHead, opusSpeech, opusTags, playedSeconds, wav, webm, webmBlock } from "./audio-files.ts";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
const near = (actual: number, expected: number, slack = 0.15) => assert.ok(Math.abs(actual - expected) <= slack, `${actual} ≠ ${expected}`);

test("an Opus packet's length comes from its first byte (RFC 6716 §3.1)", () => {
  const p = (...bytes: number[]) => opusPacketSamples(Uint8Array.from(bytes));
  // SILK 10, 20, 40 and 60 ms; hybrid 10 and 20 ms; CELT 2.5 to 20 ms.
  assert.deepEqual([0, 1, 2, 3].map((c) => p(c << 3)), [480, 960, 1920, 2880]);
  assert.deepEqual([12, 13].map((c) => p(c << 3)), [480, 960]);
  assert.deepEqual([16, 17, 18, 19].map((c) => p(c << 3)), [120, 240, 480, 960]);
  // Two frames (codes 1 and 2), or as many as the next byte says (code 3).
  assert.equal(p((1 << 3) | 1), 1920);
  assert.equal(p((1 << 3) | 2, 0, 0), 1920);
  assert.equal(p((16 << 3) | 3, 6), 720);
  // Never more than 120 ms, and a packet that's empty or claims no frames counts as the most it could fill.
  assert.equal(p((3 << 3) | 3, 63), 5760);
  assert.equal(p((3 << 3) | 3, 0), 5760);
  assert.equal(opusPacketSamples(new Uint8Array()), 5760);
});

test("real recordings: Opus in Ogg and in WebM, as ffmpeg makes them", () => {
  // Two minutes of quiet at 6 kbps in 120 ms frames: 28 KB, which bytes alone would price as 28 seconds.
  const quiet = fixture("quiet-2min.ogg");
  assert.ok(quiet.length < 30_000);
  const ogg = audioLength(quiet)!;
  near(ogg.decoded, 120);
  near(ogg.declared, 120);
  const tone = audioLength(fixture("tone-3s.webm"))!;
  near(tone.decoded, 3);
  near(tone.declared, 3);
});

test("a forged Ogg file is priced on the longer of what it plays and what it claims", () => {
  // An hour of one-byte 120 ms packets in about 60 KB, with every page claiming no time at all.
  const hour = oggOpus(Array.from({ length: 30_000 }, () => Uint8Array.of(OPUS_120MS)), { granule: () => 0 });
  assert.ok(hour.length < 70_000, String(hour.length));
  const length = audioLength(hour)!;
  near(length.decoded, 3600);
  assert.equal(length.declared, 0);
  assert.ok(billableSeconds(length) >= 3600);
  // Two seconds of sound that say they last an hour.
  const claims = audioLength(oggOpus(opusSpeech(2), { granule: () => 48000 * 3600 + 312 }))!;
  near(claims.decoded, 2);
  near(claims.declared, 3600);
  // Truthful files agree with themselves.
  const honest = audioLength(oggOpus(opusSpeech(5)))!;
  near(honest.decoded, 5);
  near(honest.declared, 5);
});

test("Ogg: packets across pages count once, empty ones as the most a decoder could fill", () => {
  const head = [oggPage({ packets: [opusHead()], flags: 2 }), oggPage({ packets: [opusTags()] }, 1)];
  // A 510-byte packet that starts on one page and ends on the next, then a 20 ms one.
  const long = new Uint8Array(510).fill(7);
  long[0] = OPUS_20MS;
  const split = Buffer.concat([...head, oggPage({ packets: [long.subarray(0, 255)], open: true }, 2), oggPage({ packets: [long.subarray(255), Uint8Array.of(OPUS_20MS)], flags: 1 }, 3)]);
  near(audioLength(split)!.decoded, 0.04, 0.001);
  const empty = Buffer.concat([...head, oggPage({ packets: [new Uint8Array(), new Uint8Array()] }, 2)]);
  near(audioLength(empty)!.decoded, 0.24, 0.001);
});

test("Ogg that Flash can't measure: other codecs, streams that never opened, junk", () => {
  const vorbis = Buffer.concat([oggPage({ packets: [Buffer.from("\x01vorbis\0\0\0\0\x01")], flags: 2 })]);
  assert.equal(audioLength(vorbis), null);
  assert.equal(audioLength(oggPage({ packets: [Buffer.from("Speex   ")], flags: 2 })), null);
  // A second stream whose first page is missing.
  assert.equal(audioLength(Buffer.concat([oggOpus(opusSpeech(1)), oggPage({ packets: [Uint8Array.of(OPUS_120MS)], serial: 9 })])), null);
  assert.equal(audioLength(Buffer.concat([Buffer.from("OggS"), Buffer.alloc(200, 0x41)])), null, "no Opus at all");
  // A video's picture stream is left out; its sound is counted.
  const theora = oggPage({ packets: [Buffer.from("\x80theora", "latin1")], serial: 2, flags: 2 });
  near(audioLength(Buffer.concat([theora, oggOpus(opusSpeech(3))]))!.decoded, 3);
});

test("WebM: Chrome's unknown sizes, laced frames, and times that lie", () => {
  const frame = Uint8Array.of(OPUS_20MS, 1, 2);
  const blocks = Array.from({ length: 50 }, (_, i) => webmBlock(1, i * 20, [frame]));
  const second = audioLength(webm({ clusters: [{ time: 0, blocks }] }))!;
  near(second.decoded, 1, 0.001);
  near(second.declared, 1, 0.001);
  // Three frames in a block, laced each way.
  for (const lacing of ["xiph", "fixed", "ebml"] as const) {
    const frames = lacing === "fixed" ? [frame, frame, frame] : [frame, Uint8Array.of(OPUS_120MS), Uint8Array.of(OPUS_20MS, 9, 9, 9, 9)];
    const want = lacing === "fixed" ? 0.06 : 0.16;
    near(audioLength(webm({ clusters: [{ time: 0, blocks: [webmBlock(1, 0, frames, lacing)] }] }))!.decoded, want, 0.001);
  }
  // A cluster an hour later, or a duration of an hour: priced as an hour.
  near(audioLength(webm({ clusters: [{ time: 0, blocks }, { time: 3_600_000, blocks: [webmBlock(1, 0, [frame])] }] }))!.declared, 3600, 1);
  const duration = Buffer.alloc(8);
  duration.writeDoubleBE(3_600_000);
  near(audioLength(webm({ clusters: [{ time: 0, blocks }], info: [ebml(0x4489, duration)] }))!.declared, 3600);
  // Blocks for a track that isn't described aren't played; a picture track is left out.
  const video = ebml(0xae, [ebml(0xd7, 2), ebml(0x83, 1), ebml(0x86, "V_VP8")]);
  const mixed = audioLength(webm({ clusters: [{ time: 0, blocks: [...blocks, webmBlock(2, 0, [frame]), webmBlock(5, 0, [frame])] }], extraTracks: [video] }))!;
  near(mixed.decoded, 1, 0.001);
});

test("WebM Flash can't measure: other codecs, compressed frames", () => {
  const blocks = [webmBlock(1, 0, [Uint8Array.of(OPUS_20MS)])];
  assert.equal(audioLength(webm({ clusters: [{ time: 0, blocks }], codec: "A_VORBIS" })), null);
  assert.equal(audioLength(webm({ clusters: [{ time: 0, blocks }], encoded: true })), null);
  assert.equal(audioLength(webm({ clusters: [{ time: 0, blocks }], codec: "V_VP8" })), null, "no sound at all");
});

test("WAV is measured from the samples there, whatever the header claims", () => {
  near(audioLength(wav({ data: Buffer.alloc(16_000) }))!.decoded, 1, 0.001);
  // 8-bit samples a hundred times a second: 10 KB plays for 100 seconds.
  const slow = audioLength(wav({ rate: 100, bits: 8, data: Buffer.alloc(10_000) }))!;
  near(slow.decoded, 100, 0.001);
  // A data size of "unknown", or one that claims more than is there.
  assert.deepEqual(audioLength(wav({ data: Buffer.alloc(16_000), dataSize: 0xffffffff })), { decoded: 1, declared: 0 });
  near(audioLength(wav({ data: Buffer.alloc(16_000), dataSize: 16_000 * 3600 }))!.declared, 3600);
  // Compressed samples (here IMA ADPCM) can't be measured from the header.
  assert.equal(audioLength(wav({ tag: 0x11, bits: 4, data: Buffer.alloc(1000) })), null);
});

test("anything else isn't measured", () => {
  for (const bytes of [Buffer.from("ID3\x04\0\0\0\0\0\0"), Buffer.from("hello"), Buffer.alloc(0), Buffer.from("\0\0\0\x20ftypM4A ")]) {
    assert.equal(audioLength(bytes), null);
  }
});

test("what's sent on is a clean copy of exactly the sound measured", () => {
  // Pages hidden inside pages with broken checksums: a player that checks checksums hears twenty
  // minutes, while the pages a player that doesn't check would read hold a moment of sound.
  const hidden = hiddenPages(20);
  assert.ok(hidden.length < 60_000, String(hidden.length));
  assert.ok(playedSeconds(hidden) >= 1200, String(playedSeconds(hidden)));
  const forged = measureAudio(hidden)!;
  assert.ok(billableSeconds(forged.length) < 1);
  // The copy sent holds only what was priced, for either kind of player.
  assert.equal(forged.file.mediaType, "audio/ogg");
  assert.ok(playedSeconds(forged.file.data) <= forged.length.decoded);
  assert.equal(measureAudio(forged.file.data)!.length.decoded, forged.length.decoded);
  // Real recordings come through whole: the copy plays as long, and its pages say so.
  for (const name of ["quiet-2min.ogg", "tone-3s.webm"]) {
    const m = measureAudio(fixture(name))!;
    assert.equal(m.file.mediaType, "audio/ogg", name);
    const copy = measureAudio(m.file.data)!;
    assert.equal(copy.length.decoded, m.length.decoded, name);
    near(copy.length.declared, m.length.decoded, 0.03);
    near(playedSeconds(m.file.data), m.length.decoded, 0.001);
  }
  // A packet bigger than a page goes on across pages, and a second stream follows the first.
  const big = new Uint8Array(70_002);
  big[0] = (1 << 3) | 3;
  big[1] = 3;
  const across = Buffer.concat([
    oggPage({ packets: [opusHead()], flags: 2 }),
    oggPage({ packets: [opusTags()] }, 1),
    oggPage({ packets: [big.subarray(0, 255 * 255)], open: true }, 2),
    oggPage({ packets: [big.subarray(255 * 255), ...opusSpeech(1)], flags: 1 | 4 }, 3),
  ]);
  const two = measureAudio(Buffer.concat([across, oggOpus(opusSpeech(2), { serial: 7 })]))!;
  near(two.length.decoded, 3.06, 0.001);
  near(playedSeconds(two.file.data), 3.06, 0.001);
  assert.equal(measureAudio(two.file.data)!.length.decoded, two.length.decoded);
  // WAV: the samples the header says it holds, in a plain header.
  const sound = Buffer.alloc(16_000, 1);
  const w = measureAudio(Buffer.concat([wav({ data: sound }), Buffer.from("LIST\x04\0\0\0junk")]))!;
  assert.equal(w.file.mediaType, "audio/wav");
  assert.deepEqual(w.file.data.subarray(44), sound);
  assert.deepEqual(measureAudio(w.file.data)!.length, { decoded: 1, declared: 1 });
});
