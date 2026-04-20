import { z } from "zod";

import { DailyBriefBlock, type DailyBrief } from "../schema/daily-brief.ts";
import {
  buildSystemPrompt,
  buildUserPrompt,
  type PlannerLanguage,
} from "./planner-prompt.ts";

/** Soft timeout for the planner call, in ms. */
export const PLANNER_SOFT_TIMEOUT_MS = 45_000;

/** Thrown when the gateway call exceeds the soft timeout. */
export class PlannerTimeout extends Error {
  constructor(message = "Planner call exceeded soft timeout") {
    super(message);
    this.name = "PlannerTimeout";
  }
}

/** Thrown when the LLM returned content that is not valid JSON or fails schema. */
export class PlannerInvalidOutput extends Error {
  readonly rawResponse: string;
  readonly issues?: z.ZodIssue[];

  constructor(
    message: string,
    rawResponse: string,
    issues?: z.ZodIssue[],
  ) {
    super(message);
    this.name = "PlannerInvalidOutput";
    this.rawResponse = rawResponse;
    this.issues = issues;
  }
}

/** Thrown when the upstream gateway returned a non-200 response (other than 429). */
export class PlannerUpstreamError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string) {
    super(`Planner upstream returned HTTP ${status}`);
    this.name = "PlannerUpstreamError";
    this.status = status;
    this.body = body;
  }
}

/** Thrown when the upstream gateway rate-limited us (HTTP 429). */
export class PlannerRateLimited extends Error {
  readonly retryAfter?: string;
  readonly body: string;

  constructor(body: string, retryAfter?: string) {
    super("Planner upstream rate-limited the request");
    this.name = "PlannerRateLimited";
    this.body = body;
    this.retryAfter = retryAfter;
  }
}

const ChatCompletionResponse = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.string(),
        }),
      }),
    )
    .min(1),
});

export interface PlannerResult {
  brief: DailyBrief;
  fallbackReason?: "invalid_spec_id";
  rawLLMOutput?: unknown;
}

/**
 * Minimum fetch shape we actually use. Narrower than `typeof fetch` so tests
 * can pass a plain async function without implementing Bun's extra methods
 * (e.g. `preconnect`).
 */
export type FetchLike = (
  url: string,
  init: RequestInit,
) => Promise<Response>;

export interface OpenAICompletionCall {
  url: string;
  apiKey: string;
  model: string;
  rawContent: string;
  language?: PlannerLanguage;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

export async function callOpenAICompletion(
  call: OpenAICompletionCall,
): Promise<PlannerResult> {
  const fetchImpl = call.fetchImpl ?? fetch;
  const timeoutMs = call.timeoutMs ?? PLANNER_SOFT_TIMEOUT_MS;

  const body = {
    model: call.model,
    messages: [
      { role: "system", content: buildSystemPrompt({ language: call.language }) },
      { role: "user", content: buildUserPrompt(call.rawContent) },
    ],
    response_format: { type: "json_object" as const },
  };

  let response: Response;
  try {
    response = await fetchImpl(call.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${call.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (isAbortError(err)) {
      throw new PlannerTimeout(
        `Planner call exceeded soft timeout of ${timeoutMs}ms`,
      );
    }
    throw err;
  }

  if (response.status === 429) {
    const body = await safeReadText(response);
    throw new PlannerRateLimited(
      body,
      response.headers.get("retry-after") ?? undefined,
    );
  }
  if (!response.ok) {
    const body = await safeReadText(response);
    throw new PlannerUpstreamError(response.status, body);
  }

  const envelopeUnknown = await response.json().catch((err: unknown) => {
    throw new PlannerInvalidOutput(
      `Upstream returned non-JSON envelope: ${stringifyError(err)}`,
      "",
    );
  });

  const envelope = ChatCompletionResponse.safeParse(envelopeUnknown);
  if (!envelope.success) {
    throw new PlannerInvalidOutput(
      "Upstream envelope did not match OpenAI chat-completions shape",
      JSON.stringify(envelopeUnknown),
      envelope.error.issues,
    );
  }

  const rawContentStr = envelope.data.choices[0]!.message.content;

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawContentStr);
  } catch (err) {
    throw new PlannerInvalidOutput(
      `Planner returned non-JSON content: ${stringifyError(err)}`,
      rawContentStr,
    );
  }

  const strict = DailyBriefBlock.safeParse(parsedJson);
  if (strict.success) return { brief: strict.data };

  if (isSpecIdOnlyFailure(strict.error, parsedJson)) {
    const patched = {
      ...(parsedJson as Record<string, unknown>),
      spec_id: "executive-broadsheet",
    };
    const retry = DailyBriefBlock.safeParse(patched);
    if (retry.success) {
      return {
        brief: retry.data,
        fallbackReason: "invalid_spec_id",
        rawLLMOutput: parsedJson,
      };
    }
  }

  throw new PlannerInvalidOutput(
    "Planner output failed daily_brief_v1 schema validation",
    rawContentStr,
    strict.error.issues,
  );
}

function isAbortError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === "AbortError") return true;
  if (
    err instanceof Error &&
    (err.name === "AbortError" || err.name === "TimeoutError")
  ) {
    return true;
  }
  return false;
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function stringifyError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * True iff the only schema failure is that `spec_id` is not one of the three
 * allowed enum values. In that case we know the substitution is safe — the
 * rest of the object is shaped correctly.
 */
function isSpecIdOnlyFailure(
  error: z.ZodError,
  parsedJson: unknown,
): boolean {
  if (typeof parsedJson !== "object" || parsedJson === null) return false;
  if (error.issues.length === 0) return false;
  return error.issues.every((issue) => {
    return issue.path.length === 1 && issue.path[0] === "spec_id";
  });
}
