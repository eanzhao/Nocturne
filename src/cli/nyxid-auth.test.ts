import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  listUserServices,
  normalizeLlmRoute,
  NyxIDStatusError,
  readNyxIDTokens,
  resolveNyxIDGateway,
} from "./nyxid-auth.ts";

// ---------------------------------------------------------------------------
// readNyxIDTokens — filesystem contract

describe("readNyxIDTokens", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "nocturne-nyxid-home-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns null when ~/.nyxid is missing entirely", () => {
    expect(readNyxIDTokens(tmp)).toBeNull();
  });

  it("returns null when only base_url exists (partial install)", () => {
    const dir = join(tmp, ".nyxid");
    mkdirSync(dir);
    writeFileSync(join(dir, "base_url"), "https://nyx.example.com");
    expect(readNyxIDTokens(tmp)).toBeNull();
  });

  it("returns tokens when both required files exist", () => {
    const dir = join(tmp, ".nyxid");
    mkdirSync(dir);
    writeFileSync(join(dir, "base_url"), "https://nyx.example.com\n");
    writeFileSync(join(dir, "access_token"), "eyJtok.ens.here\n");
    const tokens = readNyxIDTokens(tmp);
    expect(tokens).toEqual({
      baseUrl: "https://nyx.example.com",
      accessToken: "eyJtok.ens.here",
    });
  });

  it("strips trailing slash from base_url", () => {
    const dir = join(tmp, ".nyxid");
    mkdirSync(dir);
    writeFileSync(join(dir, "base_url"), "https://nyx.example.com/");
    writeFileSync(join(dir, "access_token"), "t");
    const tokens = readNyxIDTokens(tmp);
    expect(tokens?.baseUrl).toBe("https://nyx.example.com");
  });
});

// ---------------------------------------------------------------------------
// resolveNyxIDGateway — status endpoint contract

