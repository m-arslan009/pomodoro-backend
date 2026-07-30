import { describe, expect, it } from 'vitest';
import {
  AVATAR_MAX_BYTES,
  AVATAR_MAX_DIMENSION,
  AVATAR_UPLOAD_LIMIT_BYTES,
  sniffImage,
} from './image';

/*
 * The upload's security boundary.
 *
 * Everything the client says about a file is attacker-chosen — the Content-Type, the filename, the
 * declared length — so none of it reaches this module. What is asserted here is that the bytes
 * alone decide, that a header claiming implausible dimensions is refused before anything would
 * allocate for them, and that each refusal is distinguishable enough for the API to say something
 * useful about it.
 *
 * Fixtures are built by hand rather than read from disk: a real photo would make these tests
 * depend on a binary nobody can review in a diff, and the interesting cases are all malformed
 * anyway.
 */

function ascii(text: string): number[] {
  return [...text].map((character) => character.charCodeAt(0));
}

function writeUint32BE(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = (value >>> 24) & 0xff;
  bytes[offset + 1] = (value >>> 16) & 0xff;
  bytes[offset + 2] = (value >>> 8) & 0xff;
  bytes[offset + 3] = value & 0xff;
}

function writeUint16LE(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
}

/** A PNG header: signature, then the IHDR chunk the spec requires to come first. */
function png(width: number, height: number, padding = 0): Uint8Array {
  const bytes = new Uint8Array(24 + padding);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0x00, 0x00, 0x00, 0x0d], 8);
  bytes.set(ascii('IHDR'), 12);
  writeUint32BE(bytes, 16, width);
  writeUint32BE(bytes, 20, height);
  return bytes;
}

/**
 * One JPEG segment. `length` counts its own two bytes as well as the payload — getting that wrong
 * lands the marker walk in the middle of a segment, which is precisely what it must not do.
 */
function segment(marker: number, payload: readonly number[]): number[] {
  const length = payload.length + 2;
  return [0xff, marker, (length >>> 8) & 0xff, length & 0xff, ...payload];
}

/** SOI, anything the caller wants in front, then a start-of-frame carrying the dimensions. */
function jpeg(
  width: number,
  height: number,
  options: { marker?: number; before?: readonly number[] } = {},
): Uint8Array {
  const { marker = 0xc0, before = [] } = options;
  const frame = segment(marker, [
    0x08,
    (height >>> 8) & 0xff,
    height & 0xff,
    (width >>> 8) & 0xff,
    width & 0xff,
    0x03,
  ]);
  return Uint8Array.from([0xff, 0xd8, ...before, ...frame]);
}

function riff(chunk: string, size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set(ascii('RIFF'), 0);
  bytes.set(ascii('WEBP'), 8);
  bytes.set(ascii(chunk), 12);
  return bytes;
}

/** Lossy WebP: dimensions sit after the three-byte keyframe sync code. */
function webpVp8(width: number, height: number): Uint8Array {
  const bytes = riff('VP8 ', 30);
  bytes.set([0x9d, 0x01, 0x2a], 23);
  writeUint16LE(bytes, 26, width);
  writeUint16LE(bytes, 28, height);
  return bytes;
}

