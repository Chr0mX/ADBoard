import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spsDimensions } from "./h264.ts";

function annexBSps(bytes) {
  const starts = [];
  let i = 0;
  while (i + 3 < bytes.length) {
    if (bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 1) {
      starts.push(i);
      i += 3;
      continue;
    }
    if (
      bytes[i] === 0 &&
      bytes[i + 1] === 0 &&
      bytes[i + 2] === 0 &&
      bytes[i + 3] === 1
    ) {
      starts.push(i);
      i += 4;
      continue;
    }
    i += 1;
  }
  const start = starts[0];
  const sc = bytes[start + 2] === 1 ? 3 : 4;
  return bytes.subarray(start + sc, starts[1]);
}

const fixture = readFileSync(
  new URL("../../../crates/adboard-agent/fixtures/testpattern.h264", import.meta.url),
);
assert.deepEqual(spsDimensions(annexBSps(fixture)), { width: 360, height: 640 });

// libx264 high profile, 1080×2400. Coded 1088×2400, crop_right = 4.
// 4:2:0 crop units remove 8 pixels. Displayed size is 1080×2400, not 1088.
const xiaomi = Uint8Array.from(
  Buffer.from("67640032acd94044012de5f011000003000100000300320f183196", "hex"),
);
assert.deepEqual(spsDimensions(xiaomi), { width: 1080, height: 2400 });

assert.equal(spsDimensions(Uint8Array.of(0x67, 0x42)), null);

console.log("sps crop ok");
