/**
 * Client-side EXIF metadata scrubbing for dispute evidence photos (#789).
 *
 * Evidence photos frequently carry privacy-sensitive metadata in their EXIF
 * blocks — GPS coordinates, camera make/model, lens and body serial numbers,
 * capture timestamps and owner tags. This module strips that metadata in the
 * browser *before* the file is uploaded as dispute evidence.
 *
 * Strategy: decode the image, re-render it to a `<canvas>` at its original
 * pixel dimensions, and re-encode it. The canvas encoder emits only pixel data
 * plus standard headers, so every embedded metadata segment (JPEG APP1/EXIF &
 * XMP, PNG `eXIf`/text chunks, WebP `EXIF`/`XMP` chunks) is dropped while the
 * image resolution is preserved exactly.
 *
 * The scrubber runs in any DOM/Worker environment and is dependency-free.
 */

/** Raster image types the canvas re-encode path can safely scrub. */
export const SCRUBBABLE_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;

export type ScrubbableImageType = (typeof SCRUBBABLE_IMAGE_TYPES)[number];

/** Kinds of embedded metadata the verification scanner recognises. */
export type EmbeddedMetadataKind = "exif" | "xmp";

export interface ScrubExifOptions {
  /**
   * Output MIME type. Defaults to the source file's type when it is a
   * scrub-bable raster type. Must be one of {@link SCRUBBABLE_IMAGE_TYPES}.
   */
  type?: string;
  /**
   * Encoder quality in the 0–1 range for lossy types (JPEG/WebP).
   * Defaults to `1` so re-encoding preserves as much detail as possible.
   */
  quality?: number;
  /**
   * Background painted behind the image before encoding. Only applied when the
   * output is JPEG, which has no alpha channel. Defaults to white.
   */
  background?: string;
  /**
   * When `true` (default) the scrubbed bytes are scanned again and the promise
   * rejects if any EXIF segment survived. This is the "verify privacy
   * preservation" guarantee from #789.
   */
  verify?: boolean;
}

/** Raised when a file cannot be scrubbed because its type is not supported. */
export class UnsupportedImageTypeError extends Error {
  constructor(public readonly type: string) {
    super(
      `Unsupported image type "${type || "unknown"}" — expected one of: ${SCRUBBABLE_IMAGE_TYPES.join(", ")}`,
    );
    this.name = "UnsupportedImageTypeError";
  }
}

/** Raised when decoding, rendering or encoding an image fails. */
export class ExifScrubError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExifScrubError";
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Strip EXIF metadata (GPS location, camera serial numbers, timestamps, …)
 * from an image file by re-rendering it to a canvas at its original
 * resolution. Resolves with the scrubbed image as a {@link Blob}; rejects with
 * {@link UnsupportedImageTypeError} for non-raster input.
 *
 * @example
 * const scrubbed = await scrubExifMetadata(photo);
 * await fetch(presignedUrl, { method: "PUT", body: scrubbed });
 */
export async function scrubExifMetadata(
  file: File,
  options: ScrubExifOptions = {},
): Promise<Blob> {
  const sourceType = normalizeImageType(file.type);
  if (!sourceType) {
    throw new UnsupportedImageTypeError(file.type);
  }

  const outputType = options.type ? normalizeImageType(options.type) : sourceType;
  if (!outputType) {
    throw new UnsupportedImageTypeError(options.type ?? "");
  }

  const decoded = await decodeImage(file);
  try {
    const canvas = createScrubCanvas(decoded.width, decoded.height);
    const context = canvas.getContext("2d") as unknown as ScrubbableContext | null;
    if (!context) {
      throw new ExifScrubError("2D canvas context is unavailable");
    }

    // JPEG has no alpha channel — paint an opaque backdrop so transparent
    // pixels are not rendered black.
    if (outputType === "image/jpeg") {
      context.fillStyle = options.background ?? "#ffffff";
      context.fillRect(0, 0, decoded.width, decoded.height);
    }

    // Draw 1:1 with the source's natural dimensions: no scaling, so the
    // original resolution is preserved exactly.
    context.drawImage(decoded.image, 0, 0, decoded.width, decoded.height);

    const quality = options.quality ?? 1;
    const scrubbed = await encodeCanvas(canvas, outputType, quality);

    if ((options.verify ?? true) && (await imageHasExif(scrubbed))) {
      throw new ExifScrubError("EXIF metadata is still present after scrubbing");
    }

    return scrubbed;
  } finally {
    decoded.dispose();
  }
}

