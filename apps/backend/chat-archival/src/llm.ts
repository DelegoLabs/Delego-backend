/**
 * LLM summarization service for chat sessions.
 */
import { createDefaultLLMClient } from "@delegolabs/agents/llm";
import { createLogger } from "@delegolabs/utils";
import type { ChatMessage } from "./types.js";

const log = createLogger("chat-archival:llm", process.env.LOG_LEVEL ?? "info");

export interface SummarizationService {
  summarizeSession(messages: ChatMessage[]): Promise<string>;
}

export class LLMSummarizationService implements SummarizationService {
  private readonly llmClient: ReturnType<typeof createDefaultLLMClient>;

  constructor() {
    this.llmClient = createDefaultLLMClient();
  }

  async summarizeSession(messages: ChatMessage[]): Promise<string> {
    if (messages.length === 0) {
      return "No messages in this session.";
    }

    // Build conversation transcript for summarization
    const transcript = messages
      .map((m) => {
        const role = m.role === "user" ? "User" : m.role === "assistant" ? "Assistant" : m.role === "system" ? "System" : "Tool";
        return `[${role}]: ${m.content}`;
      })
      .join("\n\n");

    // Truncate if too long (LLM context limits)
    const maxTranscriptLength = 100000; // ~100k characters
    const truncatedTranscript = transcript.length > maxTranscriptLength
      ? transcript.substring(0, maxTranscriptLength) + "\n\n[... transcript truncated ...]"
      : transcript;

    const prompt = `You are summarizing a chat conversation between a user and an AI agent. Provide a concise, high-level summary that captures:
1. The main topics discussed
2. Key decisions or outcomes
3. Any important context or preferences expressed
4. The overall purpose or goal of the conversation

Keep the summary under 500 words. Be factual and objective.

Conversation transcript:
${truncatedTranscript}

Summary:`;

    try {
      const response = await this.llmClient.chat({
        messages: [
          {
            role: "system",
            content: "You are a helpful assistant that summarizes conversations concisely.",
          },
          {
            role: "user",
            content: prompt,
          },
        ],
        maxTokens: 1000,
        temperature: 0.3,
      });

      log.info("Generated chat session summary", {
        messageCount: messages.length,
        summaryLength: response.content.length,
      });

      return response.content;
    } catch (error) {
      log.error("Failed to generate summary", {
        error: error instanceof Error ? error.message : String(error),
        messageCount: messages.length,
      });
      throw error;
    }
  }
}
