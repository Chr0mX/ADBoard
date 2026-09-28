/**
 * One-track fragmented MP4 so Chrome can play Annex-B H264 through MediaSource.
 * MediaSource works on http://192.168.x.x; WebCodecs does not.
 */

import { buildAvcDecoderConfig } from "./h264";

const TIMESCALE = 1000;
const SAMPLE_DURATION = 33;

function concat(parts: Uint8Array[]): Uint8Array {
  let size = 0;
  for (const part of parts) size += part.length;
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function u8(n: number): Uint8Array {
  return Uint8Array.of(n & 0xff);
}

function u16(n: number): Uint8Array {
  return Uint8Array.of((n >> 8) & 0xff, n & 0xff);
}

function u32(n: number): Uint8Array {
  return Uint8Array.of((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
}

function u64(n: number): Uint8Array {
  const hi = Math.floor(n / 0x100000000);
  const lo = n >>> 0;
  return concat([u32(hi), u32(lo)]);
}

function str(value: string): Uint8Array {
  return Uint8Array.from(value, (ch) => ch.charCodeAt(0));
}

function box(type: string, payload: Uint8Array): Uint8Array {
  return concat([u32(8 + payload.length), str(type), payload]);
}

function fullbox(type: string, version: number, flags: number, payload: Uint8Array): Uint8Array {
  return box(type, concat([u32((version << 24) | flags), payload]));
}

function zeros(n: number): Uint8Array {
  return new Uint8Array(n);
}

/** ftyp + moov for a live AVC stream. Duration stays 0; samples arrive as moof/mdat. */
export function createInitSegment(
  sps: Uint8Array,
  pps: Uint8Array,
  width: number,
  height: number,
): Uint8Array {
  const avcC = buildAvcDecoderConfig(sps, pps);
  const ftyp = box("ftyp", concat([str("isom"), u32(0), str("isom"), str("iso6"), str("mp41")]));

  const mvhd = fullbox(
    "mvhd",
    0,
    0,
    concat([
      u32(0),
      u32(0),
      u32(TIMESCALE),
      u32(0),
      u32(0x00010000),
      u16(0x0100),
      u16(0),
      zeros(8),
      u32(0x00010000),
      u32(0),
      u32(0),
      u32(0),
      u32(0x00010000),
      u32(0),
      u32(0),
      u32(0),
      u32(0x40000000),
      zeros(24),
      u32(2),
    ]),
  );

  const tkhd = fullbox(
    "tkhd",
    0,
    0x7,
    concat([
      u32(0),
      u32(0),
      u32(1),
      u32(0),
      u32(0),
      zeros(8),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0x00010000),
      u32(0),
      u32(0),
      u32(0),
      u32(0x00010000),
      u32(0),
      u32(0),
      u32(0),
      u32(0x40000000),
      u32(width << 16),
      u32(height << 16),
    ]),
  );

  const mdhd = fullbox(
    "mdhd",
    0,
    0,
    concat([u32(0), u32(0), u32(TIMESCALE), u32(0), u16(0x55c4), u16(0)]),
  );
  const hdlr = fullbox(
    "hdlr",
    0,
    0,
    concat([u32(0), str("vide"), zeros(12), str("VideoHandler"), u8(0)]),
  );
  const vmhd = fullbox("vmhd", 0, 1, concat([u16(0), u16(0), u16(0), u16(0)]));
  const dref = box("dinf", fullbox("dref", 0, 0, concat([u32(1), fullbox("url ", 0, 1, new Uint8Array())])));
  const avc1 = box(
    "avc1",
    concat([
      zeros(6),
      u16(1),
      u16(0),
      u16(0),
      zeros(12),
      u16(width),
      u16(height),
      u32(0x00480000),
      u32(0x00480000),
      u32(0),
      u16(1),
      zeros(32),
      u16(0x0018),
      u16(0xffff),
      box("avcC", avcC),
    ]),
  );
  const stsd = fullbox("stsd", 0, 0, concat([u32(1), avc1]));
  const stts = fullbox("stts", 0, 0, u32(0));
  const stsc = fullbox("stsc", 0, 0, u32(0));
  const stsz = fullbox("stsz", 0, 0, concat([u32(0), u32(0)]));
  const stco = fullbox("stco", 0, 0, u32(0));
  const stbl = box("stbl", concat([stsd, stts, stsc, stsz, stco]));
  const minf = box("minf", concat([vmhd, dref, stbl]));
  const mdia = box("mdia", concat([mdhd, hdlr, minf]));
  const trak = box("trak", concat([tkhd, mdia]));
  const trex = fullbox("trex", 0, 0, concat([u32(1), u32(1), u32(SAMPLE_DURATION), u32(0), u32(0)]));
  const moov = box("moov", concat([mvhd, trak, box("mvex", trex)]));
  return concat([ftyp, moov]);
}

export function createMediaSegment(
  sample: Uint8Array,
  sequence: number,
  decodeTime: number,
  keyframe: boolean,
  duration = SAMPLE_DURATION,
): Uint8Array {
  const tfhd = fullbox("tfhd", 0, 0x020000, u32(1));
  const tfdt = fullbox("tfdt", 1, 0, u64(decodeTime));
  const sampleFlags = keyframe ? 0x02000000 : 0x01010000;
  const trun = fullbox(
    "trun",
    0,
    0x000001 | 0x000100 | 0x000200 | 0x000400,
    concat([u32(1), u32(0), u32(duration), u32(sample.length), u32(sampleFlags)]),
  );
  const traf = box("traf", concat([tfhd, tfdt, trun]));
  const mfhd = fullbox("mfhd", 0, 0, u32(sequence));
  const moof = box("moof", concat([mfhd, traf]));
  // trun is the last box. Payload order ends with data_offset, duration, size, flags.
  const patched = new Uint8Array(moof);
  new DataView(patched.buffer).setUint32(patched.length - 16, patched.length + 8);
  return concat([patched, box("mdat", sample)]);
}
