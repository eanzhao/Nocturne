#!/usr/bin/env bun
/**
 * Local CLI:
 *
 *   cat content.md | bun run format                       # stdin → ./out
 *   bun run format --in content.md                        # file → ./out
 *   bun run format --in content.md --out ./page.html      # explicit path
 *   bun run format --out-dir ./my-pages                   # override out dir
 *
 * Writes ONE HTML file and prints its absolute path on stdout. Errors go
 * to stderr with a non-zero exit code.
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

interface Args {
  inPath?: string;
  outPath?: string;
  outDir?: string;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--in") {
      a.inPath = argv[++i];
    } else if (v === "--out") {
      a.outPath = argv[++i];
    } else if (v === "--out-dir") {
      a.outDir = argv[++i];
    } else if (v === "-h" || v === "--help") {
      printHelp();
      process.exit(0);
    } else {
      fail(`unknown arg: ${v}`);
    }
  }
  return a;
}

function printHelp(): void {
  process.stdout.write(`nocturne format — render raw content to an HTML page.

Usage:
  echo "..." | bun run format
  bun run format --in content.md
  bun run format --in content.md --out ./page.html
  bun run format --out-dir ./pages

Env vars (see .env.example):
  NOCTURNE_OPENAI_API_KEY   (required)
  NOCTURNE_OPENAI_BASE_URL  (default: https://api.openai.com/v1)
  NOCTURNE_OPENAI_MODEL     (default: gpt-4o-mini)
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

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  let cfg;
  try {
    cfg = loadLocalConfig(process.env);
  } catch (err) {
    if (err instanceof LocalConfigError) fail(err.message);
    throw err;
  }

  const content = (await readInput(args.inPath)).trim();
  if (!content) fail("empty input");

  let generated;
  try {
    generated = await generatePage(content, {
      planner: (c) =>
        planDailyBriefWithOpenAI(c, {
          apiKey: cfg.apiKey,
          baseUrl: cfg.baseUrl,
          model: cfg.model,
        }),
      model: cfg.model,
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

main().catch((err) => {
  process.stderr.write(
    `error: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
