/**
 * S3 archival service for chat messages.
 */
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { createLogger } from "@delegolabs/utils";
import type { ChatMessage } from "./types.js";

const log = createLogger("chat-archival:s3", process.env.LOG_LEVEL ?? "info");

export interface S3ArchivalService {
  archiveMessages(sessionId: string, messages: ChatMessage[]): Promise<string>;
}

export class S3ChatArchivalService implements S3ArchivalService {
  private readonly client: S3Client;
  private readonly bucketName: string;

  constructor() {
    const region = process.env.STORAGE_REGION || "auto";
    const endpoint = process.env.STORAGE_ENDPOINT;
    const accessKeyId = process.env.STORAGE_ACCESS_KEY_ID || "dummy-access-key";
    const secretAccessKey = process.env.STORAGE_SECRET_ACCESS_KEY || "dummy-secret-key";
    this.bucketName = process.env.CHAT_ARCHIVE_BUCKET || process.env.STORAGE_BUCKET_NAME || "delego-uploads";

    const config: any = {
      region,
      credentials: {
        accessKeyId,
        secretAccessKey,
      },
    };

    if (endpoint) {
      config.endpoint = endpoint;
      config.forcePathStyle = true;
    }

    this.client = new S3Client(config);
  }

  async archiveMessages(sessionId: string, messages: ChatMessage[]): Promise<string> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const key = `chat-archives/${sessionId}/${timestamp}.json`;

    const payload = {
      sessionId,
      archivedAt: new Date().toISOString(),
      messageCount: messages.length,
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content,
        tool_call_id: m.tool_call_id,
        name: m.name,
        token_count: m.token_count,
        created_at: m.created_at,
      })),
    };

    const command = new PutObjectCommand({
      Bucket: this.bucketName,
      Key: key,
      Body: JSON.stringify(payload, null, 2),
      ContentType: "application/json",
    });

    await this.client.send(command);

    log.info("Archived chat messages to S3", {
      sessionId,
      messageCount: messages.length,
      s3Key: key,
      bucket: this.bucketName,
    });

    return key;
  }
}
