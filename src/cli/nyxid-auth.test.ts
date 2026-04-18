import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  listProxyServices,
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
// listProxyServices — happy path, auth, malformed

describe("listProxyServices", () => {
  const tokens = {
    baseUrl: "https://nyx.example.com",
    accessToken: "tok-abc",
  };

  it("returns a flattened list with defaults for optional fields", async () => {
    const fetchImpl = async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://nyx.example.com/api/v1/proxy/services");
      const auth = new Headers(init?.headers).get("Authorization");
      expect(auth).toBe("Bearer tok-abc");
      return new Response(
        JSON.stringify({
          services: [
            {
              slug: "chrono-llm",
              name: "Chrono LLM",
              connected: false,
              requires_connection: true,
              service_category: "connection",
            },
            { slug: "foo-bare" }, // only slug — defaults fill in
          ],
        }),
        { status: 200 },
      );
    };
    const services = await listProxyServices(tokens, { fetchImpl });
    expect(services).toHaveLength(2);
    expect(services[0]).toMatchObject({
      slug: "chrono-llm",
      name: "Chrono LLM",
      connected: false,
      requiresConnection: true,
      category: "connection",
    });
    expect(services[1]).toMatchObject({
      slug: "foo-bare",
      name: "foo-bare", // falls back to slug
      connected: false,
      requiresConnection: false,
      category: "unknown",
    });
  });

  it("throws NyxIDStatusError(unauthorized) on 401", async () => {
    const fetchImpl = async () => new Response("", { status: 401 });
    try {
      await listProxyServices(tokens, { fetchImpl });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(NyxIDStatusError);
      expect((err as NyxIDStatusError).hint).toBe("unauthorized");
    }
  });

  it("throws NyxIDStatusError(malformed) on schema mismatch", async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify({ not_services: [] }), { status: 200 });
    try {
      await listProxyServices(tokens, { fetchImpl });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(NyxIDStatusError);
      expect((err as NyxIDStatusError).hint).toBe("malformed");
    }
  });
});
