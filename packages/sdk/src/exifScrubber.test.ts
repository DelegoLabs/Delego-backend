import { describe, it, expect, vi, afterEach } from "vitest";
import {
  scrubExifMetadata,
  scrubExifMetadataIfNeeded,
  findEmbeddedMetadata,
  hasEmbeddedExif,
  UnsupportedImageTypeError,
  ExifScrubError,
} from "./exifScrubber.js";

// ---------------------------------------------------------------------------
// Byte fixtures
// ---------------------------------------------------------------------------

function asciiBytes(text: string): number[] {
  return [...text].map((char) => char.charCodeAt(0));
}

const CLEAN_JPEG: Uint8Array<ArrayBuffer> = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]);

function jpegWithApp1(payload: number[]): Uint8Array<ArrayBuffer> {
  const segmentLength = payload.length + 2;
  return Uint8Array.from([
    0xff,
    0xd8,
    0xff,
    0xe1,
    (segmentLength >> 8) & 0xff,
    segmentLength & 0xff,
    ...payload,
    0xff,
    0xd9,
  ]);
}

function jpegWithExif(): Uint8Array<ArrayBuffer> {
  return jpegWithApp1([...asciiBytes("Exif\u0000\u0000"), 0x4d, 0x4d, 0x00, 0x2a]);
}

function jpegWithXmp(): Uint8Array<ArrayBuffer> {
  return jpegWithApp1([...asciiBytes("http://ns.adobe.com/xap/1.0/\u0000"), 0x3c, 0x78, 0x3e]);
}

function pngChunk(type: string, data: number[]): number[] {
  const length = data.length;
  return [
    (length >>> 24) & 0xff,
    (length >>> 16) & 0xff,
    (length >>> 8) & 0xff,
    length & 0xff,
    ...asciiBytes(type),
    ...data,
    0x00,
    0x00,
    0x00,
    0x00,
  ];
}

function pngWithExif(): Uint8Array<ArrayBuffer> {
  return Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...pngChunk("eXIf", [0x4d, 0x4d, 0x00, 0x2a]),
    ...pngChunk("IEND", []),
  ]);
}

function webpWithExif(): Uint8Array<ArrayBuffer> {
  const chunk = [...asciiBytes("EXIF"), 4, 0, 0, 0, 0x4d, 0x4d, 0x00, 0x2a];
  const body = [...asciiBytes("WEBP"), ...chunk];
  const size = body.length;
  return Uint8Array.from([
    ...asciiBytes("RIFF"),
    size & 0xff, (size >> 8) & 0xff, (size >> 16) & 0xff, (size >> 24) & 0xff,
    ...body,
  ]);
}

// ---------------------------------------------------------------------------
// Browser API mocks
// ---------------------------------------------------------------------------

interface CanvasMock {
  canvas: {
    width: number;
    height: number;
    getContext: ReturnType<typeof vi.fn>;
    toBlob: ReturnType<typeof vi.fn>;
  };
  context: { fillStyle: string; fillRect: ReturnType<typeof vi.fn>; drawImage: ReturnType<typeof vi.fn> };
}

function installCanvasMock(outputBytes: Uint8Array<ArrayBuffer>, toBlobResult: Blob | null = null): CanvasMock {
  const context = { fillStyle: "", fillRect: vi.fn(), drawImage: vi.fn() };
  const canvas = {
    width: 0,
    height: 0,
    getContext: vi.fn(() => context),
    toBlob: vi.fn((callback: (blob: Blob | null) => void, type?: string) => {
      callback(toBlobResult ?? new Blob([outputBytes], { type: type ?? "image/jpeg" }));
    }),
  };
  Object.defineProperty(globalThis, "document", {
    value: { createElement: vi.fn(() => canvas), cookie: "" },
    configurable: true,
    writable: true,
  });
  return { canvas, context };
}

function installImageBitmapMock(width = 800, height = 600): { width: number; height: number; close: ReturnType<typeof vi.fn> } {
  const bitmap = { width, height, close: vi.fn() };
  Object.defineProperty(globalThis, "createImageBitmap", {
    value: vi.fn(async () => bitmap),
    configurable: true,
    writable: true,
  });
  return bitmap;
}

function imageFile(type = "image/jpeg", name = "photo.jpg"): File {
  return new File([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], name, { type });
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).document;
  delete (globalThis as Record<string, unknown>).createImageBitmap;
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Metadata scanning (privacy verification)
// ---------------------------------------------------------------------------

