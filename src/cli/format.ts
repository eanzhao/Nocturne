#!/usr/bin/env bun
/**
 * Local CLI:
 *
 *   nocturne-format                    # format stdin → HTML
 *   nocturne-format status             # show auth / provider resolution
 *   nocturne-format config list        # show effective config + source
 *   nocturne-format config get <key>   # print one value
 *   nocturne-format config set <key> <value>   # persist to config file
 *   nocturne-format config unset <key>          # remove from config file
 *
 * Planner source resolution (format path):
 *   1. NyxID (~/.nyxid/ tokens) + /api/v1/llm/status → gateway
 *   2. Fallback: NOCTURNE_OPENAI_API_KEY (env or config file) → direct OpenAI
 *   3. Neither → error with hints
 *
 * Login lives in the separate `nyxid` CLI.
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
import {
  loadLocalConfig,
  LocalConfigError,
  type ConfigSource,
  type LocalConfig,
} from "./config.ts";
import {
  CONFIG_KEYS,
  ConfigFileError,
  type ConfigKey,
  configFilePath,
  configFilePermSummary,
  readConfigFile,
  writeConfigFile,
} from "./config-file.ts";
import {
  NyxIDStatusError,
  readNyxIDTokens,
  resolveNyxIDGateway,
  type NyxIDTokens,
} from "./nyxid-auth.ts";

export type Subcommand =
  | { kind: "format" }
  | { kind: "status" }
  | { kind: "config-list" }
  | { kind: "config-get"; key: ConfigKey }
  | { kind: "config-set"; key: ConfigKey; value: string }
  | { kind: "config-unset"; key: ConfigKey };

export interface Args {
  subcommand: Subcommand;
  inPath?: string;
  outPath?: string;
  outDir?: string;
  help?: boolean;
}

export class ArgsError extends Error {}

function parseConfigKey(raw: string | undefined): ConfigKey {
  if (raw === undefined) {
    throw new ArgsError(
      `config: expected a key (${CONFIG_KEYS.join(", ")})`,
    );
  }
  // Accept both kebab and snake; users type either.
  const normalized = raw.replace(/-/g, "_");
  if (!(CONFIG_KEYS as readonly string[]).includes(normalized)) {
    throw new ArgsError(
      `config: unknown key "${raw}" — valid: ${CONFIG_KEYS.join(", ")}`,
    );
  }
  return normalized as ConfigKey;
}

/**
 * Parse argv. Shape:
 *   []                                   → format, stdin
 *   ["status"]                           → status
 *   ["config", "list"]                   → config-list
 *   ["config", "get", "<k>"]             → config-get
 *   ["config", "set", "<k>", "<v>"]      → config-set
 *   ["config", "unset", "<k>"]           → config-unset
 *   [...flags]                           → format with flags
 */
export function parseArgs(argv: string[]): Args {
  if (argv[0] === "status") {
    if (argv.length > 1) {
      throw new ArgsError(`status: unexpected extra arg "${argv[1]}"`);
    }
    return { subcommand: { kind: "status" } };
  }

  if (argv[0] === "config") {
    const action = argv[1];
    switch (action) {
      case undefined:
        throw new ArgsError(
          "config: expected `list`, `get`, `set`, or `unset`",
        );
      case "list":
        if (argv.length > 2) {
          throw new ArgsError(`config list: unexpected extra arg "${argv[2]}"`);
        }
        return { subcommand: { kind: "config-list" } };
      case "get": {
        const key = parseConfigKey(argv[2]);
        if (argv.length > 3) {
          throw new ArgsError(
            `config get: unexpected extra arg "${argv[3]}"`,
          );
        }
        return { subcommand: { kind: "config-get", key } };
      }
      case "set": {
        const key = parseConfigKey(argv[2]);
        const value = argv[3];
        if (value === undefined) {
          throw new ArgsError(`config set: expected a value for "${argv[2]}"`);
        }
        if (argv.length > 4) {
          throw new ArgsError(
            `config set: unexpected extra arg "${argv[4]}"`,
          );
        }
        return { subcommand: { kind: "config-set", key, value } };
      }
      case "unset": {
        const key = parseConfigKey(argv[2]);
        if (argv.length > 3) {
          throw new ArgsError(
            `config unset: unexpected extra arg "${argv[3]}"`,
          );
        }
        return { subcommand: { kind: "config-unset", key } };
      }
      default:
        throw new ArgsError(
          `config: unknown action "${action}" — valid: list, get, set, unset`,
        );
    }
  }

  const a: Args = { subcommand: { kind: "format" } };
  for (let i = 0; i < argv.length; i++) {
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
  nocturne-format --in content.md [--out ./page.html | --out-dir ./pages]
  nocturne-format status                    # auth / provider state
  nocturne-format config list               # effective config + source
  nocturne-format config set <key> <value>  # persist to config file
  nocturne-format config get <key>
  nocturne-format config unset <key>

Keys (config): ${CONFIG_KEYS.join(", ")}

Auth:
  Preferred  — run \`nyxid login\`; Nocturne reads ~/.nyxid/ tokens and
               routes through the NyxID LLM gateway.
  Fallback   — set api-key via \`nocturne-format config set api-key sk-...\`
               or export NOCTURNE_OPENAI_API_KEY in your shell / op.env.

Env vars (override config file):
  NOCTURNE_OPENAI_API_KEY
  NOCTURNE_OPENAI_BASE_URL  (default: https://api.openai.com/v1)
  NOCTURNE_OPENAI_MODEL     (default: gpt-4o-mini; NyxID routes by prefix —
                             gpt-*, claude-*, deepseek-*, gemini-*)
  NOCTURNE_OUT_DIR          (default: ./out)
`);
}

