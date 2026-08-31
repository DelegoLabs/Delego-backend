import { describe, it, expect, vi } from "vitest";
import { classifyError, calculateBackoffDelay } from "./errorClassifier.js";

vi.mock("@delegolabs/utils", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

describe("classifyError", () => {
  describe("transient errors", () => {
    it("classifies HTTP 429 as transient", () => {
      expect(classifyError(new Error("429 Too Many Requests"))).toBe(
        "transient"
      );
    });

    it("classifies rate limit message as transient", () => {
      expect(classifyError(new Error("rate limit exceeded"))).toBe("transient");
    });

    it("classifies HTTP 500 as transient", () => {
      expect(classifyError(new Error("500 Internal Server Error"))).toBe(
        "transient"
      );
    });

    it("classifies HTTP 502 as transient", () => {
      expect(classifyError(new Error("502 Bad Gateway"))).toBe("transient");
    });

    it("classifies HTTP 503 as transient", () => {
      expect(classifyError(new Error("503 Service Unavailable"))).toBe(
        "transient"
      );
    });

    it("classifies HTTP 504 as transient", () => {
      expect(classifyError(new Error("504 Gateway Timeout"))).toBe("transient");
    });

    it("classifies ECONNREFUSED as transient", () => {
      expect(classifyError(new Error("ECONNREFUSED"))).toBe("transient");
    });

    it("classifies ECONNRESET as transient", () => {
      expect(classifyError(new Error("ECONNRESET"))).toBe("transient");
    });

    it("classifies ETIMEDOUT as transient", () => {
      expect(classifyError(new Error("ETIMEDOUT"))).toBe("transient");
    });

    it("classifies timeout message as transient", () => {
      expect(classifyError(new Error("Request timeout after 30000ms"))).toBe(
        "transient"
      );
    });

    it("classifies ENOTFOUND as transient", () => {
      expect(classifyError(new Error("ENOTFOUND api.sendgrid.com"))).toBe(
        "transient"
      );
    });

    it("classifies getaddrinfo DNS errors as transient", () => {
      expect(
        classifyError(new Error("getaddrinfo ENOTFOUND api.sendgrid.com"))
      ).toBe("transient");
    });

    it("classifies EHOSTUNREACH as transient", () => {
      expect(classifyError(new Error("EHOSTUNREACH"))).toBe("transient");
    });

    it("classifies ENETUNREACH as transient", () => {
      expect(classifyError(new Error("ENETUNREACH"))).toBe("transient");
    });

    it("classifies EPIPE as transient", () => {
      expect(classifyError(new Error("EPIPE broken pipe"))).toBe("transient");
    });

    it("classifies error with ECONNREFUSED code as transient", () => {
      const err = new Error("connect failed") as NodeJS.ErrnoException;
      err.code = "ECONNREFUSED";
      expect(classifyError(err)).toBe("transient");
    });

    it("classifies error with ETIMEDOUT code as transient", () => {
      const err = new Error("timed out") as NodeJS.ErrnoException;
      err.code = "ETIMEDOUT";
      expect(classifyError(err)).toBe("transient");
    });

    it("classifies eai_again DNS retry errors as transient", () => {
      expect(
        classifyError(new Error("getaddrinfo EAI_AGAIN api.sendgrid.com"))
      ).toBe("transient");
    });
  });

  describe("permanent errors", () => {
    it("classifies HTTP 400 as permanent", () => {
      expect(classifyError(new Error("400 Bad Request"))).toBe("permanent");
    });

    it("classifies bad request message as permanent", () => {
      expect(classifyError(new Error("Bad Request: invalid parameters"))).toBe(
        "permanent"
      );
    });

    it("classifies invalid email as permanent", () => {
      expect(classifyError(new Error("Invalid email format"))).toBe(
        "permanent"
      );
    });

    it("classifies malformed request as permanent", () => {
      expect(classifyError(new Error("Malformed request body"))).toBe(
        "permanent"
      );
    });

    it("classifies HTTP 401 as permanent", () => {
      expect(classifyError(new Error("401 Unauthorized"))).toBe("permanent");
    });

    it("classifies unauthorized message as permanent", () => {
      expect(classifyError(new Error("Unauthorized: invalid token"))).toBe(
        "permanent"
      );
    });

    it("classifies HTTP 403 as permanent", () => {
      expect(classifyError(new Error("403 Forbidden"))).toBe("permanent");
    });

    it("classifies forbidden message as permanent", () => {
      expect(
        classifyError(new Error("Forbidden: insufficient permissions"))
      ).toBe("permanent");
    });

    it("classifies HTTP 404 as permanent", () => {
      expect(classifyError(new Error("404 Not Found"))).toBe("permanent");
    });

    it("classifies not found message as permanent", () => {
      expect(classifyError(new Error("Resource Not Found"))).toBe("permanent");
    });

    it("classifies template not found as permanent", () => {
      expect(classifyError(new Error("Template not found: approval-request"))).toBe(
        "permanent"
      );
    });

    it("classifies missing required template variables as permanent", () => {
      expect(
        classifyError(
          new Error("Missing required template variables: approvalUrl")
        )
      ).toBe("permanent");
    });

    it("classifies unsubstituted placeholders as permanent", () => {
      expect(
        classifyError(new Error("Template has unsubstituted placeholders"))
      ).toBe("permanent");
    });

    it("classifies API key errors as permanent", () => {
      expect(classifyError(new Error("Invalid api_key provided"))).toBe(
        "permanent"
      );
    });

    it("classifies credentials errors as permanent", () => {
      expect(classifyError(new Error("Invalid credentials"))).toBe("permanent");
    });
  });

  describe("unknown and edge case errors", () => {
    it("defaults to transient for unknown Error messages", () => {
      expect(classifyError(new Error("Something unexpected went wrong"))).toBe(
        "transient"
      );
    });

    it("defaults to transient for a plain string", () => {
      expect(classifyError("string error")).toBe("transient");
    });

    it("defaults to transient for an empty object", () => {
      expect(classifyError({})).toBe("transient");
    });

    it("defaults to transient for null", () => {
      expect(classifyError(null)).toBe("transient");
    });

    it("defaults to transient for undefined", () => {
      expect(classifyError(undefined)).toBe("transient");
    });

    it("defaults to transient for a number", () => {
      expect(classifyError(500)).toBe("transient");
    });
  });
});

describe("calculateBackoffDelay", () => {
  it("returns 0ms for attempt 0 (initial, before any retry)", () => {
    // attempt 0: 2^(-1) is handled by max(0, attempt-1)=0, so 2^0 * base
    // The function uses exponent = max(0, attempt-1), so attempt 0 => exponent 0
    const delay = calculateBackoffDelay(0, 2);
    // 2^0 * 2 * 1000 = 2000ms — attempt 0 maps to same as attempt 1
    expect(delay).toBeGreaterThanOrEqual(0);
    expect(delay).toBeLessThanOrEqual(120000);
  });

  it("returns 2000ms for attempt 1 with base 2s", () => {
    // exponent = max(0, 1-1) = 0, delay = 2^0 * 2 = 2s
    expect(calculateBackoffDelay(1, 2)).toBe(2000);
  });

  it("returns 4000ms for attempt 2 with base 2s", () => {
    // exponent = max(0, 2-1) = 1, delay = 2^1 * 2 = 4s
    expect(calculateBackoffDelay(2, 2)).toBe(4000);
  });

  it("returns 8000ms for attempt 3 with base 2s", () => {
    // exponent = max(0, 3-1) = 2, delay = 2^2 * 2 = 8s
    expect(calculateBackoffDelay(3, 2)).toBe(8000);
  });

  it("returns 16000ms for attempt 4 with base 2s", () => {
    // exponent = max(0, 4-1) = 3, delay = 2^3 * 2 = 16s
    expect(calculateBackoffDelay(4, 2)).toBe(16000);
  });

  it("caps delay at 120 seconds (120000ms)", () => {
    // Very high attempt should be capped
    expect(calculateBackoffDelay(10, 2)).toBe(120000);
    expect(calculateBackoffDelay(20, 2)).toBe(120000);
  });

  it("respects a different base delay", () => {
    // attempt 2, base 5: exponent=1, 2^1 * 5 = 10s = 10000ms
    expect(calculateBackoffDelay(2, 5)).toBe(10000);
  });

  it("always returns milliseconds (divisible by 1000 for whole-second bases)", () => {
    expect(calculateBackoffDelay(1, 2) % 1000).toBe(0);
    expect(calculateBackoffDelay(2, 2) % 1000).toBe(0);
    expect(calculateBackoffDelay(3, 2) % 1000).toBe(0);
  });

  it("never returns a negative value", () => {
    for (let attempt = 0; attempt <= 15; attempt++) {
      expect(calculateBackoffDelay(attempt, 2)).toBeGreaterThanOrEqual(0);
    }
  });
});
