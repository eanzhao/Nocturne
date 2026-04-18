/**
 * NyxID credentials — consume-only.
 *
 * The `nyxid` CLI (a separate binary from the NyxID project) owns the
 * login/logout/refresh flow and writes three plain files under `~/.nyxid/`:
 *
 *   ~/.nyxid/base_url       — the NyxID server root (e.g. https://nyx-api.chrono-ai.fun)
 *   ~/.nyxid/access_token   — bearer token, refreshed by the nyxid CLI
 *   ~/.nyxid/refresh_token  — used by nyxid CLI on refresh; Nocturne ignores it
 *
 * Nocturne only reads. We never mint, never refresh, never delete — leave
 * token lifecycle to the nyxid CLI so both tools share one auth session.
 *
 * On format invocations we:
 *   1. Read `base_url` + `access_token` (return null if either is missing).
 *   2. Call `GET {base_url}/api/v1/llm/status` with the bearer to discover
 *      the OpenAI-compatible gateway URL and check that at least one LLM
 *      provider is `"ready"` for this user.
 *   3. Caller (format.ts) either uses the gateway or falls back to the
 *      direct OpenAI API key path.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

export interface NyxIDTokens {
  baseUrl: string;
  accessToken: string;
}

/**
 * Read `~/.nyxid/` tokens. Returns null when the user has never run
 * `nyxid login` (or the files were cleared by `nyxid logout`).
 */
export function readNyxIDTokens(
  home: string = homedir(),
): NyxIDTokens | null {
  const dir = join(home, ".nyxid");
  const baseUrl = readIfExists(join(dir, "base_url"));
  const accessToken = readIfExists(join(dir, "access_token"));
  if (!baseUrl || !accessToken) return null;
  return {
    baseUrl: baseUrl.trim().replace(/\/+$/, ""),
    accessToken: accessToken.trim(),
  };
}

