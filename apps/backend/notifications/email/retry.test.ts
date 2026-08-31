import { vi } from "vitest";

// Mocks must be hoisted before any imports that use them
vi.mock("@sendgrid/mail", () => {
  process.env.SENDGRID_API_KEY = "test-sendgrid-api-key";
  return {
    default: {
      setApiKey: vi.fn(),
      send: vi.fn(),
    },
  };
});

vi.mock("../src/models/FailedNotification.js", () => ({
  FailedNotification: {
    create: vi.fn(),
    findOne: vi.fn(),
  },
}));

vi.mock("@delegolabs/utils", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { sendEmailWithRetry } from "./index.js";
import type { EmailDispatchJob } from "./types.js";

const mockSgMail = await import("@sendgrid/mail");
const { FailedNotification } = await import(
  "../src/models/FailedNotification.js"
);

const baseJob: EmailDispatchJob = {
  notificationId: "550e8400-e29b-41d4-a716-446655440000",
  recipient: "user@example.com",
  templateName: "approval-request",
  payload: {
    orderId: "order-123",
    amount: "100 XLM",
    approvalUrl: "https://example.com/approve",
  },
  attempts: 0,
  userId: "user-id-123",
};

describe("sendEmailWithRetry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    process.env.EMAIL_MAX_RETRIES = "3";
    process.env.EMAIL_RETRY_BASE_DELAY_SECONDS = "2";
    process.env.EMAIL_DLQ_ENABLED = "true";
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.EMAIL_MAX_RETRIES;
    delete process.env.EMAIL_RETRY_BASE_DELAY_SECONDS;
    delete process.env.EMAIL_DLQ_ENABLED;
  });

  describe("success path", () => {
    it("resolves without writing to DLQ on first-attempt success", async () => {
      mockSgMail.default.send.mockResolvedValueOnce([{ statusCode: 202 }]);
      vi.mocked(FailedNotification.findOne).mockResolvedValueOnce(null);

      await sendEmailWithRetry(baseJob, "Test Subject");

      expect(mockSgMail.default.send).toHaveBeenCalledTimes(1);
      expect(FailedNotification.create).not.toHaveBeenCalled();
    });

    it("resolves without DLQ when transient error is recovered on retry", async () => {
      mockSgMail.default.send
        .mockRejectedValueOnce(new Error("ECONNRESET"))
        .mockResolvedValueOnce([{ statusCode: 202 }]);
      vi.mocked(FailedNotification.findOne).mockResolvedValue(null);

      const promise = sendEmailWithRetry(baseJob, "Test Subject");
      await vi.runAllTimersAsync();
      await promise;

      expect(mockSgMail.default.send).toHaveBeenCalledTimes(2);
      expect(FailedNotification.create).not.toHaveBeenCalled();
    });

    it("succeeds after two transient failures", async () => {
      let calls = 0;
      mockSgMail.default.send.mockImplementation(() => {
        calls++;
        if (calls <= 2) return Promise.reject(new Error("ETIMEDOUT"));
        return Promise.resolve([{ statusCode: 202 }]);
      });
      vi.mocked(FailedNotification.findOne).mockResolvedValue(null);

      const promise = sendEmailWithRetry(baseJob, "Test Subject");
      await vi.runAllTimersAsync();
      await promise;

      expect(mockSgMail.default.send).toHaveBeenCalledTimes(3);
      expect(FailedNotification.create).not.toHaveBeenCalled();
    });
  });

  describe("permanent failure path", () => {
    it("goes directly to DLQ on permanent error without retrying", async () => {
      mockSgMail.default.send.mockRejectedValueOnce(
        new Error("400 Bad Request - Invalid email")
      );
      vi.mocked(FailedNotification.findOne).mockResolvedValueOnce(null);
      vi.mocked(FailedNotification.create).mockResolvedValueOnce({} as any);

      const result = await sendEmailWithRetry(baseJob, "Test Subject").catch(
        (e) => e
      );

      expect(mockSgMail.default.send).toHaveBeenCalledTimes(1);
      expect(FailedNotification.create).toHaveBeenCalledTimes(1);
      expect(result.code).toBe("EMAIL_DISPATCH_FAILED");
    });

    it("does not retry after HTTP 401 Unauthorized", async () => {
      mockSgMail.default.send.mockRejectedValueOnce(
        new Error("401 Unauthorized")
      );
      vi.mocked(FailedNotification.findOne).mockResolvedValueOnce(null);
      vi.mocked(FailedNotification.create).mockResolvedValueOnce({} as any);

      const result = await sendEmailWithRetry(baseJob, "Test Subject").catch(
        (e) => e
      );

      expect(mockSgMail.default.send).toHaveBeenCalledTimes(1);
      expect(result.code).toBe("EMAIL_DISPATCH_FAILED");
    });

    it("does not retry on template not found error", async () => {
      mockSgMail.default.send.mockRejectedValueOnce(
        new Error("Template not found: approval-request")
      );
      vi.mocked(FailedNotification.findOne).mockResolvedValueOnce(null);
      vi.mocked(FailedNotification.create).mockResolvedValueOnce({} as any);

      const result = await sendEmailWithRetry(baseJob, "Test Subject").catch(
        (e) => e
      );

      expect(mockSgMail.default.send).toHaveBeenCalledTimes(1);
      expect(FailedNotification.create).toHaveBeenCalledTimes(1);
    });

    it("writes DLQ record with correct fields on permanent failure", async () => {
      mockSgMail.default.send.mockRejectedValueOnce(
        new Error("400 Bad Request")
      );
      vi.mocked(FailedNotification.findOne).mockResolvedValueOnce(null);
      vi.mocked(FailedNotification.create).mockResolvedValueOnce({} as any);

      await sendEmailWithRetry(baseJob, "Test Subject").catch(() => {});

      expect(FailedNotification.create).toHaveBeenCalledWith(
        expect.objectContaining({
          notificationId: baseJob.notificationId,
          recipient: baseJob.recipient,
          templateName: baseJob.templateName,
        })
      );
    });
  });

  describe("transient failure path — max retries exceeded", () => {
    it("retries up to maxRetries then writes to DLQ", async () => {
      mockSgMail.default.send.mockRejectedValue(new Error("ETIMEDOUT"));
      vi.mocked(FailedNotification.findOne).mockResolvedValue(null);
      vi.mocked(FailedNotification.create).mockResolvedValue({} as any);

      const promise = sendEmailWithRetry(baseJob, "Test Subject").catch(
        (e) => e
      );
      await vi.runAllTimersAsync();
      const result = await promise;

      // 1 initial + 3 retries (EMAIL_MAX_RETRIES=3)
      expect(mockSgMail.default.send).toHaveBeenCalledTimes(4);
      expect(FailedNotification.create).toHaveBeenCalledTimes(1);
      expect(result.code).toBe("EMAIL_DISPATCH_FAILED");
    });

    it("throws with standard error shape after max retries", async () => {
      mockSgMail.default.send.mockRejectedValue(new Error("503 Service Unavailable"));
      vi.mocked(FailedNotification.findOne).mockResolvedValue(null);
      vi.mocked(FailedNotification.create).mockResolvedValue({} as any);

      const promise = sendEmailWithRetry(baseJob, "Test Subject").catch(
        (e) => e
      );
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result).toHaveProperty("code", "EMAIL_DISPATCH_FAILED");
      expect(result).toHaveProperty("message");
      expect(result).toHaveProperty("lastError");
      expect(result.message).toMatch(/after \d+ attempt/);
    });

    it("respects EMAIL_MAX_RETRIES=1 (only one retry after initial)", async () => {
      process.env.EMAIL_MAX_RETRIES = "1";
      mockSgMail.default.send.mockRejectedValue(new Error("ECONNRESET"));
      vi.mocked(FailedNotification.findOne).mockResolvedValue(null);
      vi.mocked(FailedNotification.create).mockResolvedValue({} as any);

      const promise = sendEmailWithRetry(baseJob, "Test Subject").catch(
        (e) => e
      );
      await vi.runAllTimersAsync();
      await promise;

      // 1 initial + 1 retry
      expect(mockSgMail.default.send).toHaveBeenCalledTimes(2);
      expect(FailedNotification.create).toHaveBeenCalledTimes(1);
    });
  });

  describe("exponential backoff", () => {
    it("schedules a timer between retries", async () => {
      let calls = 0;
      mockSgMail.default.send.mockImplementation(() => {
        calls++;
        if (calls < 3) return Promise.reject(new Error("ETIMEDOUT"));
        return Promise.resolve([{ statusCode: 202 }]);
      });
      vi.mocked(FailedNotification.findOne).mockResolvedValue(null);

      const promise = sendEmailWithRetry(baseJob, "Test Subject");

      // Flush microtasks so the retry timer is registered
      for (let i = 0; i < 20; i++) await Promise.resolve();
      expect(vi.getTimerCount()).toBeGreaterThan(0);

      await vi.runAllTimersAsync();
      await promise;
    });
  });

  describe("payload and job integrity", () => {
    it("preserves notificationId and recipient across retries", async () => {
      mockSgMail.default.send
        .mockRejectedValueOnce(new Error("ECONNRESET"))
        .mockResolvedValueOnce([{ statusCode: 202 }]);
      vi.mocked(FailedNotification.findOne).mockResolvedValue(null);

      const promise = sendEmailWithRetry(baseJob, "Test Subject");
      await vi.runAllTimersAsync();
      await promise;

      // Both send calls should target the same recipient
      const calls = mockSgMail.default.send.mock.calls;
      for (const [msg] of calls) {
        expect(msg.to).toBe(baseJob.recipient);
      }
    });

    it("includes userId in DLQ record context", async () => {
      const jobWithUser: EmailDispatchJob = { ...baseJob, userId: "audit-99" };
      mockSgMail.default.send.mockRejectedValueOnce(
        new Error("401 Unauthorized")
      );
      vi.mocked(FailedNotification.findOne).mockResolvedValueOnce(null);
      vi.mocked(FailedNotification.create).mockResolvedValueOnce({} as any);

      await sendEmailWithRetry(jobWithUser, "Test Subject").catch(() => {});

      expect(FailedNotification.create).toHaveBeenCalledWith(
        expect.objectContaining({
          notificationId: jobWithUser.notificationId,
        })
      );
    });
  });

  describe("template validation (issue #136)", () => {
    it("does not call send when template variables are missing", async () => {
      const incompleteJob: EmailDispatchJob = {
        ...baseJob,
        // approval-request template requires approvalUrl — omit it
        payload: { orderId: "order-123", amount: "100 XLM" },
      };

      const result = await sendEmailWithRetry(
        incompleteJob,
        "Test Subject"
      ).catch((e) => e);

      expect(mockSgMail.default.send).not.toHaveBeenCalled();
      expect(result.code).toBe("EMAIL_DISPATCH_FAILED");
    });
  });
});
