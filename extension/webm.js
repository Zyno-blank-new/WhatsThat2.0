const EBML = 0x1a45dfa3;
const SEGMENT = 0x18538067;
const INFO = 0x1549a966;
const TRACKS = 0x1654ae6b;
const TRACK_ENTRY = 0xae;
const TRACK_NUMBER = 0xd7;
const TRACK_TYPE = 0x83;
const CLUSTER = 0x1f43b675;
const TIMESTAMP = 0xe7;
const SCALE = 0x2ad7b1;
const DURATION = 0x4489;
const SIMPLE_BLOCK = 0xa3;
const BLOCK_GROUP = 0xa0;
const BLOCK = 0xa1;
const REFERENCE_BLOCK = 0xfb;
const CLUSTER_SIBLINGS = new Set([CLUSTER, INFO, TRACKS, 0x114d9b74, 0x1c53bb6b, 0x1254c367, 0x1941a469, 0x1043a770]);

function variableInt(bytes, offset, keepMarker = false) {
  const first = bytes[offset];
  if (first === undefined) return null;
  if (!first) throw new Error("Invalid WebM element");
  let marker = 0x80;
  let width = 1;
  while (!(first & marker)) {
    marker >>= 1;
    width++;
  }
  if (offset + width > bytes.length) return null;
  let value = keepMarker ? first : first & (marker - 1);
  let unknown = !keepMarker && value === marker - 1;
  for (let i = 1; i < width; i++) {
    value = value * 256 + bytes[offset + i];
    unknown &&= bytes[offset + i] === 0xff;
  }
  return { width, value: unknown ? Infinity : value };
}

function readElement(bytes, offset) {
  const id = variableInt(bytes, offset, true);
  if (!id) return null;
  const size = variableInt(bytes, offset + id.width);
  if (!size) return null;
  const start = offset + id.width + size.width;
  return { id: id.value, start, end: start + size.value };
}

function unsigned(bytes) {
  return bytes.reduce((value, byte) => value * 256 + byte, 0);
}

function join(parts) {
  const all = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    all.set(part, offset);
    offset += part.length;
  }
  return all;
}

function numberBytes(number, min = 1) {
  const bytes = [];
  do {
    bytes.unshift(number % 256);
    number = Math.floor(number / 256);
  } while (number || bytes.length < min);
  return Uint8Array.from(bytes);
}

function element(id, payload) {
  let width = 1;
  while (payload.length >= 2 ** (width * 7) - 1) width++;
  const size = numberBytes(payload.length + 2 ** (width * 7), width);
  return join([numberBytes(id), size, payload]);
}

function children(bytes) {
  const items = [];
  for (let offset = 0; offset < bytes.length;) {
    const item = readElement(bytes, offset);
    if (!item || item.end > bytes.length) throw new Error("Incomplete WebM metadata");
    items.push({ ...item, offset, payload: bytes.subarray(item.start, item.end) });
    offset = item.end;
  }
  return items;
}

/**
 * Chrome's MediaRecorder exposes pieces of a single live WebM. A timeslice
 * alone can start mid-cluster or mid-GOP. Keep the original track metadata,
 * then write a new cluster beginning at the first retained video keyframe.
 */
export class WebmLookback {
  constructor(windowMs = 10_000) {
    this.windowMs = windowMs;
    this.pending = new Uint8Array();
    this.blocks = [];
    this.clusterTime = 0;
    this.clusterEnd = null;
    this.scale = 1_000_000;
    this.latest = 0;
  }