describe("findEmbeddedMetadata", () => {
  it("detects an EXIF segment in a JPEG", () => {
    expect(findEmbeddedMetadata(jpegWithExif())).toContain("exif");
  });

  it("detects an XMP segment in a JPEG", () => {
    expect(findEmbeddedMetadata(jpegWithXmp())).toContain("xmp");
  });

  it("detects the PNG eXIf chunk", () => {
    expect(findEmbeddedMetadata(pngWithExif())).toContain("exif");
  });

  it("detects the WebP EXIF chunk", () => {
    expect(findEmbeddedMetadata(webpWithExif())).toContain("exif");
  });

  it("returns no markers for a clean JPEG", () => {
    expect(findEmbeddedMetadata(CLEAN_JPEG)).toEqual([]);
    expect(hasEmbeddedExif(CLEAN_JPEG)).toBe(false);
  });

  it("reports EXIF presence via hasEmbeddedExif", () => {
    expect(hasEmbeddedExif(jpegWithExif())).toBe(true);
    expect(hasEmbeddedExif(pngWithExif())).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// scrubExifMetadata
// ---------------------------------------------------------------------------

describe("scrubExifMetadata", () => {
  it("re-renders at the original resolution and returns a re-encoded blob", async () => {
    installImageBitmapMock(800, 600);
    const { canvas, context } = installCanvasMock(CLEAN_JPEG);

    const result = await scrubExifMetadata(imageFile());

    expect(canvas.width).toBe(800);
    expect(canvas.height).toBe(600);
    expect(context.drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 800, 600);
    expect(result.type).toBe("image/jpeg");
    expect(result.size).toBeGreaterThan(0);
  });

  it("passes the requested type and quality to the encoder", async () => {
    installImageBitmapMock(120, 90);
    const { canvas, context } = installCanvasMock(CLEAN_JPEG);

    const result = await scrubExifMetadata(imageFile("image/png", "shot.png"), {
      type: "image/jpeg",
      quality: 0.9,
      background: "#000000",
    });

    expect(context.fillStyle).toBe("#000000");
    expect(context.fillRect).toHaveBeenCalledWith(0, 0, 120, 90);
    expect(canvas.toBlob).toHaveBeenCalledWith(expect.any(Function), "image/jpeg", 0.9);
    expect(result.type).toBe("image/jpeg");
  });

  it("does not paint a backdrop when the output supports alpha", async () => {
    installImageBitmapMock();
    const { context } = installCanvasMock(CLEAN_JPEG);

    await scrubExifMetadata(imageFile("image/png", "shot.png"));

    expect(context.fillRect).not.toHaveBeenCalled();
  });

  it("accepts the non-standard image/jpg alias", async () => {
    installImageBitmapMock();
    installCanvasMock(CLEAN_JPEG);

    const result = await scrubExifMetadata(imageFile("image/jpg"));

    expect(result.type).toBe("image/jpeg");
  });

  it("rejects unsupported input types", async () => {
    await expect(scrubExifMetadata(imageFile("application/pdf", "receipt.pdf"))).rejects.toBeInstanceOf(
      UnsupportedImageTypeError,
    );
  });

  it("rejects an unsupported output type", async () => {
    installImageBitmapMock();
    await expect(
      scrubExifMetadata(imageFile(), { type: "image/gif" }),
    ).rejects.toBeInstanceOf(UnsupportedImageTypeError);
  });

  it("verifies that no EXIF survives, rejecting residual metadata", async () => {
    installImageBitmapMock();
    installCanvasMock(CLEAN_JPEG, new Blob([jpegWithExif()], { type: "image/jpeg" }));

    await expect(scrubExifMetadata(imageFile())).rejects.toBeInstanceOf(ExifScrubError);
  });

  it("skips verification when disabled", async () => {
    installImageBitmapMock();
    installCanvasMock(CLEAN_JPEG, new Blob([jpegWithExif()], { type: "image/jpeg" }));

    await expect(scrubExifMetadata(imageFile(), { verify: false })).resolves.toBeInstanceOf(Blob);
  });

  it("fails clearly when no image decoding API exists", async () => {
    installCanvasMock(CLEAN_JPEG);
    await expect(scrubExifMetadata(imageFile())).rejects.toBeInstanceOf(ExifScrubError);
  });

  it("fails clearly when no canvas backend exists", async () => {
    installImageBitmapMock();
    await expect(scrubExifMetadata(imageFile())).rejects.toBeInstanceOf(ExifScrubError);
  });
});

// ---------------------------------------------------------------------------
// scrubExifMetadataIfNeeded
// ---------------------------------------------------------------------------

describe("scrubExifMetadataIfNeeded", () => {
  it("scrubs supported raster images", async () => {
    installImageBitmapMock(10, 20);
    installCanvasMock(CLEAN_JPEG);
    const file = imageFile();

    const result = await scrubExifMetadataIfNeeded(file);

    expect(result).not.toBe(file);
    expect(result).toBeInstanceOf(Blob);
  });

  it("passes non-image evidence through untouched", async () => {
    const file = imageFile("application/pdf", "receipt.pdf");

    const result = await scrubExifMetadataIfNeeded(file);

    expect(result).toBe(file);
  });
});
