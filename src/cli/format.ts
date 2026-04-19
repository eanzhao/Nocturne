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
  listRouteModels,
  listUserServices,
  NyxIDStatusError,
  normalizeLlmRoute,
  readNyxIDTokens,
  resolveNyxIDGateway,
  type NyxIDTokens,
  type NyxIDUserService,
} from "./nyxid-auth.ts";

export type Subcommand =
  | { kind: "format" }
  | { kind: "status" }
  | { kind: "routes" }
  | { kind: "models"; route: string | undefined }
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

  if (argv[0] === "routes") {
    if (argv.length > 1) {
      throw new ArgsError(`routes: unexpected extra arg "${argv[1]}"`);
    }
    return { subcommand: { kind: "routes" } };
  }

  if (argv[0] === "models") {
    let route: string | undefined;
    for (let i = 1; i < argv.length; i++) {
      const v = argv[i];
      if (v === "--route") {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith("-")) {
          throw new ArgsError(`--route requires a slug or path`);
        }
        route = next;
        i++;
      } else {
        throw new ArgsError(`models: unknown arg "${v}"`);
      }
    }
    return { subcommand: { kind: "models", route } };
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
  nocturne-format routes                    # list picks for llm-route
  nocturne-format models [--route <slug>]   # list models (gateway or a proxy route)
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
  NOCTURNE_LLM_ROUTE        (empty = LLM gateway; set to a proxy-service slug
                             like "chrono-llm" to route through /api/v1/proxy/s/<slug>)

Config keys:
  model       LLM model name
  base_url    OpenAI-compatible base URL
  out_dir     Output directory for rendered pages
  api_key     OpenAI API key (stored 0600; prefer NyxID)
  llm_route   Proxy-service slug (NyxID path only)
  language    Language for LLM-generated content: en (default) | zh
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
  /** Set when NyxID path is routed through a proxy service, not the gateway. */
  nyxidRoute?: string;
}

