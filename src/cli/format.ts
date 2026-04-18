#!/usr/bin/env bun
/**
 * Local CLI — two responsibilities:
 *
 *   nocturne-format              # render raw content (stdin or --in)
 *   nocturne-format status       # show auth / provider resolution
 *
 * Planner source resolution (format path):
 *
 *   1. NyxID (~/.nyxid/ tokens) + `/api/v1/llm/status` shows ≥1 ready
 *      provider → use `{gateway_url}/chat/completions` with the bearer.
 *   2. Fallback: `NOCTURNE_OPENAI_API_KEY` → direct OpenAI-compatible call.
 *   3. Neither → error with a hint pointing at both paths.
 *
 * The user logs in via the separate `nyxid` CLI; Nocturne only consumes
 * tokens. No login/logout subcommands here.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import { generatePage, SpecNotFoundError } from "../core/pipeline.ts";
import {
  PlannerInvalidOutput,
  PlannerRateLimited,
  PlannerTimeout,
  PlannerUpstreamError,
} from "../llm/openai-compat.ts";
import { planDailyBriefWithOpenAI } from "../llm/openai.ts";
import { loadLocalConfig, LocalConfigError } from "./config.ts";
import {
  NyxIDStatusError,
  readNyxIDTokens,
  resolveNyxIDGateway,
  type NyxIDTokens,
} from "./nyxid-auth.ts";

export interface Args {
  subcommand?: "status";
  inPath?: string;
  outPath?: string;
  outDir?: string;
  help?: boolean;
}

export class ArgsError extends Error {}

const SUBCOMMANDS = new Set(["status"]);

/**
 * Pure arg parser — throws `ArgsError` on malformed input, returns `Args`.
 * Flag-taking options require a non-flag value after them; missing values
 * fail loudly rather than silently falling back to stdin / defaults.
 */
export function parseArgs(argv: string[]): Args {
  const a: Args = {};
  let i = 0;

  // First positional token, if it's a known subcommand, consumes one slot.
  if (argv.length > 0 && SUBCOMMANDS.has(argv[0]!)) {
    a.subcommand = argv[0] as Args["subcommand"];
    i = 1;
  }

  for (; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--in" || v === "--out" || v === "--out-dir") {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("-")) {
        throw new ArgsError(`${v} requires a path`);
      }
      i++;
      if (v === "--in") a.inPath = next;
      else if (v === "--out") a.outPath = next;
      else a.outDir = next;
    } else if (v === "-h" || v === "--help") {
      a.help = true;
    } else {
      throw new ArgsError(`unknown arg: ${v}`);
    }
  }
  return a;
}

function printHelp(): void {
  process.stdout.write(`nocturne-format — render raw content to an HTML page.

Usage:
  echo "..." | nocturne-format
  nocturne-format --in content.md
  nocturne-format --in content.md --out ./page.html
  nocturne-format --out-dir ./pages
  nocturne-format status                    # show auth / provider state

Auth:
  Preferred  — run \`nyxid login\` once; Nocturne reads ~/.nyxid/ tokens
               and routes through the NyxID LLM gateway.
  Fallback   — export NOCTURNE_OPENAI_API_KEY for direct OpenAI access.

Env vars:
  NOCTURNE_OPENAI_API_KEY   (fallback; optional if NyxID is configured)
  NOCTURNE_OPENAI_BASE_URL  (default: https://api.openai.com/v1)
  NOCTURNE_OPENAI_MODEL     (default: gpt-4o-mini; in NyxID mode the
                             gateway routes by prefix — gpt-*, claude-*, ...)
  NOCTURNE_OUT_DIR          (default: ./out)
`);
}

function fail(msg: string): never {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(1);
}

async function readInput(inPath: string | undefined): Promise<string> {
  if (inPath) {
    return readFileSync(inPath, "utf8");
  }
  const chunks: Uint8Array[] = [];
  for await (const chunk of Bun.stdin.stream()) {
    chunks.push(chunk);
  }
  const totalLen = chunks.reduce((n, c) => n + c.byteLength, 0);
  const buf = new Uint8Array(totalLen);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder().decode(buf);
}

function resolveOutPath(args: Args, defaultDir: string, pageId: string): string {
  if (args.outPath) {
    return isAbsolute(args.outPath) ? args.outPath : resolve(args.outPath);
  }
  const dir = args.outDir ?? defaultDir;
  const absDir = isAbsolute(dir) ? dir : resolve(dir);
  mkdirSync(absDir, { recursive: true });
  return resolve(absDir, `${pageId}.html`);
}

// ---------------------------------------------------------------------------
// Planner source resolution

interface PlannerSource {
  label: "nyxid" | "openai";
  apiKey: string;
  baseUrl: string;
  model: string;
}

/**
 * Pick which planner source to use for a format invocation.
 *
 * Returns the chosen `PlannerSource` plus any user-facing warnings
 * collected while trying preferred paths (so the caller can `stderr`
 * them without failing).
 */
