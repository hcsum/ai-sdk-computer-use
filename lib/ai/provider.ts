import { createAnthropic } from "@ai-sdk/anthropic";

/**
 * Anthropic provider with a configurable base URL so the app can run against
 * either the official API or an Anthropic-compatible relay (set
 * ANTHROPIC_BASE_URL, e.g. https://www.packyapi.ai).
 */
export const anthropicProvider = createAnthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  baseURL: process.env.ANTHROPIC_BASE_URL,
});

export const agentModel = anthropicProvider(
  process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5",
);
