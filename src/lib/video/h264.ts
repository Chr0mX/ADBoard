/**
 * Annex-B H264 helpers for WebCodecs (AVCC + avcC description).
 */

export interface ParsedNal {
  type: number;
  data: Uint8Array; // including 1-byte header
}

export function splitAnnexBNals(data: Uint8Array): ParsedNal[] {
  const starts: number[] = [];
  let i = 0;
  while (i + 3 < data.length) {
    if (data[i] === 0 && data[i + 1] === 0) {
      if (data[i + 2] === 1) {
        starts.push(i);
        i += 3;
        continue;
      }
      if (i + 3 < data.length && data[i + 2] === 0 && data[i + 3] === 1) {
        starts.push(i);
        i += 4;
        continue;
      }
    }
    i += 1;
  }

  const out: ParsedNal[] = [];
  for (let s = 0; s < starts.length; s++) {
    const start = starts[s];
    const scLen =
      start + 3 < data.length &&
      data[start] === 0 &&
      data[start + 1] === 0 &&
      data[start + 2] === 0 &&
      data[start + 3] === 1
        ? 4
        : 3;
    const payloadStart = start + scLen;
    const payloadEnd = s + 1 < starts.length ? starts[s + 1] : data.length;
    if (payloadStart >= payloadEnd) continue;
    const nal = data.subarray(payloadStart, payloadEnd);
    out.push({ type: nal[0] & 0x1f, data: nal });
  }
  return out;
}

export function annexBHasVcl(data: Uint8Array): boolean {
  return splitAnnexBNals(data).some((n) => n.type === 1 || n.type === 5);
}

export function annexBIsIdr(data: Uint8Array): boolean {
  return splitAnnexBNals(data).some((n) => n.type === 5);
}

/** Build AVCDecoderConfigurationRecord from SPS + PPS NAL payloads. */
export function buildAvcDecoderConfig(
  sps: Uint8Array,
  pps: Uint8Array,
): Uint8Array {
  const profileIndication = sps[1];
  const profileCompatibility = sps[2];
  const levelIndication = sps[3];
  const out = new Uint8Array(11 + sps.length + pps.length);
  let o = 0;
  out[o++] = 1; // configurationVersion
  out[o++] = profileIndication;
  out[o++] = profileCompatibility;
  out[o++] = levelIndication;
  out[o++] = 0xff; // 4 bytes NAL length size minus one → 3 → 4-byte lengths
  out[o++] = 0xe1; // one SPS
  out[o++] = (sps.length >> 8) & 0xff;
  out[o++] = sps.length & 0xff;
  out.set(sps, o);
  o += sps.length;
  out[o++] = 1; // one PPS
  out[o++] = (pps.length >> 8) & 0xff;
  out[o++] = pps.length & 0xff;
  out.set(pps, o);
  return out;
}

/** Codec string like avc1.42E01E from SPS bytes. */
export function codecStringFromSps(sps: Uint8Array): string {
  const profile = sps[1].toString(16).padStart(2, "0");
  const compat = sps[2].toString(16).padStart(2, "0");
  const level = sps[3].toString(16).padStart(2, "0");
  return `avc1.${profile}${compat}${level}`.toUpperCase().replace("AVC1.", "avc1.");
}

/** Convert Annex-B AU → AVCC (length-prefixed VCL + SEI; SPS/PPS omitted). */
export function annexBToAvcc(data: Uint8Array): Uint8Array {
  const nals = splitAnnexBNals(data).filter(
    (n) => n.type !== 7 && n.type !== 8 && n.type !== 9,
  );
  let size = 0;
  for (const n of nals) size += 4 + n.data.length;
  const out = new Uint8Array(size);
  let o = 0;
  for (const n of nals) {
    const len = n.data.length;
    out[o++] = (len >>> 24) & 0xff;
    out[o++] = (len >>> 16) & 0xff;
    out[o++] = (len >>> 8) & 0xff;
    out[o++] = len & 0xff;
    out.set(n.data, o);
    o += len;
  }
  return out;
}

export function extractSpsPps(
  data: Uint8Array,
): { sps: Uint8Array; pps: Uint8Array } | null {
  const nals = splitAnnexBNals(data);
  const sps = nals.find((n) => n.type === 7)?.data;
  const pps = nals.find((n) => n.type === 8)?.data;
  if (!sps || !pps) return null;
  return { sps, pps };
}
