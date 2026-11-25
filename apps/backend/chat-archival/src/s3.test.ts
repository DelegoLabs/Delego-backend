import { afterEach, describe, expect, it, vi } from "vitest";
import { getS3Credentials, S3ChatArchivalService } from "./s3.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("S3 credentials", () => {
  it.each(["STORAGE_ACCESS_KEY_ID", "STORAGE_SECRET_ACCESS_KEY"])(
    "throws in production when %s is missing",
    (missingCredential) => {
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("STORAGE_ACCESS_KEY_ID", "access-key");
      vi.stubEnv("STORAGE_SECRET_ACCESS_KEY", "secret-key");
      vi.stubEnv(missingCredential, "");

      expect(() => new S3ChatArchivalService()).toThrow(
        `Missing required S3 credentials in production: ${missingCredential}`
      );
    }
  );

  it("uses dummy credentials outside production when credentials are missing", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("STORAGE_ACCESS_KEY_ID", "");
    vi.stubEnv("STORAGE_SECRET_ACCESS_KEY", "");

    expect(getS3Credentials()).toEqual({
      accessKeyId: "dummy-access-key",
      secretAccessKey: "dummy-secret-key",
    });
  });
});
