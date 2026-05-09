const utf8Decoder = new TextDecoder();

export function payloadBytes(payload: unknown): Buffer | Uint8Array | undefined {
  if (typeof payload === "string") return Buffer.from(payload);
  if (payload instanceof ArrayBuffer) return new Uint8Array(payload);
  if (ArrayBuffer.isView(payload)) return new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);
  return undefined;
}

function skipJsonWhitespace(bytes: Uint8Array, idx: number): number {
  while (idx < bytes.byteLength) {
    const c = bytes[idx];
    if (c !== 0x20 && c !== 0x0a && c !== 0x0d && c !== 0x09) break;
    idx++;
  }
  return idx;
}

type JsonStringSpan = { start: number; end: number; next: number; escaped: boolean };

function parseJsonStringSpan(bytes: Uint8Array, idx: number): JsonStringSpan | undefined {
  if (idx >= bytes.byteLength || bytes[idx] !== 0x22) return undefined;
  let i = idx + 1;
  const start = i;
  let escaped = false;
  while (i < bytes.byteLength) {
    const c = bytes[i];
    if (c === 0x22) return { start, end: i, next: i + 1, escaped };
    if (c === 0x5c) {
      escaped = true;
      i += 2;
      continue;
    }
    i++;
  }
  return undefined;
}

function quoteIsEscaped(bytes: Uint8Array, quote: number): boolean {
  let slashes = 0;
  for (let i = quote - 1; i >= 0 && bytes[i] === 0x5c; i--) slashes++;
  return (slashes & 1) === 1;
}

function parseJsonStringSpanFast(bytes: Uint8Array, haystack: Buffer, idx: number): JsonStringSpan | undefined {
  if (idx >= bytes.byteLength || bytes[idx] !== 0x22) return undefined;
  const start = idx + 1;
  let searchFrom = start;
  let escaped = false;
  while (searchFrom < bytes.byteLength) {
    const quote = haystack.indexOf(0x22, searchFrom);
    if (quote < 0) return undefined;
    if (!quoteIsEscaped(bytes, quote)) return { start, end: quote, next: quote + 1, escaped };
    escaped = true;
    searchFrom = quote + 1;
  }
  return undefined;
}

function asciiSpanEquals(bytes: Uint8Array, span: JsonStringSpan, value: string): boolean {
  if (span.escaped || span.end - span.start !== value.length) return false;
  for (let i = 0; i < value.length; i++) {
    if (bytes[span.start + i] !== value.charCodeAt(i)) return false;
  }
  return true;
}

function decodeJsonStringSpan(bytes: Uint8Array, span: JsonStringSpan): string | undefined {
  const raw = utf8Decoder.decode(bytes.subarray(span.start, span.end));
  if (!span.escaped) return raw;
  try {
    return JSON.parse(`"${raw}"`);
  } catch {
    return undefined;
  }
}

function skipJsonValueBytes(bytes: Uint8Array, idx: number, depth = 0): number {
  if (depth > 128) return -1;
  idx = skipJsonWhitespace(bytes, idx);
  if (idx >= bytes.byteLength) return -1;
  const c = bytes[idx];

  if (c === 0x22) {
    const span = parseJsonStringSpan(bytes, idx);
    return span ? span.next : -1;
  }

  if (c === 0x7b) {
    idx = skipJsonWhitespace(bytes, idx + 1);
    if (bytes[idx] === 0x7d) return idx + 1;
    while (idx < bytes.byteLength) {
      const key = parseJsonStringSpan(bytes, idx);
      if (!key) return -1;
      idx = skipJsonWhitespace(bytes, key.next);
      if (bytes[idx] !== 0x3a) return -1;
      idx = skipJsonValueBytes(bytes, idx + 1, depth + 1);
      if (idx < 0) return -1;
      idx = skipJsonWhitespace(bytes, idx);
      if (bytes[idx] === 0x2c) {
        idx = skipJsonWhitespace(bytes, idx + 1);
        continue;
      }
      if (bytes[idx] === 0x7d) return idx + 1;
      return -1;
    }
    return -1;
  }

  if (c === 0x5b) {
    idx = skipJsonWhitespace(bytes, idx + 1);
    if (bytes[idx] === 0x5d) return idx + 1;
    while (idx < bytes.byteLength) {
      idx = skipJsonValueBytes(bytes, idx, depth + 1);
      if (idx < 0) return -1;
      idx = skipJsonWhitespace(bytes, idx);
      if (bytes[idx] === 0x2c) {
        idx = skipJsonWhitespace(bytes, idx + 1);
        continue;
      }
      if (bytes[idx] === 0x5d) return idx + 1;
      return -1;
    }
    return -1;
  }

  const start = idx;
  while (idx < bytes.byteLength) {
    const ch = bytes[idx];
    if (ch === 0x2c || ch === 0x7d || ch === 0x5d || ch === 0x20 || ch === 0x0a || ch === 0x0d || ch === 0x09) break;
    idx++;
  }
  return idx > start ? idx : -1;
}

export function jsonRootStringFieldValue(bytes: Uint8Array, fields: Set<string>): string | undefined {
  // Single-pass root-key scanner. It validates only enough JSON structure to
  // stay at object depth 1 and avoids recursively skipping large `input` arrays.
  const haystack = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let depth = 0;
  for (let idx = 0; idx < bytes.byteLength; idx++) {
    const c = bytes[idx];
    if (c === 0x7b || c === 0x5b) { // { or [
      depth++;
      continue;
    }
    if (c === 0x7d || c === 0x5d) { // } or ]
      depth--;
      if (depth < 0) return undefined;
      continue;
    }
    if (c !== 0x22) continue;

    const key = parseJsonStringSpanFast(bytes, haystack, idx);
    if (!key) return undefined;
    idx = key.next - 1;
    if (depth !== 1) continue;

    let next = skipJsonWhitespace(bytes, key.next);
    if (bytes[next] !== 0x3a) continue;
    next = skipJsonWhitespace(bytes, next + 1);

    for (const field of fields) {
      if (asciiSpanEquals(bytes, key, field)) {
        const value = parseJsonStringSpanFast(bytes, haystack, next);
        const decoded = value ? decodeJsonStringSpan(bytes, value) : undefined;
        if (decoded?.trim()) return decoded;
        break;
      }
    }
  }
  return undefined;
}
