/**
 * `POST /format` — the write endpoint.
 *
 * Sits behind `nyxidAuth`, so the NyxID proxy has already verified identity
 * and is injecting:
 *   - `X-NyxID-User-Id`            — captured in `c.get('user_id')`
 *   - `X-NyxID-Identity-Token`     — verified by the middleware
 *   - `X-NyxID-Delegation-Token`   — NyxID's loaned token for calling the
 *     LLM Gateway back; if it isn't here, the service is misconfigured.
 *
 * Dual-write ordering (per DESIGN.md):
 *   nextSequence → generatePage(planner/spec/page_id/render) → chrono.putObject → supabase.insertPage
 *
 * Rationale: storage is cheap/expiring (chrono-storage is a blob bucket) but
 * the Postgres row is the authoritative index. If chrono succeeds and
 * Postgres fails we have an orphan blob — survivable, a janitor can clean it
 * up on `page_id` absence. If Postgres succeeds and chrono fails we have a
 * broken link that 500s on view — actively harmful.
 *
 * Error matrix (per DESIGN.md):
 *
 *   PlannerTimeout                  → 504 planner_timeout
 *   PlannerInvalidOutput (prod)     → 502 planner_invalid_output
 *   PlannerUpstreamError            → 502 planner_upstream_error
 *   PlannerRateLimited              → 502 planner_upstream_error (retry is
 *                                        caller's problem; we don't retry)
 *   StorageError{timeout|unavailable} → 502 storage_unavailable
 *   StorageError{integrity|not_found} → 500 storage_integrity_error
 *   IndexError{duplicate}           → 500 duplicate_page_id
 *   IndexError{timeout|…}           → 500 index_write_failed
 */
import { createHmac } from "node:crypto";

import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";

import { config } from "../config.ts";
import { nyxidAuth } from "../middleware/auth.ts";
import {
  PlannerInvalidOutput,
  PlannerRateLimited,
  PlannerTimeout,
  PlannerUpstreamError,
  planDailyBrief,
} from "../llm/gateway.ts";
import {
  generatePage,
  type GenerateResult,
  SpecNotFoundError,
  __resetSpecsForTesting as __resetPipelineSpecsForTesting,
} from "../core/pipeline.ts";
import * as chrono from "../storage/chrono.ts";
import * as supabase from "../index/supabase.ts";

// ---------------------------------------------------------------------------
// Request schema

const MAX_CONTENT_BYTES = 100 * 1024; // 100 KB

const FormatRequest = z.object({
  content: z
    .string()
    .min(1, "content must be non-empty")
    // Soft length check; `.length` is UTF-16 code units, close enough to bytes
    // for a guardrail. The LLM soft-timeout will catch anything slipping past.
    .refine(
      (s) => s.length * 2 <= MAX_CONTENT_BYTES,
      `content must be at most ${MAX_CONTENT_BYTES} bytes`,
    ),
});

type FormatRequestBody = z.infer<typeof FormatRequest>;

// ---------------------------------------------------------------------------
// Re-export so format.test.ts's existing hook keeps working.
export const __resetSpecsForTesting = __resetPipelineSpecsForTesting;

// ---------------------------------------------------------------------------
// Owner slug derivation.
//
// The chrome zone optionally links to `/u/{owner_slug}` — the user's archive.
// We don't want to leak the raw NyxID user UUID into HTML, so we HMAC it with
// the service secret and truncate to 16 hex chars (~64 bits, plenty for a
// non-enumeration identifier). Deterministic per user: two briefs from the
// same user produce the same owner_slug, which is exactly what we want for
// "all your Nocturnes" to mean something.

function ownerSlugFor(userId: string): string {
  return createHmac("sha256", config.NYXID_SERVICE_SECRET)
    .update(userId, "utf8")
    .digest("hex")
    .slice(0, 16);
}

// ---------------------------------------------------------------------------
// Router

export const formatRouter = new Hono();

