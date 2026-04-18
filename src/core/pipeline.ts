/**
 * Pure pipeline: content → planned brief → HTML.
 *
 * No HTTP, no DB, no identity concept beyond "here is a userId". Callers
 * (HTTP route, CLI) inject a planner callback and receive a string of HTML
 * plus metadata. Storage is their problem.
 *
 * Spec loading: v0 specs are imported via JSON import attributes so
 * `bun build --compile` embeds them into the single-binary artifact. Do NOT
 * reintroduce `fs.readdir` here — the archive's __dirname is not a real
 * directory at runtime. See src/routes/format.ts for the prior fix.
 */
import type { PlannerResult } from "../llm/gateway.ts";
import {
  type AestheticSpec,
  AestheticSpecSchema,
} from "../schema/aesthetic-spec.ts";
import executiveBroadsheetSpec from "../renderer/specs/executive-broadsheet.json" with { type: "json" };
import quietLedgerSpec from "../renderer/specs/quiet-ledger.json" with { type: "json" };
import gujiClassicalSpec from "../renderer/specs/guji-classical.json" with { type: "json" };
import { renderPage } from "../renderer/render-page.tsx";
import { generatePageId } from "../utils/slug.ts";

export type Planner = (rawContent: string) => Promise<PlannerResult>;

export interface GenerateOptions {
  planner: Planner;
  model: string;
  userId: string;
  seq: number;
  /** Override for determinism in tests. Defaults to `new Date().toISOString()`. */
  createdAt?: string;
  /** Omit or pass empty string to suppress the archive link in the page chrome. */
  ownerSlug?: string;
  /** Entropy for the generated page_id (bytes). Defaults to the slug module's built-in. */
  pageIdBytes?: number;
}

export interface GenerateResult {
  html: string;
  pageId: string;
  createdAt: string;
  brief: PlannerResult["brief"];
  fallbackReason?: PlannerResult["fallbackReason"];
  rawLLMOutput?: PlannerResult["rawLLMOutput"];
}

export class SpecNotFoundError extends Error {
  readonly specId: string;
  constructor(specId: string) {
    super(`Unknown spec_id: ${specId}`);
    this.name = "SpecNotFoundError";
    this.specId = specId;
  }
}

// ---------------------------------------------------------------------------
// Spec cache — mirrors src/routes/format.ts. Compile-binary safe.

const V0_RAW_SPECS: unknown[] = [
  executiveBroadsheetSpec,
  quietLedgerSpec,
  gujiClassicalSpec,
];

function buildV0Specs(): Map<string, AestheticSpec> {
  const map = new Map<string, AestheticSpec>();
  for (const raw of V0_RAW_SPECS) {
    const parsed = AestheticSpecSchema.parse(raw);
    map.set(parsed.id, parsed);
  }
  return map;
}

let _specsPromise: Promise<Map<string, AestheticSpec>> | null = null;

function getSpecs(): Promise<Map<string, AestheticSpec>> {
  if (_specsPromise === null) {
    _specsPromise = Promise.resolve(buildV0Specs());
  }
  return _specsPromise;
}

/** Test hook: reset the cache so tests can install a stub spec set. */
export function __resetSpecsForTesting(
  installed?: Map<string, AestheticSpec>,
): void {
  _specsPromise = installed ? Promise.resolve(installed) : null;
}

// ---------------------------------------------------------------------------
// Entry point

export async function generatePage(
  content: string,
  opts: GenerateOptions,
): Promise<GenerateResult> {
  const plan = await opts.planner(content);

  const specs = await getSpecs();
  const spec = specs.get(plan.brief.spec_id);
  if (!spec) throw new SpecNotFoundError(plan.brief.spec_id);

  const pageId = generatePageId(opts.pageIdBytes);
  const createdAt = opts.createdAt ?? new Date().toISOString();

  const html = renderPage(plan.brief, spec, {
    user_id: opts.userId,
    seq: opts.seq,
    page_id: pageId,
    created_at: createdAt,
    model: opts.model,
    owner_slug: opts.ownerSlug ?? "",
  });

  return {
    html,
    pageId,
    createdAt,
    brief: plan.brief,
    fallbackReason: plan.fallbackReason,
    rawLLMOutput: plan.rawLLMOutput,
  };
}
