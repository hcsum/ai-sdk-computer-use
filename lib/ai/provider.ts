import { createAnthropic } from "@ai-sdk/anthropic";

/**
 * Anthropic provider with a configurable base URL so the app can run against
 * either the official API or an Anthropic-compatible relay.
 *
 * The default `anthropic` export cannot be redirected: it resolves its base URL
 * at module load and never reads ANTHROPIC_BASE_URL. Note the base URL must
 * include the `/v1` segment — requests are built as `${baseURL}/messages`.
 */
export const anthropicProvider = createAnthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  baseURL: process.env.ANTHROPIC_BASE_URL,
});

export const agentModel = anthropicProvider(
  process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5",
);
