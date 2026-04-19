/**
 * Direct OpenAI-compatible planner — used by the local CLI and any caller
 * that wants to hit an OpenAI-shaped endpoint with a bearer API key
 * (OpenAI, OpenRouter, Azure OpenAI, Together, llama.cpp server, ...).
 *
 * Goes straight to {baseUrl}/chat/completions. No NyxID proxy, no delegation
 * token. The heavy lifting lives in `callOpenAICompletion` from
 * `openai-compat.ts`; this file only decides the URL and names the apiKey
 * option.
 */
import {
  callOpenAICompletion,
  type FetchLike,
  type PlannerResult,
} from "./openai-compat.ts";
import type { PlannerLanguage } from "./planner-prompt.ts";

export interface PlanDailyBriefWithOpenAIOptions {
  apiKey: string;
  /** Defaults to `https://api.openai.com/v1`. */
  baseUrl?: string;
  model: string;
  language?: PlannerLanguage;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

export async function planDailyBriefWithOpenAI(
  rawContent: string,
  opts: PlanDailyBriefWithOpenAIOptions,
): Promise<PlannerResult> {
  const baseUrl = (opts.baseUrl ?? "https://api.openai.com/v1").replace(
    /\/+$/,
    "",
  );
  const url = `${baseUrl}/chat/completions`;

  return callOpenAICompletion({
    url,
    apiKey: opts.apiKey,
    model: opts.model,
    rawContent,
    language: opts.language,
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs,
  });
}
