import { describe, it, expect, vi, afterEach } from "vitest";
import { DelegoClient } from "./client.js";

const CLEAN_JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]);

function installCanvasMock(): void {
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({ fillStyle: "", fillRect: vi.fn(), drawImage: vi.fn() }),
    toBlob: (callback: (blob: Blob | null) => void, type?: string) =>
      callback(new Blob([CLEAN_JPEG], { type: type ?? "image/jpeg" })),
  };
  Object.defineProperty(globalThis, "document", {
    value: { createElement: vi.fn(() => canvas), cookie: "" },
    configurable: true,
    writable: true,
  });
}

function installImageBitmapMock(width = 640, height = 480): void {
  Object.defineProperty(globalThis, "createImageBitmap", {
    value: vi.fn(async () => ({ width, height, close: vi.fn() })),
    configurable: true,
    writable: true,
  });
}

function presignResponse(data: unknown, status = 201): Response {
  return new Response(JSON.stringify({ data, error: null }), { status });
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).document;
  delete (globalThis as Record<string, unknown>).createImageBitmap;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("DelegoClient.uploadDisputeEvidence", () => {
  it("scrubs photo metadata before requesting a dispute-evidence upload", async () => {
    installImageBitmapMock(640, 480);
    installCanvasMock();

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        presignResponse({
          uploadUrl: "https://storage.test/upload",
          publicUrl: "https://cdn.test/dispute/IMG_1234.jpg",
          expiresInSeconds: 900,
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new DelegoClient({ baseUrl: "http://localhost:3000" });
    const file = new File([CLEAN_JPEG], "IMG_1234.jpg", { type: "image/jpeg" });

    const result = await client.uploadDisputeEvidence(file);

    expect(result.error).toBeNull();
    expect(result.data?.publicUrl).toBe("https://cdn.test/dispute/IMG_1234.jpg");
    expect(result.data?.contentType).toBe("image/jpeg");

    const [presignUrl, presignInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(presignUrl).toBe("http://localhost:3000/api/v1/storage/presigned-url");
    const body = JSON.parse(presignInit.body as string);
    expect(body).toMatchObject({
      filename: "IMG_1234.jpg",
      contentType: "image/jpeg",
      purpose: "dispute_evidence",
    });
    expect(body.fileSizeBytes).toBeGreaterThan(0);

    const [uploadUrl, uploadInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(uploadUrl).toBe("https://storage.test/upload");
    expect(uploadInit.method).toBe("PUT");
    expect(uploadInit.body).toBeInstanceOf(Blob);
  });

  it("strips directory components from evidence filenames", async () => {
    installImageBitmapMock();
    installCanvasMock();

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        presignResponse({ uploadUrl: "https://storage.test/up", publicUrl: "https://cdn.test/x.jpg", expiresInSeconds: 900 }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new DelegoClient({ baseUrl: "http://localhost:3000" });
    const file = new File([CLEAN_JPEG], "IMG.jpg", { type: "image/jpeg" });

    await client.uploadDisputeEvidence(file, { filename: "../../etc/IMG.jpg" });

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.filename).toBe("IMG.jpg");
  });

  it("uploads non-image evidence without canvas re-encoding", async () => {
    const pdfBytes = Uint8Array.from([0x25, 0x50, 0x44, 0x46]);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        presignResponse({ uploadUrl: "https://storage.test/up", publicUrl: "https://cdn.test/receipt.pdf", expiresInSeconds: 900 }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new DelegoClient({ baseUrl: "http://localhost:3000" });
    const file = new File([pdfBytes], "receipt.pdf", { type: "application/pdf" });

    const result = await client.uploadDisputeEvidence(file);

    expect(result.data?.contentType).toBe("application/pdf");
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.contentType).toBe("application/pdf");
    expect(body.fileSizeBytes).toBe(pdfBytes.length);
  });

  it("surfaces the pre-sign error without attempting an upload", async () => {
    installImageBitmapMock();
    installCanvasMock();

    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ data: null, error: { code: "FILE_TOO_LARGE", message: "too big" } }), {
        status: 400,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new DelegoClient({ baseUrl: "http://localhost:3000" });
    const file = new File([CLEAN_JPEG], "big.jpg", { type: "image/jpeg" });

    const result = await client.uploadDisputeEvidence(file);

    expect(result.data).toBeNull();
    expect(result.error?.code).toBe("FILE_TOO_LARGE");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reports a failed storage PUT", async () => {
    installImageBitmapMock();
    installCanvasMock();

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        presignResponse({ uploadUrl: "https://storage.test/up", publicUrl: "https://cdn.test/x.jpg", expiresInSeconds: 900 }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new DelegoClient({ baseUrl: "http://localhost:3000" });
    const file = new File([CLEAN_JPEG], "x.jpg", { type: "image/jpeg" });

    const result = await client.uploadDisputeEvidence(file);

    expect(result.data).toBeNull();
    expect(result.error?.code).toBe("EVIDENCE_UPLOAD_FAILED");
  });
});