  append(input) {
    const bytes = join([this.pending, input]);
    let offset = 0;
    while (offset < bytes.length) {
      const item = readElement(bytes, offset);
      if (!item) break;
      if (item.id === SEGMENT) {
        offset = item.start;
        continue;
      }

      if (this.clusterEnd !== null && CLUSTER_SIBLINGS.has(item.id)) this.clusterEnd = null;
      if (item.id === CLUSTER) {
        this.clusterEnd = item.end;
        this.clusterTime = 0;
        offset = item.start;
        continue;
      }
      if (item.end > bytes.length) break;
      const payload = bytes.subarray(item.start, item.end);
      if (item.id === EBML) this.header = bytes.slice(offset, item.end);
      if (item.id === INFO) {
        this.info = payload.slice();
        const scale = children(this.info).find((entry) => entry.id === SCALE);
        if (scale) this.scale = unsigned(scale.payload);
      }
      if (item.id === TRACKS) {
        this.tracks = bytes.slice(offset, item.end);
        for (const track of children(payload).filter((entry) => entry.id === TRACK_ENTRY)) {
          const properties = children(track.payload);
          const type = properties.find((entry) => entry.id === TRACK_TYPE);
          const number = properties.find((entry) => entry.id === TRACK_NUMBER);
          if (type && number && unsigned(type.payload) === 1) this.videoTrack = unsigned(number.payload);
        }
      }
      if (this.clusterEnd !== null) {
        if (item.id === TIMESTAMP) this.clusterTime = unsigned(payload);
        if (item.id === SIMPLE_BLOCK || item.id === BLOCK_GROUP) this.addBlock(item.id, payload);
        if (item.end >= this.clusterEnd) this.clusterEnd = null;
      }
      offset = item.end;
    }
    if (Number.isFinite(this.clusterEnd)) this.clusterEnd -= offset;
    this.pending = bytes.slice(offset);
    const oldest = this.latest - this.ticks(this.windowMs);
    const keep = this.blocks.findIndex((block) => block.time >= oldest);
    if (keep > 0) this.blocks.splice(0, keep);
  }

  ticks(ms) {
    return Math.floor(ms * 1_000_000 / this.scale);
  }

  addBlock(id, payload) {
    const group = id === BLOCK_GROUP ? children(payload) : null;
    const block = group?.find((entry) => entry.id === BLOCK);
    if (group && !block) return;
    const start = block?.start ?? 0;
    const track = variableInt(payload, start);
    if (!track || start + track.width + 3 > payload.length) return;
    const timestampOffset = start + track.width;
    const data = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    const time = this.clusterTime + data.getInt16(timestampOffset);
    const isKeyframe = group ? !group.some((entry) => entry.id === REFERENCE_BLOCK) : Boolean(payload[timestampOffset + 2] & 0x80);
    const isVideo = track.value === this.videoTrack;
    this.blocks.push({ id, payload: payload.slice(), time, timestampOffset, isVideo, isKeyframe });
    this.latest = Math.max(time, this.latest);
  }

  clip(windowMs = this.windowMs) {
    if (!this.header || !this.info || !this.tracks) return null;
    const oldest = this.latest - this.ticks(Math.min(windowMs, this.windowMs));
    const start = this.blocks.find((block) => block.time >= oldest && block.isVideo && block.isKeyframe);
    if (!start) return null;
    const duration = this.latest - start.time;
    if (duration <= 0) return null;
    const durationData = new Uint8Array(8);
    new DataView(durationData.buffer).setFloat64(0, duration);
    const info = children(this.info)
      .filter((item) => item.id !== DURATION)
      .map((item) => this.info.subarray(item.offset, item.end));
    info.push(element(DURATION, durationData));
    const blocks = [element(TIMESTAMP, Uint8Array.of(0))];

    // Audio and video blocks can arrive slightly out of order at a cluster boundary.
    let startedVideo = false;
    for (const block of this.blocks) {
      if (block.time < start.time) continue;
      if (block === start) startedVideo = true;
      if (block.isVideo && !startedVideo) continue;
      const payload = block.payload.slice();
      new DataView(payload.buffer).setInt16(block.timestampOffset, block.time - start.time);
      blocks.push(element(block.id, payload));
    }

    return {
      bytes: join([this.header, element(SEGMENT, join([
        element(INFO, join(info)),
        this.tracks,
        element(CLUSTER, join(blocks)),
      ]))]),
      durationMs: duration * this.scale / 1_000_000,
    };
  }
}