formatRouter.post("/format", nyxidAuth, async (c) => {
  const user_id = c.get("user_id");
  if (!user_id) {
    // nyxidAuth guarantees a value on success; belt-and-braces for the
    // "someone forgot the middleware" refactor.
    return c.json({ error: "missing_identity" }, 401);
  }

  // Delegation token is injected by the NyxID proxy when this service is
  // configured with `inject_delegation_token=true`. If it's missing, the
  // upstream config is broken and we cannot call the LLM Gateway.
  const delegationToken = c.req.header("x-nyxid-delegation-token");
  if (!delegationToken) {
    return c.json({ error: "missing_delegation_token" }, 500);
  }

  // --- Body validation ------------------------------------------------------
  let body: FormatRequestBody;
  try {
    const raw: unknown = await c.req.json();
    const parsed = FormatRequest.safeParse(raw);
    if (!parsed.success) {
      return c.json(
        { error: "invalid_request", issues: parsed.error.issues },
        400,
      );
    }
    body = parsed.data;
  } catch {
    // c.req.json() throws on malformed body
    return c.json({ error: "invalid_request" }, 400);
  }

  // --- Monotonic per-user sequence ------------------------------------------
  // Allocated before the planner runs; a planner failure consumes a number
  // and produces a gap. `seq` is display-only ("Issue #N"), not a contiguity
  // guarantee, so gaps are acceptable — don't "fix" this back to planner-first.
  let seq: number;
  try {
    seq = await supabase.nextSequence(user_id);
  } catch (err) {
    return indexErrorResponse(c, err);
  }

  const owner_slug = ownerSlugFor(user_id);

  // --- Pipeline: planner → spec → render ------------------------------------
  let generated: GenerateResult;
  try {
    generated = await generatePage(body.content, {
      planner: (content) => planDailyBrief(content, delegationToken),
      model: config.NOCTURNE_PLANNER_MODEL,
      userId: user_id,
      seq,
      ownerSlug: owner_slug,
      pageIdBytes: config.PAGE_ID_BYTES,
    });
  } catch (err) {
    if (err instanceof SpecNotFoundError) {
      return c.json({ error: "spec_not_found" }, 500);
    }
    // All planner errors (PlannerTimeout/InvalidOutput/UpstreamError/RateLimited)
    // bubble from generatePage since the planner callback doesn't wrap them.
    return plannerErrorResponse(c, err);
  }

  const { html, pageId: page_id } = generated;
  const storage_key = `${user_id}/${page_id}.html`;

  // --- Storage write (blob first, then index) -------------------------------
  try {
    await chrono.putObject(
      config.CHRONO_STORAGE_BUCKET,
      storage_key,
      html,
      "text/html; charset=utf-8",
    );
  } catch (err) {
    return storageErrorResponse(c, err);
  }

  // --- Index write (authoritative) ------------------------------------------
  try {
    await supabase.insertPage({
      page_id,
      user_id,
      storage_key,
      spec_id: generated.brief.spec_id,
      content_type: "daily_brief_v1",
    });
  } catch (err) {
    return indexErrorResponse(c, err);
  }

  // --- Planner fallback logging (soft-failure — never derails the happy
  // path) ------------------------------------------------------------------
  if (generated.fallbackReason) {
    try {
      await supabase.logPlannerFallback(
        page_id,
        generated.fallbackReason,
        generated.rawLLMOutput ?? null,
      );
    } catch {
      // Fallback logging failures are not user-facing. The primary writes
      // already succeeded; a missed debug row isn't worth a 500 to the
      // client. We intentionally don't re-throw.
    }
  }

  return c.json({ url: `${config.BASE_URL}/v/${page_id}` }, 200);
});

// ---------------------------------------------------------------------------
// Error mappers

function plannerErrorResponse(c: Context, err: unknown) {
  if (err instanceof PlannerTimeout) {
    return c.json({ error: "planner_timeout" }, 504);
  }
  if (err instanceof PlannerInvalidOutput) {
    // In production we do NOT leak the raw LLM output to the caller —
    // it may contain their content verbatim. The debug fields stay in
    // the fallback log (not written on hard failure, but still in logs).
    return c.json({ error: "planner_invalid_output" }, 502);
  }
  if (err instanceof PlannerUpstreamError) {
    return c.json({ error: "planner_upstream_error" }, 502);
  }
  if (err instanceof PlannerRateLimited) {
    return c.json({ error: "planner_upstream_error" }, 502);
  }
  // Unexpected — let it surface as 500.
  throw err;
}

function storageErrorResponse(c: Context, err: unknown) {
  if (err instanceof chrono.StorageError) {
    if (err.code === "timeout" || err.code === "unavailable") {
      return c.json({ error: "storage_unavailable" }, 502);
    }
    // not_found on PUT means the bucket isn't provisioned; integrity means
    // the upstream returned a malformed envelope. Both are ours to fix.
    return c.json({ error: "storage_integrity_error" }, 500);
  }
  throw err;
}

function indexErrorResponse(c: Context, err: unknown) {
  if (err instanceof supabase.IndexError) {
    if (err.code === "duplicate") {
      return c.json({ error: "duplicate_page_id" }, 500);
    }
    return c.json({ error: "index_write_failed" }, 500);
  }
  throw err;
}
