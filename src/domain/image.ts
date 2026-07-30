/*
 * Image rules — pure, framework-free, ORM-free (enforced by eslint on src/domain).
 *
 * The uploader's Content-Type and filename are never consulted: both are attacker-chosen, and a
 * text file renamed .png would sail past either one. Format comes from the bytes themselves, and
 * dimensions come from the header, so a small file claiming to be 60000×60000 is refused before
 * anything tries to decode it.
 *
 * Headers only. Nothing here decodes an image, which is what keeps this free of a native
 * dependency and free of the decoder attack surface that comes with one.
 */

export const AVATAR_MAX_BYTES = 262_144;
export const AVATAR_MAX_DIMENSION = 1024;

/**
 * The size at which the transport refuses to buffer any more, well above the real cap.
 *
 * The two limits are separate on purpose. Multer aborts the stream, which Nest reports as a bare
 * 413 naming no field — useful as a memory backstop, useless as feedback. Leaving room beneath it
 * lets a merely oversized upload arrive intact and be rejected by `sniffImage` as a validation
 * failure on `avatar`, which is what the client renders next to the control.
 */
export const AVATAR_UPLOAD_LIMIT_BYTES = 1_048_576;

export type ImageFormat = 'image/png' | 'image/jpeg' | 'image/webp';

export type ImageViolation =
  'empty' | 'too_large' | 'unsupported_format' | 'corrupt' | 'dimensions_too_large';

export type SniffResult =
  | {
      readonly ok: true;
      readonly format: ImageFormat;
      readonly width: number;
      readonly height: number;
    }
  | { readonly ok: false; readonly violation: ImageViolation };

function startsWith(bytes: Uint8Array, offset: number, signature: readonly number[]): boolean {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((byte, index) => bytes[offset + index] === byte);
}

function readUint32BE(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] << 24) |
      (bytes[offset + 1] << 16) |
      (bytes[offset + 2] << 8) |
      bytes[offset + 3]) >>>
    0
  );
}

function readUint16BE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function readUint16LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const IHDR = [0x49, 0x48, 0x44, 0x52];
const RIFF = [0x52, 0x49, 0x46, 0x46];
const WEBP = [0x57, 0x45, 0x42, 0x50];

/** Dimensions live in the IHDR chunk, which the spec requires to come first. */
function sniffPng(bytes: Uint8Array): SniffResult {
  if (bytes.length < 24 || !startsWith(bytes, 12, IHDR)) return { ok: false, violation: 'corrupt' };
  return {
    ok: true,
    format: 'image/png',
    width: readUint32BE(bytes, 16),
    height: readUint32BE(bytes, 20),
  };
}

/*
 * Walk the marker chain to the first start-of-frame. Every segment carries its own length, so the
 * scan skips payloads rather than searching for a byte pattern that could occur inside one.
 */
function sniffJpeg(bytes: Uint8Array): SniffResult {
  let offset = 2;

  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) return { ok: false, violation: 'corrupt' };

    const marker = bytes[offset + 1];

    // Padding between segments is legal and carries no length.
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    // Standalone markers: no payload to skip.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      offset += 2;
      continue;
    }

    const length = readUint16BE(bytes, offset + 2);
    if (length < 2) return { ok: false, violation: 'corrupt' };

    // SOF0-SOF15, excluding the three markers in that range that are not frame headers.
    const isStartOfFrame =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;

    if (isStartOfFrame) {
      if (offset + 9 >= bytes.length) return { ok: false, violation: 'corrupt' };
      return {
        ok: true,
        format: 'image/jpeg',
        height: readUint16BE(bytes, offset + 5),
        width: readUint16BE(bytes, offset + 7),
      };
    }

    offset += 2 + length;
  }

  return { ok: false, violation: 'corrupt' };
}

/** Three container variants, each storing its size differently. */
function sniffWebp(bytes: Uint8Array): SniffResult {
  const chunk = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);

  if (chunk === 'VP8 ') {
    if (bytes.length < 30) return { ok: false, violation: 'corrupt' };
    // 0x9d 0x01 0x2a is the keyframe sync code; without it the frame header is not where we think.
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) {
      return { ok: false, violation: 'corrupt' };
    }
    return {
      ok: true,
      format: 'image/webp',
      width: readUint16LE(bytes, 26) & 0x3fff,
      height: readUint16LE(bytes, 28) & 0x3fff,
    };
  }

  if (chunk === 'VP8L') {
    if (bytes.length < 25 || bytes[20] !== 0x2f) return { ok: false, violation: 'corrupt' };
    // 14 bits of width then 14 of height, both stored minus one, little-endian.
    const packed = (bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24)) >>> 0;
    return {
      ok: true,
      format: 'image/webp',
      width: (packed & 0x3fff) + 1,
      height: ((packed >>> 14) & 0x3fff) + 1,
    };
  }

  if (chunk === 'VP8X') {
    if (bytes.length < 30) return { ok: false, violation: 'corrupt' };
    return {
      ok: true,
      format: 'image/webp',
      width: (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16)) + 1,
      height: (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16)) + 1,
    };
  }

  return { ok: false, violation: 'corrupt' };
}

/** Identifies the format from the bytes and reads its dimensions, or says why it will not do. */
export function sniffImage(bytes: Uint8Array): SniffResult {
  if (bytes.length === 0) return { ok: false, violation: 'empty' };
  if (bytes.length > AVATAR_MAX_BYTES) return { ok: false, violation: 'too_large' };

  let result: SniffResult;
  if (startsWith(bytes, 0, PNG_SIGNATURE)) result = sniffPng(bytes);
  else if (bytes[0] === 0xff && bytes[1] === 0xd8) result = sniffJpeg(bytes);
  else if (startsWith(bytes, 0, RIFF) && startsWith(bytes, 8, WEBP)) result = sniffWebp(bytes);
  else return { ok: false, violation: 'unsupported_format' };

  if (!result.ok) return result;
  if (result.width === 0 || result.height === 0) return { ok: false, violation: 'corrupt' };
  if (result.width > AVATAR_MAX_DIMENSION || result.height > AVATAR_MAX_DIMENSION) {
    return { ok: false, violation: 'dimensions_too_large' };
  }

  return result;
}
