import { describe, it, expect, afterEach, vi } from "vitest";
import type { NotificationChannel } from "@delegolabs/types";
import {
  registerChannel,
  getChannel,
  listChannels,
  updateChannel,
  deleteChannel,
  sendNotification,
  getDeliveryLog,
} from "./notifications.js";

function makeChannel(overrides: Partial<NotificationChannel> = {}): NotificationChannel {
  return {
    id: `chan_${Math.random().toString(36).slice(2)}`,
    type: "slack",
    name: "Ops Alerts",
    config: { webhookUrl: "https://hooks.slack.com/services/T00/B00/XXX" },
    enabled: true,
    ...overrides,
  };
}

describe("notifications", () => {
  const createdChannelIds: string[] = [];

  afterEach(() => {
    for (const id of createdChannelIds.splice(0)) {
      deleteChannel(id);
    }
    vi.restoreAllMocks();
  });

  describe("channel CRUD", () => {
    it("registers, gets, lists, updates, and deletes channels", () => {
      const channel = makeChannel({ id: "chan-crud-1" });
      createdChannelIds.push(channel.id);

      expect(registerChannel(channel)).toEqual(channel);
      expect(getChannel(channel.id)).toEqual(channel);
      expect(listChannels().some((c) => c.id === channel.id)).toBe(true);

      const updated = updateChannel(channel.id, { name: "Updated Ops", id: "ignored" });
      expect(updated?.name).toBe("Updated Ops");
      expect(updated?.id).toBe(channel.id);

      expect(updateChannel("missing-chan", { name: "Nope" })).toBeNull();
      expect(deleteChannel(channel.id)).toBe(true);
      expect(getChannel(channel.id)).toBeNull();
      expect(deleteChannel(channel.id)).toBe(false);
    });
  });

  describe("sendNotification", () => {
    it("returns an error when channel is missing or disabled", async () => {
      expect(await sendNotification("slack", "no-such-channel", "Title", "Body")).toEqual({
        success: false,
        error: "Channel no-such-channel not found",
      });

      const disabled = makeChannel({ id: "chan-disabled", enabled: false });
      createdChannelIds.push(disabled.id);
      registerChannel(disabled);

      expect(await sendNotification("slack", disabled.id, "Title", "Body")).toEqual({
        success: false,
        error: `Channel ${disabled.id} is disabled`,
      });
    });

    it("delivers Slack notifications and handles missing webhook, HTTP errors, and network failures", async () => {
      const noWebhook = makeChannel({ id: "chan-slack-no-url", config: {} });
      const validSlack = makeChannel({ id: "chan-slack-ok" });
      createdChannelIds.push(noWebhook.id, validSlack.id);
      registerChannel(noWebhook);
      registerChannel(validSlack);

      expect(await sendNotification("slack", noWebhook.id, "Alert", "Details")).toEqual({
        success: false,
        error: "No webhook URL configured",
      });

      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(null, { status: 200 })
      );
      expect(await sendNotification("slack", validSlack.id, "CPU High", "95% usage")).toEqual({
        success: true,
      });
      expect(fetchSpy).toHaveBeenCalledWith(
        "https://hooks.slack.com/services/T00/B00/XXX",
        expect.objectContaining({ method: "POST" })
      );

      fetchSpy.mockResolvedValueOnce(new Response(null, { status: 500 }));
      expect(await sendNotification("slack", validSlack.id, "CPU High", "95% usage")).toEqual({
        success: false,
        error: "HTTP 500",
      });

      fetchSpy.mockRejectedValueOnce(new Error("ECONNREFUSED"));
      expect(await sendNotification("slack", validSlack.id, "CPU High", "95% usage")).toEqual({
        success: false,
        error: "ECONNREFUSED",
      });
    });

    it("delivers email and SMS notifications", async () => {
      const emailChan = makeChannel({
        id: "chan-email",
        type: "email",
        config: { to: "ops@example.com", from: "alerts@example.com" },
      });
      const smsChan = makeChannel({
        id: "chan-sms",
        type: "sms",
        config: { phoneNumber: "+15551234567" },
      });
      createdChannelIds.push(emailChan.id, smsChan.id);
      registerChannel(emailChan);
      registerChannel(smsChan);

      expect(await sendNotification("email", emailChan.id, "Disk", "90% full")).toEqual({
        success: true,
      });
      expect(await sendNotification("sms", smsChan.id, "Disk", "90% full")).toEqual({
        success: true,
      });
    });

    it("delivers PagerDuty notifications and handles errors", async () => {
      const noKey = makeChannel({ id: "chan-pd-nokey", type: "pagerduty", config: {} });
      const validPd = makeChannel({
        id: "chan-pd-ok",
        type: "pagerduty",
        config: { routingKey: "rk-123" },
      });
      createdChannelIds.push(noKey.id, validPd.id);
      registerChannel(noKey);
      registerChannel(validPd);

      expect(await sendNotification("pagerduty", noKey.id, "Outage", "API down")).toEqual({
        success: false,
        error: "No routing key configured",
      });

      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(null, { status: 202 })
      );
      expect(await sendNotification("pagerduty", validPd.id, "Outage", "API down")).toEqual({
        success: true,
      });
      expect(fetchSpy).toHaveBeenCalledWith(
        "https://events.pagerduty.com/v2/enqueue",
        expect.objectContaining({ method: "POST" })
      );

      fetchSpy.mockResolvedValueOnce(new Response(null, { status: 429 }));
      expect(await sendNotification("pagerduty", validPd.id, "Outage", "API down")).toEqual({
        success: false,
        error: "HTTP 429",
      });

      fetchSpy.mockRejectedValueOnce(new Error("timeout"));
      expect(await sendNotification("pagerduty", validPd.id, "Outage", "API down")).toEqual({
        success: false,
        error: "timeout",
      });
    });

    it("rejects unsupported channel types and records delivery log with truncation", async () => {
      const chan = makeChannel({ id: "chan-unsupported" });
      createdChannelIds.push(chan.id);
      registerChannel(chan);

      const longMessage = "x".repeat(250);
      const res = await sendNotification("webhook", chan.id, "Title", longMessage);
      expect(res).toEqual({
        success: false,
        error: "Unsupported channel type: webhook",
      });

      const lastEntry = getDeliveryLog(1)[0];
      expect(lastEntry).toMatchObject({
        channelType: "webhook",
        target: chan.id,
        status: "failed",
        error: "Unsupported channel type: webhook",
      });
      expect(lastEntry.message).toHaveLength(200);
    });
  });
});
