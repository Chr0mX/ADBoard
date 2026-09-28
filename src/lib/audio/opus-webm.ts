/** OpusHead identification header (RFC 7845) used when scrcpy has not sent one yet. */
export function defaultOpusHead(channels = 2, sampleRate = 48000): Uint8Array {
  const head = new Uint8Array(19);
  const magic = new TextEncoder().encode("OpusHead");
  head.set(magic, 0);
  head[8] = 1;
  head[9] = channels;
  head[12] = sampleRate & 0xff;
  head[13] = (sampleRate >> 8) & 0xff;
  head[14] = (sampleRate >> 16) & 0xff;
  head[15] = (sampleRate >> 24) & 0xff;
  return head;
}

export function readOpusHead(description: Uint8Array): {
  channels: number;
  sampleRate: number;
} {
  const magic = description.length >= 8 ? String.fromCharCode(...description.subarray(0, 8)) : "";
  if (magic === "OpusHead" && description.length >= 16) {
    const channels = description[9] || 2;
    const sampleRate =
      description[12] |
      (description[13] << 8) |
      (description[14] << 16) |
      (description[15] << 24);
    return { channels, sampleRate: sampleRate || 48000 };
  }
  return { channels: 2, sampleRate: 48000 };
}

function concat(parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(len);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function vint(value: number): Uint8Array {
  if (value < 0x7f) return Uint8Array.of(0x80 | value);
  if (value < 0x3fff) return Uint8Array.of(0x40 | (value >> 8), value & 0xff);
  if (value < 0x1f_ffff) {
    return Uint8Array.of(0x20 | (value >> 16), (value >> 8) & 0xff, value & 0xff);
  }
  return Uint8Array.of(
    0x10 | ((value >>> 24) & 0x0f),
    (value >> 16) & 0xff,
    (value >> 8) & 0xff,
    value & 0xff,
  );
}

function element(id: number[], data: Uint8Array): Uint8Array {
  return concat([Uint8Array.from(id), vint(data.length), data]);
}

function uintEl(id: number[], value: number): Uint8Array {
  const bytes: number[] = [];
  let rest = value >>> 0;
  do {
    bytes.push(rest & 0xff);
    rest = Math.floor(rest / 256);
  } while (rest > 0);
  bytes.reverse();
  return element(id, Uint8Array.from(bytes));
}

function stringEl(id: number[], value: string): Uint8Array {
  return element(id, new TextEncoder().encode(value));
}

function floatEl(id: number[], value: number): Uint8Array {
  const buf = new ArrayBuffer(8);
  new DataView(buf).setFloat64(0, value, false);
  return element(id, new Uint8Array(buf));
}

/** EBML + Segment(Info, Tracks). Later clusters are appended as Segment children. */
export function webmInit(
  description: Uint8Array,
  sampleRate: number,
  channels: number,
): Uint8Array {
  const head = description[0] === 0x4f ? description : defaultOpusHead(channels, sampleRate);
  const ebml = element(
    [0x1a, 0x45, 0xdf, 0xa3],
    concat([
      uintEl([0x42, 0x86], 1),
      uintEl([0x42, 0xf7], 1),
      uintEl([0x42, 0xf2], 4),
      uintEl([0x42, 0xf3], 8),
      stringEl([0x42, 0x82], "webm"),
      uintEl([0x42, 0x87], 4),
      uintEl([0x42, 0x85], 2),
    ]),
  );
  const info = element(
    [0x15, 0x49, 0xa9, 0x66],
    concat([
      uintEl([0x2a, 0xd7, 0xb1], 1_000_000),
      stringEl([0x4d, 0x80], "phonecontrol"),
      stringEl([0x57, 0x41], "phonecontrol"),
    ]),
  );
  const track = element(
    [0xae],
    concat([
      uintEl([0xd7], 1),
      uintEl([0x73, 0xc5], 1),
      uintEl([0x83], 2),
      stringEl([0x86], "A_OPUS"),
      element([0x63, 0xa2], head),
      element(
        [0xe1],
        concat([floatEl([0xb5], sampleRate), uintEl([0x9f], channels)]),
      ),
    ]),
  );
  const tracks = element([0x16, 0x54, 0xae, 0x6b], track);
  const segmentBody = concat([info, tracks]);
  const unknown = Uint8Array.of(0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff);
  const segment = concat([Uint8Array.of(0x18, 0x53, 0x80, 0x67), unknown, segmentBody]);
  return concat([ebml, segment]);
}

/** One WebM cluster holding a single Opus packet. Timestamps are in microseconds. */
export function webmCluster(packet: Uint8Array, timestampUs: number): Uint8Array {
  const ms = Math.max(0, Math.min(0xff_ff_ff_ff, Math.round(timestampUs / 1000)));
  const block = new Uint8Array(4 + packet.length);
  block[0] = 0x81;
  block[3] = 0x80;
  block.set(packet, 4);
  return element(
    [0x1f, 0x43, 0xb6, 0x75],
    concat([uintEl([0xe7], ms), element([0xa3], block)]),
  );
}