/**
 * Convenience wrapper for upload pipelines handling mixed evidence: scrubs
 * raster images and passes every other file (e.g. PDF receipts) through
 * untouched.
 */
export async function scrubExifMetadataIfNeeded(
  file: File,
  options: ScrubExifOptions = {},
): Promise<Blob> {
  if (!normalizeImageType(file.type)) {
    return file;
  }
  return scrubExifMetadata(file, options);
}

/**
 * Scan encoded image bytes for embedded metadata segments. Pure and
 * synchronous, so it can run on the client or on a receiving server to
 * confirm that a file has no residual EXIF/XMP payloads.
 */
export function findEmbeddedMetadata(data: Uint8Array): EmbeddedMetadataKind[] {
  const found = new Set<EmbeddedMetadataKind>();
  collectJpegMetadata(data, found);
  collectPngMetadata(data, found);
  collectWebpMetadata(data, found);
  return [...found];
}

/** True when `data` contains an EXIF (or XMP) metadata segment. */
export function hasEmbeddedExif(data: Uint8Array): boolean {
  return findEmbeddedMetadata(data).length > 0;
}

// ---------------------------------------------------------------------------
// Image type helpers
// ---------------------------------------------------------------------------

function normalizeImageType(type: string | undefined | null): ScrubbableImageType | undefined {
  if (!type) return undefined;
  const bare = type.split(";")[0]?.trim().toLowerCase();
  const normalized = bare === "image/jpg" ? "image/jpeg" : bare;
  return (SCRUBBABLE_IMAGE_TYPES as readonly string[]).includes(normalized)
    ? (normalized as ScrubbableImageType)
    : undefined;
}

// ---------------------------------------------------------------------------
// Decoding / canvas / encoding
// ---------------------------------------------------------------------------

interface ScrubbableContext {
  fillStyle: string;
  fillRect(x: number, y: number, width: number, height: number): void;
  drawImage(image: CanvasImageSource, dx: number, dy: number, dw: number, dh: number): void;
}

interface DecodedImage {
  width: number;
  height: number;
  image: CanvasImageSource;
  dispose(): void;
}

async function decodeImage(file: File): Promise<DecodedImage> {
  if (typeof createImageBitmap === "function") {
    const bitmap = await createImageBitmap(file);
    return {
      width: bitmap.width,
      height: bitmap.height,
      image: bitmap,
      dispose: () => bitmap.close?.(),
    };
  }

  if (
    typeof Image !== "undefined" &&
    typeof URL !== "undefined" &&
    typeof URL.createObjectURL === "function"
  ) {
    const objectUrl = URL.createObjectURL(file);
    const image = new Image();
    try {
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new ExifScrubError("Failed to decode image file"));
        image.src = objectUrl;
      });
    } catch (error) {
      URL.revokeObjectURL(objectUrl);
      throw error;
    }
    return {
      width: image.naturalWidth,
      height: image.naturalHeight,
      image,
      dispose: () => URL.revokeObjectURL(objectUrl),
    };
  }

  throw new ExifScrubError("No image decoding API is available in this environment");
}

function createScrubCanvas(width: number, height: number): HTMLCanvasElement | OffscreenCanvas {
  if (typeof document !== "undefined" && typeof document.createElement === "function") {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }
  if (typeof OffscreenCanvas !== "undefined") {
    return new OffscreenCanvas(width, height);
  }
  throw new ExifScrubError("Canvas is not available in this environment");
}

async function encodeCanvas(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  type: ScrubbableImageType,
  quality: number,
): Promise<Blob> {
  if (typeof OffscreenCanvas !== "undefined" && canvas instanceof OffscreenCanvas) {
    return canvas.convertToBlob({ type, quality });
  }

  return new Promise<Blob>((resolve, reject) => {
    try {
      (canvas as HTMLCanvasElement).toBlob(
        (blob) => {
          if (blob) resolve(blob);
          else reject(new ExifScrubError("Failed to encode the scrubbed image"));
        },
        type,
        quality,
      );
    } catch (error) {
      reject(error instanceof Error ? error : new ExifScrubError(String(error)));
    }
  });
}

