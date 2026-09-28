import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultOpusHead, webmCluster, webmInit } from "./opus-webm.ts";

const head = defaultOpusHead(2, 48000);
assert.equal(String.fromCharCode(...head.subarray(0, 8)), "OpusHead");

const init = webmInit(head, 48000, 2);
const cluster = webmCluster(Uint8Array.of(0xf8, 0xff, 0xfe), 0);
const webm = new Uint8Array(init.length + cluster.length);
webm.set(init, 0);
webm.set(cluster, init.length);
const text = Buffer.from(webm).toString("latin1");
assert.ok(text.includes("A_OPUS"), "track codec id");
assert.ok(text.includes("OpusHead"), "codec private");

const dir = mkdtempSync(join(tmpdir(), "pc-opus-"));
const file = join(dir, "sample.webm");
writeFileSync(file, webm);
const probe = spawnSync(
  "ffprobe",
  ["-v", "error", "-show_entries", "stream=codec_name,codec_type", "-of", "csv=p=0", file],
  { encoding: "utf8" },
);
assert.equal(probe.status, 0, probe.stderr);
assert.match(probe.stdout, /opus/, probe.stdout + probe.stderr);
console.log("opus webm ok", probe.stdout.trim());
