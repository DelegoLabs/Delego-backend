/**
 * Type definitions for chat archival job.
 */

export interface ChatArchivalSummary {
  sessionId: string;
  userId: string;
  messageCount: number;
  summaryText: string;
  archivedToS3Key: string;
  archivedAt: string;
}

export interface ChatArchivalJobData {
  sessionId: string;
  dryRun?: boolean;
}

export interface ChatArchivalJobResult {
  success: boolean;
  sessionId: string;
  messageCount: number;
  summaryText?: string;
  archivedToS3Key?: string;
  error?: string;
}

export interface IdleSession {
  id: string;
  session_id: string;
  user_id: string;
  agent_id: string;
  delegation_id?: string;
  message_count: number;
  total_tokens: number;
  last_message_at: string;
  created_at: string;
  archived_at?: string;
  archived_to_s3_key?: string;
}

export interface ChatMessage {
  id: string;
  session_id: string;
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
  name?: string;
  token_count?: number;
  created_at: string;
}