async function imageHasExif(blob: Blob): Promise<boolean> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return hasEmbeddedExif(bytes);
}

// ---------------------------------------------------------------------------
// Metadata scanning
// ---------------------------------------------------------------------------

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const EXIF_IDENTIFIER = "Exif\u0000\u0000";
const XMP_IDENTIFIER = "http://ns.adobe.com/xap/1.0/";

function collectJpegMetadata(data: Uint8Array, found: Set<EmbeddedMetadataKind>): void {
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) return;

  let offset = 2;
  while (offset + 3 < data.length) {
    if (data[offset] !== 0xff) {
      offset += 1;
      continue;
    }

    const marker = data[offset + 1] as number;
    // Padding bytes (fill bytes) of 0xFF.
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    // Standalone markers carry no length payload.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      offset += 2;
      continue;
    }
    // Start of scan / end of image: metadata segments only appear before SOS.
    if (marker === 0xda || marker === 0xd9) break;

    const segmentLength = ((data[offset + 2] as number) << 8) | (data[offset + 3] as number);
    if (segmentLength < 2) break;

    if (marker === 0xe1) {
      const payloadStart = offset + 4;
      if (startsWithAscii(data, payloadStart, EXIF_IDENTIFIER)) found.add("exif");
      if (startsWithAscii(data, payloadStart, XMP_IDENTIFIER)) found.add("xmp");
    }

    offset += 2 + segmentLength;
  }
}

function collectPngMetadata(data: Uint8Array, found: Set<EmbeddedMetadataKind>): void {
  if (!startsWithBytes(data, PNG_SIGNATURE)) return;

  let offset = PNG_SIGNATURE.length;
  while (offset + 8 <= data.length) {
    const length = readUint32BE(data, offset);
    const type = readAscii(data, offset + 4, 4);

    if (type === "eXIf") found.add("exif");
    if (type === "tEXt" || type === "iTXt" || type === "zTXt") {
      const chunk = readAscii(data, offset + 8, Math.min(length, 32));
      if (chunk.toLowerCase().includes("xmp")) found.add("xmp");
    }
    if (type === "IEND") break;

    offset += 12 + length; // length + type + data + CRC
  }
}

function collectWebpMetadata(data: Uint8Array, found: Set<EmbeddedMetadataKind>): void {
  if (data.length < 16) return;
  if (readAscii(data, 0, 4) !== "RIFF" || readAscii(data, 8, 4) !== "WEBP") return;

  let offset = 12;
  while (offset + 8 <= data.length) {
    const fourCc = readAscii(data, offset, 4);
    const size = readUint32LE(data, offset + 4);

    if (fourCc === "EXIF") found.add("exif");
    if (fourCc === "XMP ") found.add("xmp");

    offset += 8 + size + (size % 2); // chunks are even-padded
  }
}

function startsWithAscii(data: Uint8Array, offset: number, text: string): boolean {
  if (offset + text.length > data.length) return false;
  for (let i = 0; i < text.length; i += 1) {
    if (data[offset + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

function startsWithBytes(data: Uint8Array, bytes: number[]): boolean {
  if (data.length < bytes.length) return false;
  return bytes.every((byte, index) => data[index] === byte);
}

function readAscii(data: Uint8Array, offset: number, length: number): string {
  let out = "";
  for (let i = 0; i < length && offset + i < data.length; i += 1) {
    out += String.fromCharCode(data[offset + i] as number);
  }
  return out;
}

function readUint32BE(data: Uint8Array, offset: number): number {
  return (
    ((data[offset] as number) << 24) |
    ((data[offset + 1] as number) << 16) |
    ((data[offset + 2] as number) << 8) |
    (data[offset + 3] as number)
  ) >>> 0;
}

function readUint32LE(data: Uint8Array, offset: number): number {
  return (
    (data[offset] as number) |
    ((data[offset + 1] as number) << 8) |
    ((data[offset + 2] as number) << 16) |
    ((data[offset + 3] as number) << 24)
  ) >>> 0;
}
