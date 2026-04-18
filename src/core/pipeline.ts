/**
 * Pure pipeline: content → planned brief → HTML.
 *
 * No HTTP, no DB, no identity concept beyond "here is a userId". Callers
 * (HTTP route, CLI) inject a planner callback and receive a string of HTML
 * plus metadata. Storage is their problem.
 */
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { PlannerResult } from "../llm/gateway.ts";
import {
  type AestheticSpec,
  loadSpecs,
} from "../schema/aesthetic-spec.ts";
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
  /** Optional; when empty, the renderer suppresses the archive link. */
  ownerSlug?: string;
}

export interface GenerateResult {
  html: string;
  pageId: string;
  createdAt: string;
  brief: PlannerResult["brief"];
  fallbackReason?: PlannerResult["fallbackReason"];
  rawLLMOutput?: PlannerResult["rawLLMOutput"];
}

const __filename = fileURLToPath(import.meta.url);
// src/core/pipeline.ts → src/renderer/specs
const SPECS_DIR = join(__filename, "../../renderer/specs");

let _specsPromise: Promise<Map<string, AestheticSpec>> | null = null;

function getSpecs(): Promise<Map<string, AestheticSpec>> {
  if (_specsPromise === null) _specsPromise = loadSpecs(SPECS_DIR);
  return _specsPromise;
}

/** Test hook: reset spec cache. */
export function __resetSpecsForTesting(
  installed?: Map<string, AestheticSpec>,
): void {
  _specsPromise = installed ? Promise.resolve(installed) : null;
}

export class SpecNotFoundError extends Error {
  readonly specId: string;
  constructor(specId: string) {
    super(`Unknown spec_id: ${specId}`);
    this.name = "SpecNotFoundError";
    this.specId = specId;
  }
}

export async function generatePage(
  content: string,
  opts: GenerateOptions,
): Promise<GenerateResult> {
  const plan = await opts.planner(content);

  const specs = await getSpecs();
  const spec = specs.get(plan.brief.spec_id);
  if (!spec) throw new SpecNotFoundError(plan.brief.spec_id);

  const pageId = generatePageId();
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