function readIfExists(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

/**
 * Shape of `/api/v1/llm/status` we actually consume. Schema is intentionally
 * loose — NyxID may add fields; we only pin what we depend on.
 */
const LlmStatusResponse = z.object({
  gateway_url: z.string().url(),
  providers: z.array(
    z.object({
      provider_slug: z.string(),
      provider_name: z.string().optional(),
      status: z.string(),
    }),
  ),
});

export type LlmStatus = z.infer<typeof LlmStatusResponse>;

export class NyxIDStatusError extends Error {
  readonly status: number | undefined;
  readonly hint: "unauthorized" | "no_provider" | "network" | "malformed";
  constructor(
    hint: "unauthorized" | "no_provider" | "network" | "malformed",
    message: string,
    status?: number,
  ) {
    super(message);
    this.name = "NyxIDStatusError";
    this.hint = hint;
    this.status = status;
  }
}

export type FetchLike = (
  url: string,
  init?: RequestInit,
) => Promise<Response>;

/**
 * Resolve a usable LLM gateway from NyxID. Returns the gateway base URL
 * on success, or throws a typed `NyxIDStatusError` explaining why the
 * caller should fall back.
 *
 * - `unauthorized` (401 from NyxID): token stale — suggest `nyxid login`.
 * - `no_provider`: user is logged in but has no `ready` LLM provider.
 * - `network`: NyxID unreachable / non-OK status.
 * - `malformed`: envelope parse failed.
 */
export async function resolveNyxIDGateway(
  tokens: NyxIDTokens,
  opts: { fetchImpl?: FetchLike; timeoutMs?: number } = {},
): Promise<{ gatewayUrl: string; readyProviders: string[] }> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const url = `${tokens.baseUrl}/api/v1/llm/status`;

  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${tokens.accessToken}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new NyxIDStatusError(
      "network",
      `NyxID status fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (res.status === 401) {
    throw new NyxIDStatusError(
      "unauthorized",
      "NyxID rejected the access token (401). Run `nyxid login` to refresh.",
      401,
    );
  }
  if (!res.ok) {
    throw new NyxIDStatusError(
      "network",
      `NyxID status returned HTTP ${res.status}`,
      res.status,
    );
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch (err) {
    throw new NyxIDStatusError(
      "malformed",
      `NyxID status returned non-JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const parsed = LlmStatusResponse.safeParse(body);
  if (!parsed.success) {
    throw new NyxIDStatusError(
      "malformed",
      `NyxID status envelope did not match expected shape: ${parsed.error.message}`,
    );
  }

  const ready = parsed.data.providers
    .filter((p) => p.status === "ready")
    .map((p) => p.provider_slug);

  if (ready.length === 0) {
    throw new NyxIDStatusError(
      "no_provider",
      "NyxID has no LLM provider in `ready` status. Configure one on the NyxID dashboard or set NOCTURNE_OPENAI_API_KEY.",
    );
  }

  return {
    gatewayUrl: parsed.data.gateway_url.replace(/\/+$/, ""),
    readyProviders: ready,
  };
}

/*
 * NyxID connected services — the unified "keys API" at `/api/v1/keys`.
 * This is the single source of truth for services the user has
 * actually connected: each entry bundles the slug (routable via
 * `/api/v1/proxy/s/<slug>/*`), a user-chosen label, the upstream URL,
 * auth method, activity status, and optional catalog binding.
 *
 * Referenced in NyxID docs as "the primary entry point for users
 * connecting external services" — which is exactly what we want to
 * show when the user runs `nocturne-format status`.
 */
const KeysResponse = z.object({
  keys: z.array(
    z.object({
      id: z.string(),
      slug: z.string(),
      label: z.string().optional(),
      endpoint_url: z.string().optional(),
      auth_method: z.string().optional(),
      status: z.string().optional(),
      is_active: z.boolean().optional(),
      catalog_service_id: z.string().nullable().optional(),
      catalog_service_name: z.string().nullable().optional(),
      catalog_service_slug: z.string().nullable().optional(),
      last_used_at: z.string().nullable().optional(),
    }),
  ),
});

export interface NyxIDUserService {
  /** Developer-friendly slug, used to build `/api/v1/proxy/s/<slug>/*`. */
  slug: string;
  /**
   * Display name. Prefer the user-chosen `label` (e.g. "MLX from
   * MacStudio"); fall back to the catalog name (`Chrono LLM`); fall
   * back to the slug so we always have something to print.
   */
  name: string;
  /** Upstream URL NyxID forwards to (visible only for debugging/UX). */
  endpointUrl: string | null;
  /** Active services are the only ones that will actually proxy. */
  active: boolean;
  /** bearer, header, token_exchange, none, path, … */
  authMethod: string;
  /** True when this service inherits config from NyxID's catalog. */
  fromCatalog: boolean;
  /** ISO timestamp of the last proxy hit, or null if never used. */
  lastUsedAt: string | null;
}

/**
 * List the current user's connected services via `/api/v1/keys`. A
 * single round-trip gives us slug + label + endpoint + activity in one
 * shot, so we don't need the separate catalog-enrichment fetch that an
 * earlier version required.
 *
 * Does not throw on an empty result — returns `[]`. Surfaces the same
 * `NyxIDStatusError` kinds as `resolveNyxIDGateway`.
 */
export async function listUserServices(
  tokens: NyxIDTokens,
  opts: { fetchImpl?: FetchLike; timeoutMs?: number } = {},
): Promise<NyxIDUserService[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const url = `${tokens.baseUrl}/api/v1/keys`;

  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${tokens.accessToken}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new NyxIDStatusError(
      "network",
      `NyxID keys fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (res.status === 401) {
    throw new NyxIDStatusError(
      "unauthorized",
      "NyxID rejected the access token (401). Run `nyxid login` to refresh.",
      401,
    );
  }
  if (!res.ok) {
    throw new NyxIDStatusError(
      "network",
      `NyxID keys returned HTTP ${res.status}`,
      res.status,
    );
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch (err) {
    throw new NyxIDStatusError(
      "malformed",
      `NyxID keys returned non-JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const parsed = KeysResponse.safeParse(body);
  if (!parsed.success) {
    throw new NyxIDStatusError(
      "malformed",
      `NyxID /api/v1/keys envelope did not match expected shape: ${parsed.error.message}`,
    );
  }

  return parsed.data.keys.map((k) => ({
    slug: k.slug,
    name: k.label ?? k.catalog_service_name ?? k.slug,
    endpointUrl: k.endpoint_url ?? null,
    active: (k.is_active ?? true) && (k.status ?? "active") === "active",
    authMethod: k.auth_method ?? "unknown",
    fromCatalog: Boolean(k.catalog_service_id),
    lastUsedAt: k.last_used_at ?? null,
  }));
}

/**
 * Normalize a user-typed `llm_route` value to a NyxID request path.
 *
 * Accepts:
 *   - bare slug:  `chrono-llm`          → `/api/v1/proxy/s/chrono-llm`
 *   - full path:  `/api/v1/proxy/s/foo` → `/api/v1/proxy/s/foo` (untouched)
 *   - empty/auto/gateway (case-insensitive): `""`, returned as `null`,
 *     meaning "use the LLM Gateway, don't override".
 *
 * URLs (anything with `://`) are rejected — the gateway/proxy domain is
 * always the NyxID base URL; a full URL here almost certainly means the
 * user misunderstood the contract, and silently falling back to the
 * gateway would hide the mistake. Caller should surface the `null`
 * result from this function to the user when they typed something weird.
 *
 * Matches aevatar's `normalizeUserLlmRoute` shape so the two codebases
 * read and write the same config values.
 */
export function normalizeLlmRoute(raw: string | undefined): string | null {
  const s = (raw ?? "").trim();
  if (!s || /^auto$/i.test(s) || /^gateway$/i.test(s)) return null;
  if (s.includes("://") || s.startsWith("//")) return null;
  if (s.startsWith("/")) return s.replace(/\/+$/, "");
  return `/api/v1/proxy/s/${s.replace(/^\/+|\/+$/g, "")}`;
}
