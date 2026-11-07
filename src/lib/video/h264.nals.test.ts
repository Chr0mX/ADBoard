import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { annexBHasVcl, annexBIsIdr, annexBToAvcc, extractSpsPps, splitAnnexBNals, type ParsedNal } from "./h264.ts";

/** The splitter as it was before the skip-ahead change, kept as the reference. */
function referenceSplit(data: Uint8Array): ParsedNal[] {
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
      start + 3 < data.length && data[start] === 0 && data[start + 1] === 0 && data[start + 2] === 0 && data[start + 3] === 1 ? 4 : 3;
    const payloadStart = start + scLen;
    const payloadEnd = s + 1 < starts.length ? starts[s + 1] : data.length;
    if (payloadStart >= payloadEnd) continue;
    const nal = data.subarray(payloadStart, payloadEnd);
    out.push({ type: nal[0] & 0x1f, data: nal });
  }
  return out;
}

function lcg(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const same = (a: ParsedNal[], b: ParsedNal[]) =>
  a.length === b.length && a.every((n, i) => n.type === b[i].type && Buffer.compare(n.data, b[i].data) === 0);

describe("splitAnnexBNals", () => {
  it("finds the same NAL units as the reference on random data full of 0 and 1 bytes", () => {
    const rand = lcg(7);
    for (let round = 0; round < 3000; round++) {
      const len = Math.floor(rand() * 40);
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        const r = rand();
        bytes[i] = r < 0.45 ? 0 : r < 0.7 ? 1 : Math.floor(rand() * 256);
      }
      assert.ok(same(splitAnnexBNals(bytes), referenceSplit(bytes)), `mismatch on ${Array.from(bytes).join(",")}`);
    }
  });

  it("handles 3-byte and 4-byte start codes, empty input and a trailing start code", () => {
    const frame = Uint8Array.from([0, 0, 0, 1, 0x67, 1, 2, 0, 0, 1, 0x68, 3, 0, 0, 0, 1, 0x65, 9, 9]);
    assert.deepEqual(splitAnnexBNals(frame).map((n) => n.type), [7, 8, 5]);
    assert.deepEqual(splitAnnexBNals(new Uint8Array(0)), []);
    assert.deepEqual(splitAnnexBNals(Uint8Array.from([0, 0, 1])), []);
    assert.ok(same(splitAnnexBNals(frame), referenceSplit(frame)));
  });

  it("gives the same answers for a raw frame and for the same frame split once", () => {
    const frame = Uint8Array.from([0, 0, 0, 1, 0x67, 0x42, 0xe0, 0x1e, 0, 0, 1, 0x68, 0xce, 0, 0, 0, 1, 0x65, 9, 9, 9]);
    const nals = splitAnnexBNals(frame);
    assert.equal(annexBHasVcl(frame), annexBHasVcl(nals));
    assert.equal(annexBIsIdr(frame), annexBIsIdr(nals));
    assert.deepEqual(annexBToAvcc(frame), annexBToAvcc(nals));
    assert.deepEqual(extractSpsPps(frame), extractSpsPps(nals));
    assert.equal(annexBIsIdr(frame), true);
    const delta = Uint8Array.from([0, 0, 0, 1, 0x41, 1, 2, 3]);
    assert.equal(annexBHasVcl(splitAnnexBNals(delta)), true);
    assert.equal(annexBIsIdr(splitAnnexBNals(delta)), false);
  });
});
