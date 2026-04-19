/**
 * Thin NyxID wrapper over `callOpenAICompletion`.
 *
 * Takes a raw content string + a short-lived NyxID delegation token, calls the
 * OpenAI-compatible chat/completions endpoint, and returns a Zod-validated
 * `DailyBrief`. See `openai-compat.ts` for the shared primitive.
 */

import { config } from "../config.ts";
import {
  callOpenAICompletion,
  type FetchLike,
  type PlannerResult,
} from "./openai-compat.ts";
import type { PlannerLanguage } from "./planner-prompt.ts";

export {
  PLANNER_SOFT_TIMEOUT_MS,
  PlannerTimeout,
  PlannerInvalidOutput,
  PlannerUpstreamError,
  PlannerRateLimited,
  type PlannerResult,
  type FetchLike,
} from "./openai-compat.ts";

/** Injectable deps, used by tests. Production callers pass nothing. */
export interface PlannerOptions {
  /** Override `fetch` for tests. */
  fetchImpl?: FetchLike;
  /** Override the soft timeout (ms). Primarily for tests. */
  timeoutMs?: number;
  /** Override the model from config. */
  model?: string;
  /** Override the base URL from config. */
  baseUrl?: string;
  /** Language for LLM-generated content. Defaults to 'en'. */
  language?: PlannerLanguage;
}

/**
 * Call the NyxID LLM Gateway to turn `rawContent` into a validated DailyBrief.
 *
 * @param rawContent       The user's raw daily brief text.
 * @param delegationToken  NyxID-injected delegation token (TTL 5 min).
 * @param options          Test injection hooks; omit in production.
 */
export async function planDailyBrief(
  rawContent: string,
  delegationToken: string,
  options: PlannerOptions = {},
): Promise<PlannerResult> {
  const model = options.model ?? config.NOCTURNE_PLANNER_MODEL;
  const baseUrl = options.baseUrl ?? config.NYXID_BASE_URL;
  const url = `${baseUrl.replace(/\/$/, "")}/api/v1/llm/gateway/v1/chat/completions`;

  return callOpenAICompletion({
    url,
    apiKey: delegationToken,
    model,
    rawContent,
    language: options.language,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
  });
}
