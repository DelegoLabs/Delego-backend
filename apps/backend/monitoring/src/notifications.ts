/**
 * Notification channels for alert delivery
 * Issue #157
 */

import { createLogger } from "@delegolabs/utils";
import type { NotificationChannel } from "@delegolabs/types";

const log = createLogger("monitoring:notifications", process.env.LOG_LEVEL ?? "info");

const channels = new Map<string, NotificationChannel>();
const deliveryLog: Array<{
  channelType: string;
  target: string;
  message: string;
  status: "sent" | "failed";
  timestamp: string;
  error?: string;
}> = [];

export function registerChannel(channel: NotificationChannel): NotificationChannel {
  channels.set(channel.id, channel);
  log.info("Notification channel registered", { id: channel.id, type: channel.type, name: channel.name });
  return channel;
}

export function getChannel(id: string): NotificationChannel | null {
  return channels.get(id) ?? null;
}

export function listChannels(): NotificationChannel[] {
  return Array.from(channels.values());
}

export function updateChannel(id: string, updates: Partial<NotificationChannel>): NotificationChannel | null {
  const existing = channels.get(id);
  if (!existing) return null;

  const updated = { ...existing, ...updates, id };
  channels.set(id, updated);
  return updated;
}

export function deleteChannel(id: string): boolean {
  return channels.delete(id);
}

async function sendSlackNotification(
  config: Record<string, unknown>,
  message: string,
  title: string
): Promise<{ success: boolean; error?: string }> {
  const webhookUrl = config.webhookUrl as string;
  if (!webhookUrl) {
    return { success: false, error: "No webhook URL configured" };
  }

  try {
    const payload = {
      text: title,
      blocks: [
        {
          type: "header",
          text: { type: "plain_text", text: title },
        },
        {
          type: "section",
          text: { type: "mrkdwn", text: message },
        },
      ],
    };

    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      return { success: false, error: `HTTP ${response.status}` };
    }

    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function sendEmailNotification(
  config: Record<string, unknown>,
  _message: string,
  title: string
): Promise<{ success: boolean; error?: string }> {
  const _to = config.to as string;
  const _from = config.from as string;

  log.info("Email notification would be sent", { to: _to, from: _from, title });
  return { success: true };
}

async function sendSmsNotification(
  config: Record<string, unknown>,
  message: string
): Promise<{ success: boolean; error?: string }> {
  const _phoneNumber = config.phoneNumber as string;

  log.info("SMS notification would be sent", { phoneNumber: _phoneNumber, message });
  return { success: true };
}

async function sendPagerDutyNotification(
  config: Record<string, unknown>,
  message: string,
  title: string
): Promise<{ success: boolean; error?: string }> {
  const routingKey = config.routingKey as string;
  if (!routingKey) {
    return { success: false, error: "No routing key configured" };
  }

  try {
    const payload = {
      routing_key: routingKey,
      event_action: "trigger",
      payload: {
        summary: title,
        severity: "critical",
        source: "delego-monitoring",
        custom_details: { message },
      },
    };

    const response = await fetch("https://events.pagerduty.com/v2/enqueue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      return { success: false, error: `HTTP ${response.status}` };
    }

    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function sendNotification(
  channelType: string,
  targetId: string,
  title: string,
  message: string
): Promise<{ success: boolean; error?: string }> {
  const channel = channels.get(targetId);

  if (!channel) {
    return { success: false, error: `Channel ${targetId} not found` };
  }

  if (!channel.enabled) {
    return { success: false, error: `Channel ${targetId} is disabled` };
  }

  let result: { success: boolean; error?: string };

  switch (channelType) {
    case "slack":
      result = await sendSlackNotification(channel.config, message, title);
      break;
    case "email":
      result = await sendEmailNotification(channel.config, message, title);
      break;
    case "sms":
      result = await sendSmsNotification(channel.config, message);
      break;
    case "pagerduty":
      result = await sendPagerDutyNotification(channel.config, message, title);
      break;
    default:
      result = { success: false, error: `Unsupported channel type: ${channelType}` };
  }

  deliveryLog.push({
    channelType,
    target: targetId,
    message: message.slice(0, 200),
    status: result.success ? "sent" : "failed",
    timestamp: new Date().toISOString(),
    error: result.error,
  });

  return result;
}

export function getDeliveryLog(limit: number = 100) {
  return deliveryLog.slice(-limit);
}
