import { describe, expect, it, vi } from "vitest";
import {
  processArbiterNotificationJob,
  type ArbiterDisputeNotificationJobData,
} from "./arbiterNotifications.js";

const jobData: ArbiterDisputeNotificationJobData = {
  event: "dispute.raised",
  audience: "arbiters",
  orderId: "order-1",
  disputeId: "dispute-1",
  initiatorAddress: "GBUYER",
  disputeReasonCode: 3,
  evidenceHash: "ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG",
  evidenceUrl: "https://ipfs.io/ipfs/QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG",
  ledgerSequence: 42,
  occurredAt: "2026-01-01T00:00:00.000Z",
};

describe("processArbiterNotificationJob", () => {
  it("emails arbiters and creates in-app/websocket notifications with the evidence link", async () => {
    const sendEmail = vi.fn(async () => undefined);
    const broadcast = vi.fn();
    const createInAppNotification = vi.fn(async () => ({}));

    const result = await processArbiterNotificationJob(jobData, {
      emails: ["arbiter@example.com"],
      userIds: ["arbiter-user-1"],
      sendEmail,
      broadcast,
      createInAppNotification,
    });

    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "arbiter@example.com",
        subject: "Dispute raised for order order-1",
      }),
    );
    const email = sendEmail.mock.calls[0]?.[0] as { html?: string; text?: string };
    expect(email.html).toContain(jobData.evidenceUrl);
    expect(email.text).toContain(jobData.evidenceUrl);

    expect(createInAppNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "arbiter-user-1",
        type: "dispute.raised",
        actionUrl: jobData.evidenceUrl,
        actionLabel: "View evidence",
      }),
    );
    expect(broadcast).toHaveBeenCalledWith(
      "arbiter-user-1",
      expect.objectContaining({
        type: "dispute.raised",
        payload: expect.objectContaining({ evidenceUrl: jobData.evidenceUrl }),
      }),
    );
    expect(result).toEqual({
      emailsSent: 1,
      emailsFailed: 0,
      inAppCreated: 1,
      websocketBroadcasts: 1,
    });
  });

  it("continues notifying other channels when one email fails", async () => {
    const sendEmail = vi.fn(async () => {
      throw new Error("smtp unavailable");
    });
    const broadcast = vi.fn();
    const createInAppNotification = vi.fn(async () => ({}));

    const result = await processArbiterNotificationJob(jobData, {
      emails: ["arbiter@example.com"],
      userIds: ["arbiter-user-1"],
      sendEmail,
      broadcast,
      createInAppNotification,
    });

    expect(result.emailsFailed).toBe(1);
    expect(result.inAppCreated).toBe(1);
    expect(result.websocketBroadcasts).toBe(1);
  });
});