describe("resolveNyxIDGateway", () => {
  const tokens = {
    baseUrl: "https://nyx.example.com",
    accessToken: "sk-test",
  };

  it("returns the gateway URL and ready providers on happy path", async () => {
    const seenUrls: string[] = [];
    const seenAuth: (string | null)[] = [];
    const fetchImpl = async (url: string, init?: RequestInit) => {
      seenUrls.push(url);
      seenAuth.push(new Headers(init?.headers).get("authorization"));
      return new Response(
        JSON.stringify({
          gateway_url: "https://nyx.example.com/api/v1/llm/gateway/v1",
          providers: [
            { provider_slug: "openai", status: "ready" },
            { provider_slug: "anthropic", status: "not_connected" },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const result = await resolveNyxIDGateway(tokens, { fetchImpl });

    expect(seenUrls).toEqual([
      "https://nyx.example.com/api/v1/llm/status",
    ]);
    expect(seenAuth).toEqual(["Bearer sk-test"]);
    expect(result.gatewayUrl).toBe(
      "https://nyx.example.com/api/v1/llm/gateway/v1",
    );
    expect(result.readyProviders).toEqual(["openai"]);
  });

  it("throws NyxIDStatusError(unauthorized) on 401", async () => {
    const fetchImpl = async () =>
      new Response("bad", { status: 401 });
    try {
      await resolveNyxIDGateway(tokens, { fetchImpl });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(NyxIDStatusError);
      expect((err as NyxIDStatusError).hint).toBe("unauthorized");
    }
  });

  it("throws NyxIDStatusError(no_provider) when no provider is ready", async () => {
    const fetchImpl = async () =>
      new Response(
        JSON.stringify({
          gateway_url: "https://nyx.example.com/api/v1/llm/gateway/v1",
          providers: [
            { provider_slug: "openai", status: "not_connected" },
            { provider_slug: "anthropic", status: "not_connected" },
          ],
        }),
        { status: 200 },
      );
    try {
      await resolveNyxIDGateway(tokens, { fetchImpl });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(NyxIDStatusError);
      expect((err as NyxIDStatusError).hint).toBe("no_provider");
    }
  });

  it("throws NyxIDStatusError(network) on 5xx", async () => {
    const fetchImpl = async () => new Response("", { status: 503 });
    try {
      await resolveNyxIDGateway(tokens, { fetchImpl });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(NyxIDStatusError);
      expect((err as NyxIDStatusError).hint).toBe("network");
      expect((err as NyxIDStatusError).status).toBe(503);
    }
  });

  it("throws NyxIDStatusError(malformed) on schema mismatch", async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify({ providers: [] /* no gateway_url */ }), {
        status: 200,
      });
    try {
      await resolveNyxIDGateway(tokens, { fetchImpl });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(NyxIDStatusError);
      expect((err as NyxIDStatusError).hint).toBe("malformed");
    }
  });
});

// ---------------------------------------------------------------------------
// normalizeLlmRoute — accepts slug or path, rejects URLs/empty

describe("normalizeLlmRoute", () => {
  it("returns null for empty/auto/gateway (all mean: use the LLM gateway)", () => {
    expect(normalizeLlmRoute(undefined)).toBeNull();
    expect(normalizeLlmRoute("")).toBeNull();
    expect(normalizeLlmRoute("   ")).toBeNull();
    expect(normalizeLlmRoute("auto")).toBeNull();
    expect(normalizeLlmRoute("Gateway")).toBeNull();
  });

  it("wraps a bare slug into /api/v1/proxy/s/<slug>", () => {
    expect(normalizeLlmRoute("chrono-llm")).toBe("/api/v1/proxy/s/chrono-llm");
    expect(normalizeLlmRoute("  my-svc  ")).toBe("/api/v1/proxy/s/my-svc");
  });

  it("preserves a full path; strips trailing slashes", () => {
    expect(normalizeLlmRoute("/api/v1/proxy/s/foo")).toBe(
      "/api/v1/proxy/s/foo",
    );
    expect(normalizeLlmRoute("/api/v1/proxy/s/foo/")).toBe(
      "/api/v1/proxy/s/foo",
    );
  });

  it("rejects full URLs (returns null so caller can warn)", () => {
    expect(normalizeLlmRoute("https://nyx.example.com/foo")).toBeNull();
    expect(normalizeLlmRoute("//nyx.example.com/foo")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// listUserServices — unified /api/v1/keys endpoint

describe("listUserServices", () => {
  const tokens = {
    baseUrl: "https://nyx.example.com",
    accessToken: "tok-abc",
  };

  it("hits /api/v1/keys and maps the unified record shape", async () => {
    const fetchImpl = async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://nyx.example.com/api/v1/keys");
      const auth = new Headers(init?.headers).get("Authorization");
      expect(auth).toBe("Bearer tok-abc");
      return new Response(
        JSON.stringify({
          keys: [
            {
              id: "k-1",
              slug: "mlx-from-macstudio-77tf",
              label: "MLX from MacStudio",
              endpoint_url: "http://localhost:8093/v1",
              auth_method: "header",
              status: "active",
              is_active: true,
              catalog_service_id: null,
              catalog_service_name: null,
              last_used_at: null,
            },
            {
              id: "k-2",
              slug: "chrono-llm",
              // no user-chosen label — falls back to catalog name
              endpoint_url: "https://llm.aelf.dev/v1",
              auth_method: "header",
              status: "active",
              is_active: true,
              catalog_service_id: "cat-chrono-llm",
              catalog_service_name: "Chrono LLM",
              last_used_at: "2026-04-18T16:00:12Z",
            },
            {
              id: "k-3",
              slug: "stale-thing",
              is_active: false,
              status: "inactive",
            },
          ],
        }),
        { status: 200 },
      );
    };
    const services = await listUserServices(tokens, { fetchImpl });
    expect(services).toEqual([
      {
        slug: "mlx-from-macstudio-77tf",
        name: "MLX from MacStudio", // user label wins
        endpointUrl: "http://localhost:8093/v1",
        active: true,
        authMethod: "header",
        fromCatalog: false,
        lastUsedAt: null,
      },
      {
        slug: "chrono-llm",
        name: "Chrono LLM", // catalog name used when label missing
        endpointUrl: "https://llm.aelf.dev/v1",
        active: true,
        authMethod: "header",
        fromCatalog: true,
        lastUsedAt: "2026-04-18T16:00:12Z",
      },
      {
        slug: "stale-thing",
        name: "stale-thing", // slug fallback, no catalog, no label
        endpointUrl: null,
        active: false,
        authMethod: "unknown",
        fromCatalog: false,
        lastUsedAt: null,
      },
    ]);
  });

  it("throws NyxIDStatusError(unauthorized) on 401", async () => {
    const fetchImpl = async () => new Response("", { status: 401 });
    try {
      await listUserServices(tokens, { fetchImpl });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(NyxIDStatusError);
      expect((err as NyxIDStatusError).hint).toBe("unauthorized");
    }
  });

  it("throws NyxIDStatusError(malformed) on schema mismatch", async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify({ not_keys: [] }), { status: 200 });
    try {
      await listUserServices(tokens, { fetchImpl });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(NyxIDStatusError);
      expect((err as NyxIDStatusError).hint).toBe("malformed");
    }
  });
});