async function pickPlannerSource(
  tokens: NyxIDTokens | null,
  env: {
    apiKey: string | undefined;
    model: string;
    baseUrl: string;
    llmRoute: string | undefined;
  },
): Promise<{ source: PlannerSource; warnings: string[] }> {
  const warnings: string[] = [];

  if (tokens !== null) {
    // User-requested proxy-service route (e.g. `llm_route=chrono-llm`)
    // short-circuits the LLM Gateway. We still use the NyxID access token
    // as the bearer; NyxID validates + injects per-service credentials.
    const route = normalizeLlmRoute(env.llmRoute);
    if (route !== null) {
      return {
        source: {
          label: "nyxid",
          apiKey: tokens.accessToken,
          baseUrl: `${tokens.baseUrl}${route}`,
          model: env.model,
          nyxidRoute: route,
        },
        warnings,
      };
    }
    // If user typed a value that failed normalization (URL, empty after
    // normalization, …), fall through to the gateway path but warn.
    if (env.llmRoute !== undefined && env.llmRoute.trim() !== "") {
      warnings.push(
        `llm_route="${env.llmRoute}" is not a valid slug or path — falling back to gateway. Accepted: "chrono-llm" or "/api/v1/proxy/s/<slug>".`,
      );
    }

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
    ["llm_route", fmtValue("llm_route", cfg.llmRoute), cfg.sources.llm_route],
    ["language", fmtValue("language", cfg.language), cfg.sources.language],
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
  // Single lookup table — adding a new config key here is the one edit
  // required on top of extending `CONFIG_KEYS`. The prior chain-of-ternaries
  // shape silently bucketed unknown keys into `llmRoute`.
  const lookup: Record<ConfigKey, string | undefined> = {
    model: cfg.model,
    base_url: cfg.baseUrl,
    out_dir: cfg.outDir,
    api_key: cfg.apiKey,
    llm_route: cfg.llmRoute,
    language: cfg.language,
  };
  const val = lookup[key];
  if (val === undefined) {
    process.exit(1);
  }
  process.stdout.write(`${val}\n`);
}

function runConfigSet(key: ConfigKey, value: string): void {
  // Light validation — the schema's main job is at read time, but catching
  // bad values here gives a friendlier error than re-failing next invocation
  // AND prevents writing a file the CLI itself will then refuse to read.
  if (key === "base_url") {
    try {
      new URL(value);
    } catch {
      fail(`config set: base_url must be a valid URL, got "${value}"`);
    }
  }
  if (key === "language" && value !== "en" && value !== "zh") {
    fail(`config set: language must be one of "en" | "zh", got "${value}"`);
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
  env: {
    apiKey: string | undefined;
    apiKeySource: ConfigSource;
    llmRoute: string | undefined;
    llmRouteSource: ConfigSource;
  },
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

    // User-services are the user's actually-configured proxy routes
    // (Ollama, Mimo, SiliconFlow, chrono-llm, …) — the slugs here are
    // what go into `config set llm-route <slug>`. Distinct from the
    // global NyxID service catalog (`/api/v1/proxy/services`), which
    // lists template integrations and mostly isn't actionable.
    try {
      const services = await listUserServices(tokens);
      if (services.length === 0) {
        lines.push("  user services  : (none registered — add one at /keys on the NyxID dashboard)");
      } else {
        lines.push("  user services  :");
        // Custom user-registered ones first (no catalog binding) —
        // those are what drew the user to this CLI. Catalog-linked
        // entries (like `chrono-llm`) follow.
        const custom = services.filter((s) => !s.fromCatalog);
        const catalog = services.filter((s) => s.fromCatalog);
        for (const s of [...custom, ...catalog]) {
          lines.push(formatUserServiceRow(s));
        }
      }
    } catch (err) {
      if (err instanceof NyxIDStatusError) {
        lines.push(
          `  user services  : ${err.hint} — ${err.message}`,
        );
      } else {
        lines.push(
          `  user services  : errored (${err instanceof Error ? err.message : String(err)})`,
        );
      }
    }
  }

  const keyDisplay =
    env.apiKey === undefined
      ? "not set"
      : `set via ${env.apiKeySource} (${mask(env.apiKey)})`;
  lines.push(`  OpenAI API key : ${keyDisplay}`);

  const routeNormalized = normalizeLlmRoute(env.llmRoute);
  const routeDisplay =
    env.llmRoute === undefined
      ? "gateway (default)"
      : routeNormalized === null
        ? `"${env.llmRoute}" [invalid — falling back to gateway]`
        : `${routeNormalized}  (from ${env.llmRouteSource})`;
  lines.push(`  LLM route      : ${routeDisplay}`);

  process.stdout.write(`${lines.join("\n")}\n`);
}

async function runRoutes(tokens: NyxIDTokens | null): Promise<void> {
  if (tokens === null) {
    fail(
      "not logged in. Run `nyxid login` first, then the gateway + your proxy-service routes will appear here.",
    );
  }

  const lines: string[] = [];
  lines.push("Available routes — set with `nocturne-format config set llm-route <slug>`:");
  lines.push("");
  lines.push(padSlug("gateway") + "  NyxID LLM Gateway (default, prefix-routed)");

  try {
    const services = await listUserServices(tokens);
    // Custom first, catalog second — same order as `status`, so the
    // slug the user is most likely typing sits nearest the top.
    const ordered = [
      ...services.filter((s) => !s.fromCatalog),
      ...services.filter((s) => s.fromCatalog),
    ];
    if (ordered.length === 0) {
      lines.push("");
      lines.push("(no user services registered — add one on NyxID's /keys page)");
    } else {
      for (const s of ordered) {
        const trailer =
          s.name && s.name !== s.slug
            ? `${s.name}${s.active ? "" : " (INACTIVE)"}`
            : s.active
              ? ""
              : "(INACTIVE)";
        lines.push(`${padSlug(s.slug)}  ${trailer}`.trimEnd());
      }
    }
  } catch (err) {
    if (err instanceof NyxIDStatusError) {
      lines.push(`  (error listing user services: ${err.hint} — ${err.message})`);
    } else {
      throw err;
    }
  }

  process.stdout.write(`${lines.join("\n")}\n`);
}

function padSlug(s: string): string {
  const w = 36;
  return s.length >= w ? s : s + " ".repeat(w - s.length);
}

async function runModels(
  tokens: NyxIDTokens | null,
  configuredRoute: string | undefined,
  flagRoute: string | undefined,
): Promise<void> {
  if (tokens === null) {
    fail("not logged in. Run `nyxid login` first.");
  }

  // Flag beats config; config beats gateway default. `gateway` (or
  // anything that normalizes to null) means "use the LLM gateway
  // supported_models list, don't probe a proxy".
  const chosen = flagRoute ?? configuredRoute;
  const route = normalizeLlmRoute(chosen);
  const isGateway = route === null;

  const lines: string[] = [];
  if (isGateway) {
    lines.push("Models: NyxID LLM Gateway");
    lines.push("");
    try {
      const gw = await resolveNyxIDGateway(tokens);
      if (gw.supportedModels.length === 0) {
        lines.push("(gateway reported no supported_models list)");
      } else {
        lines.push(
          "The gateway routes by prefix — any model whose name starts with one of these is accepted:",
        );
        lines.push("");
        for (const m of gw.supportedModels) lines.push(`  ${m}`);
      }
      lines.push("");
      lines.push(`Ready providers: ${gw.readyProviders.join(", ") || "(none)"}`);
    } catch (err) {
      if (err instanceof NyxIDStatusError) {
        fail(`gateway status: ${err.hint} — ${err.message}`);
      }
      throw err;
    }
  } else {
    const label = chosen ?? route;
    lines.push(`Models: ${label}`);
    lines.push(`  (fetched from ${route}/models)`);
    lines.push("");
    try {
      const models = await listRouteModels(tokens, route);
      if (models.length === 0) {
        lines.push("(upstream returned an empty model list)");
      } else {
        for (const m of models) lines.push(`  ${m}`);
      }
    } catch (err) {
      if (err instanceof NyxIDStatusError) {
        fail(
          `${err.hint === "malformed" ? "not OpenAI-compatible" : err.hint}: ${err.message}`,
        );
      }
      throw err;
    }
  }

  process.stdout.write(`${lines.join("\n")}\n`);
}

function formatUserServiceRow(s: NyxIDUserService): string {
  const tags: string[] = [];
  if (!s.active) tags.push("inactive");
  tags.push(s.fromCatalog ? "catalog" : "custom");
  tags.push(`auth:${s.authMethod}`);
  const nameBit = s.name && s.name !== s.slug ? `  "${s.name}"` : "";
  const endpointBit = s.endpointUrl ? `  → ${s.endpointUrl}` : "";
  return `    · ${s.slug}${nameBit}  [${tags.join(" · ")}]${endpointBit}`;
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
      llmRoute: cfg.llmRoute,
      llmRouteSource: cfg.sources.llm_route,
    });
    return;
  }

  if (args.subcommand.kind === "routes") {
    await runRoutes(tokens);
    return;
  }

  if (args.subcommand.kind === "models") {
    await runModels(tokens, cfg.llmRoute, args.subcommand.route);
    return;
  }

  // -- format path ----------------------------------------------------------
  const content = (await readInput(args.inPath)).trim();
  if (!content) fail("empty input");

  const { source, warnings } = await pickPlannerSource(tokens, {
    apiKey: cfg.apiKey,
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    llmRoute: cfg.llmRoute,
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
          language: cfg.language,
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