/** Lossless WebP: 14 bits of width then 14 of height, each stored minus one. */
function webpVp8l(width: number, height: number): Uint8Array {
  const bytes = riff('VP8L', 25);
  bytes[20] = 0x2f;
  const packed = (((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14)) >>> 0;
  bytes[21] = packed & 0xff;
  bytes[22] = (packed >>> 8) & 0xff;
  bytes[23] = (packed >>> 16) & 0xff;
  bytes[24] = (packed >>> 24) & 0xff;
  return bytes;
}

/** Extended WebP: three bytes per dimension, little-endian, each stored minus one. */
function webpVp8x(width: number, height: number): Uint8Array {
  const bytes = riff('VP8X', 30);
  bytes[24] = (width - 1) & 0xff;
  bytes[25] = ((width - 1) >>> 8) & 0xff;
  bytes[26] = ((width - 1) >>> 16) & 0xff;
  bytes[27] = (height - 1) & 0xff;
  bytes[28] = ((height - 1) >>> 8) & 0xff;
  bytes[29] = ((height - 1) >>> 16) & 0xff;
  return bytes;
}

describe('sniffImage', () => {
  describe('formats it accepts', () => {
    const accepted: ReadonlyArray<[string, Uint8Array, string]> = [
      ['a PNG', png(256, 128), 'image/png'],
      ['a baseline JPEG', jpeg(256, 128), 'image/jpeg'],
      ['an extended-sequential JPEG', jpeg(256, 128, { marker: 0xc1 }), 'image/jpeg'],
      ['a progressive JPEG', jpeg(256, 128, { marker: 0xc2 }), 'image/jpeg'],
      ['a lossy WebP', webpVp8(256, 128), 'image/webp'],
      ['a lossless WebP', webpVp8l(256, 128), 'image/webp'],
      ['an extended WebP', webpVp8x(256, 128), 'image/webp'],
    ];

    it.each(accepted)('reads the dimensions of %s', (_case, bytes, format) => {
      expect(sniffImage(bytes)).toEqual({ ok: true, format, width: 256, height: 128 });
    });

    it('walks past segments that are not the frame header', () => {
      // A real JPEG puts APP0 and its Huffman tables ahead of the frame. Each carries a length, so
      // the scan skips payloads rather than hunting for a byte pattern that could occur inside one.
      const bytes = jpeg(64, 32, {
        before: [
          ...segment(0xe0, ascii('JFIF\0')),
          ...segment(0xc4, new Array<number>(20).fill(0x11)),
        ],
      });

      expect(sniffImage(bytes)).toMatchObject({ ok: true, width: 64, height: 32 });
    });

    it('tolerates the fill bytes that may sit between segments', () => {
      // 0xff padding is legal and carries no length of its own.
      const bytes = jpeg(64, 32, { before: [0xff, 0xff] });

      expect(sniffImage(bytes)).toMatchObject({ ok: true, width: 64, height: 32 });
    });

    it('accepts an image exactly at the byte cap', () => {
      const bytes = png(16, 16, AVATAR_MAX_BYTES - 24);

      expect(bytes.byteLength).toBe(AVATAR_MAX_BYTES);
      expect(sniffImage(bytes)).toMatchObject({ ok: true });
    });

    it('accepts an image exactly at the dimension cap', () => {
      expect(sniffImage(png(AVATAR_MAX_DIMENSION, AVATAR_MAX_DIMENSION))).toMatchObject({
        ok: true,
      });
    });
  });

  describe('what it refuses', () => {
    const refused: ReadonlyArray<[string, Uint8Array, string]> = [
      ['nothing at all', new Uint8Array(0), 'empty'],
      ['one byte over the cap', png(16, 16, AVATAR_MAX_BYTES - 23), 'too_large'],
      ['a GIF', Uint8Array.from(ascii('GIF89a')), 'unsupported_format'],
      [
        'a text file renamed .png',
        Uint8Array.from(ascii('this is plainly not an image')),
        'unsupported_format',
      ],
      [
        'a PNG signature with no IHDR behind it',
        Uint8Array.from(png(1, 1).subarray(0, 12)),
        'corrupt',
      ],
      [
        'a PNG whose first chunk is not IHDR',
        (() => {
          const bytes = png(16, 16);
          bytes.set(ascii('gAMA'), 12);
          return bytes;
        })(),
        'corrupt',
      ],
      [
        'a JPEG with no frame header',
        Uint8Array.from([0xff, 0xd8, ...segment(0xe0, ascii('JFIF\0'))]),
        'corrupt',
      ],
      [
        'a JPEG whose segment length is impossible',
        Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x01, 0, 0, 0, 0]),
        'corrupt',
      ],
      ['a JPEG that stops mid-frame', Uint8Array.from(jpeg(16, 16).subarray(0, 8)), 'corrupt'],
      ['a WebP with an unknown chunk', riff('XMP ', 30), 'corrupt'],
      [
        'a lossy WebP with no sync code',
        (() => {
          const bytes = webpVp8(16, 16);
          bytes[23] = 0x00;
          return bytes;
        })(),
        'corrupt',
      ],
      ['a zero-width image', png(0, 128), 'corrupt'],
      ['a zero-height image', png(128, 0), 'corrupt'],
      ['an image wider than the cap', png(AVATAR_MAX_DIMENSION + 1, 16), 'dimensions_too_large'],
      ['an image taller than the cap', png(16, AVATAR_MAX_DIMENSION + 1), 'dimensions_too_large'],
    ];

    it.each(refused)('refuses %s', (_case, bytes, violation) => {
      expect(sniffImage(bytes)).toEqual({ ok: false, violation });
    });

    it('refuses implausible dimensions without allocating for them', () => {
      // The whole point of reading the header rather than decoding: this file is 24 bytes and
      // claims to be 60000×60000, which a decoder would answer by reserving 14 GB.
      expect(sniffImage(png(60_000, 60_000))).toEqual({
        ok: false,
        violation: 'dimensions_too_large',
      });
    });

    it('judges a file by its bytes, not by the extension or type it arrived under', () => {
      // Nothing in the signature carries a claimed type, so there is no way for one to be
      // consulted. This asserts the shape of the input as much as the behaviour.
      expect(sniffImage(Uint8Array.from(ascii('GIF89a')))).toMatchObject({
        violation: 'unsupported_format',
      });
    });
  });

  describe('the two size limits', () => {
    it('leaves room beneath the transport limit for a field error to be produced', () => {
      /*
       * These must not be equal. Multer aborts an oversized stream itself, which Nest renders as a
       * bare 413 naming no field — useful as a memory backstop, useless as feedback. Merely
       * oversized uploads have to arrive intact so that this module can refuse them as a
       * validation failure on `avatar`, which is what the form renders next to the control.
       */
      expect(AVATAR_UPLOAD_LIMIT_BYTES).toBeGreaterThan(AVATAR_MAX_BYTES);
    });
  });
});