async function pickPlannerSource(
  tokens: NyxIDTokens | null,
  env: { apiKey: string | undefined; model: string; baseUrl: string },
): Promise<{ source: PlannerSource; warnings: string[] }> {
  const warnings: string[] = [];

  if (tokens !== null) {
    try {
      const gateway = await resolveNyxIDGateway(tokens);
      return {
        source: {
          label: "nyxid",
          apiKey: tokens.accessToken,
          baseUrl: gateway.gatewayUrl,
          model: env.model,
        },
        warnings,
      };
    } catch (err) {
      if (err instanceof NyxIDStatusError) {
        warnings.push(`NyxID path unavailable: ${err.message}`);
      } else {
        warnings.push(
          `NyxID path errored unexpectedly: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      // fall through to OpenAI path
    }
  }

  if (env.apiKey !== undefined) {
    return {
      source: {
        label: "openai",
        apiKey: env.apiKey,
        baseUrl: env.baseUrl,
        model: env.model,
      },
      warnings,
    };
  }

  fail(
    [
      "no planner source available.",
      "Either:",
      "  - run `nyxid login` (then configure an LLM provider on the NyxID dashboard), or",
      "  - export NOCTURNE_OPENAI_API_KEY=sk-...",
      ...(warnings.length > 0
        ? ["", "Previously attempted:", ...warnings.map((w) => `  · ${w}`)]
        : []),
    ].join("\n"),
  );
}

// ---------------------------------------------------------------------------
// Subcommand: status

function runStatus(
  tokens: NyxIDTokens | null,
  env: { apiKey: string | undefined },
): Promise<void> {
  return (async () => {
    const lines: string[] = [];
    lines.push("Nocturne CLI auth status");
    lines.push("");

    if (tokens === null) {
      lines.push("  NyxID          : not logged in (run `nyxid login`)");
    } else {
      lines.push(`  NyxID base_url : ${tokens.baseUrl}`);
      try {
        const gateway = await resolveNyxIDGateway(tokens);
        lines.push(`  NyxID gateway  : ${gateway.gatewayUrl}`);
        lines.push(
          `  ready providers: ${gateway.readyProviders.join(", ")}`,
        );
      } catch (err) {
        if (err instanceof NyxIDStatusError) {
          lines.push(`  NyxID status   : ${err.hint} — ${err.message}`);
        } else {
          lines.push(
            `  NyxID status   : errored (${err instanceof Error ? err.message : String(err)})`,
          );
        }
      }
    }

    lines.push(
      `  OpenAI API key : ${env.apiKey === undefined ? "not set" : "set (fallback)"}`,
    );

    process.stdout.write(`${lines.join("\n")}\n`);
  })();
}

// ---------------------------------------------------------------------------
// Main

async function main(): Promise<void> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    if (err instanceof ArgsError) fail(err.message);
    throw err;
  }
  if (args.help) {
    printHelp();
    process.exit(0);
  }

  let cfg;
  try {
    cfg = loadLocalConfig(process.env);
  } catch (err) {
    if (err instanceof LocalConfigError) fail(err.message);
    throw err;
  }

  const tokens = readNyxIDTokens();

  if (args.subcommand === "status") {
    await runStatus(tokens, { apiKey: cfg.apiKey });
    return;
  }

  const content = (await readInput(args.inPath)).trim();
  if (!content) fail("empty input");

  const { source, warnings } = await pickPlannerSource(tokens, {
    apiKey: cfg.apiKey,
    baseUrl: cfg.baseUrl,
    model: cfg.model,
  });
  for (const w of warnings) process.stderr.write(`warning: ${w}\n`);

  let generated;
  try {
    generated = await generatePage(content, {
      planner: (c) =>
        planDailyBriefWithOpenAI(c, {
          apiKey: source.apiKey,
          baseUrl: source.baseUrl,
          model: source.model,
        }),
      model: source.model,
      userId: "local",
      seq: 1,
      // ownerSlug intentionally omitted — suppresses the archive link.
    });
  } catch (err) {
    if (err instanceof PlannerTimeout) fail("planner timed out");
    if (err instanceof PlannerRateLimited) fail("planner rate-limited");
    if (err instanceof PlannerUpstreamError)
      fail(`planner upstream HTTP ${err.status}: ${err.body.slice(0, 200)}`);
    if (err instanceof PlannerInvalidOutput)
      fail(`planner returned invalid output: ${err.message}`);
    if (err instanceof SpecNotFoundError) fail(`unknown spec_id: ${err.specId}`);
    throw err;
  }

  const outPath = resolveOutPath(args, cfg.outDir, generated.pageId);
  writeFileSync(outPath, generated.html, "utf8");
  process.stdout.write(`${outPath}\n`);
}

if (import.meta.main) {
  main().catch((err) => {
    process.stderr.write(
      `error: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  });
}