function fail(msg: string): never {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(1);
}

async function readInput(inPath: string | undefined): Promise<string> {
  if (inPath) return readFileSync(inPath, "utf8");
  const chunks: Uint8Array[] = [];
  for await (const chunk of Bun.stdin.stream()) chunks.push(chunk);
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
      "  - run `nocturne-format config set api-key sk-...`, or",
      "  - export NOCTURNE_OPENAI_API_KEY=sk-...",
      ...(warnings.length > 0
        ? ["", "Previously attempted:", ...warnings.map((w) => `  · ${w}`)]
        : []),
    ].join("\n"),
  );
}

// ---------------------------------------------------------------------------
// Subcommands

function mask(value: string | undefined): string {
  if (value === undefined) return "<unset>";
  if (value.length <= 4) return "****";
  return `****${value.slice(-4)}`;
}

function fmtValue(key: ConfigKey, value: string | undefined): string {
  if (value === undefined) return "<unset>";
  if (key === "api_key") return mask(value);
  return value;
}

function runConfigList(cfg: LocalConfig): void {
  const rows: [string, string, string][] = [
    ["model", fmtValue("model", cfg.model), cfg.sources.model],
    ["base_url", fmtValue("base_url", cfg.baseUrl), cfg.sources.base_url],
    ["out_dir", fmtValue("out_dir", cfg.outDir), cfg.sources.out_dir],
    ["api_key", fmtValue("api_key", cfg.apiKey), cfg.sources.api_key],
  ];
  const keyW = Math.max(...rows.map((r) => r[0].length));
  const valW = Math.max(...rows.map((r) => r[1].length));
  const header = `${"KEY".padEnd(keyW)}  ${"VALUE".padEnd(valW)}  SOURCE`;
  const perm = configFilePermSummary();
  process.stdout.write(
    [
      `Nocturne config (${configFilePath()}${perm === null ? ", missing" : `, mode ${perm}`})`,
      "",
      header,
      ...rows.map(
        ([k, v, s]) => `${k.padEnd(keyW)}  ${v.padEnd(valW)}  ${s}`,
      ),
      "",
    ].join("\n"),
  );
}

function runConfigGet(cfg: LocalConfig, key: ConfigKey): void {
  const val =
    key === "model"
      ? cfg.model
      : key === "base_url"
        ? cfg.baseUrl
        : key === "out_dir"
          ? cfg.outDir
          : cfg.apiKey;
  if (val === undefined) {
    process.exit(1);
  }
  process.stdout.write(`${val}\n`);
}

function runConfigSet(key: ConfigKey, value: string): void {
  // Light validation — the schema's main job is at read time, but catching
  // bad URLs here gives a friendlier error than re-failing next invocation.
  if (key === "base_url") {
    try {
      new URL(value);
    } catch {
      fail(`config set: base_url must be a valid URL, got "${value}"`);
    }
  }
  writeConfigFile({ [key]: value });
  const suffix = key === "api_key" ? ` (masked: ${mask(value)})` : ` = ${value}`;
  process.stdout.write(
    `wrote ${configFilePath()}: ${key}${suffix}\n`,
  );
}

function runConfigUnset(key: ConfigKey): void {
  writeConfigFile({ [key]: undefined });
  process.stdout.write(
    `removed ${key} from ${configFilePath()}\n`,
  );
}

async function runStatus(
  tokens: NyxIDTokens | null,
  env: { apiKey: string | undefined; apiKeySource: ConfigSource },
): Promise<void> {
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

  const keyDisplay =
    env.apiKey === undefined
      ? "not set"
      : `set via ${env.apiKeySource} (${mask(env.apiKey)})`;
  lines.push(`  OpenAI API key : ${keyDisplay}`);

  process.stdout.write(`${lines.join("\n")}\n`);
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

  // `config set`/`unset` are the only subcommands that mutate state without
  // needing the merged config for a read; everything else loads it.
  if (args.subcommand.kind === "config-set") {
    try {
      runConfigSet(args.subcommand.key, args.subcommand.value);
    } catch (err) {
      if (err instanceof ConfigFileError) fail(err.message);
      throw err;
    }
    return;
  }
  if (args.subcommand.kind === "config-unset") {
    try {
      runConfigUnset(args.subcommand.key);
    } catch (err) {
      if (err instanceof ConfigFileError) fail(err.message);
      throw err;
    }
    return;
  }

  let file;
  try {
    file = readConfigFile();
  } catch (err) {
    if (err instanceof ConfigFileError) fail(err.message);
    throw err;
  }

  let cfg: LocalConfig;
  try {
    cfg = loadLocalConfig(process.env, file);
  } catch (err) {
    if (err instanceof LocalConfigError) fail(err.message);
    throw err;
  }

  if (args.subcommand.kind === "config-list") {
    runConfigList(cfg);
    return;
  }
  if (args.subcommand.kind === "config-get") {
    runConfigGet(cfg, args.subcommand.key);
    return;
  }

  const tokens = readNyxIDTokens();

  if (args.subcommand.kind === "status") {
    await runStatus(tokens, {
      apiKey: cfg.apiKey,
      apiKeySource: cfg.sources.api_key,
    });
    return;
  }

  // -- format path ----------------------------------------------------------
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
