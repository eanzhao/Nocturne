import { describe, expect, it } from "bun:test";
import { loadLocalConfig } from "./config.ts";

describe("loadLocalConfig", () => {
  it("accepts an empty env; apiKey is undefined when not set", () => {
    // NyxID-only flow is allowed: no env vars required at config-load time.
    const cfg = loadLocalConfig({});
    expect(cfg.apiKey).toBeUndefined();
    expect(cfg.baseUrl).toBe("https://api.openai.com/v1");
    expect(cfg.model).toBe("gpt-4o-mini");
    expect(cfg.outDir).toBe("./out");
  });

  it("returns the api key when set", () => {
    const cfg = loadLocalConfig({ NOCTURNE_OPENAI_API_KEY: "sk-x" });
    expect(cfg.apiKey).toBe("sk-x");
  });

  it("honors overrides", () => {
    const cfg = loadLocalConfig({
      NOCTURNE_OPENAI_API_KEY: "k",
      NOCTURNE_OPENAI_BASE_URL: "https://openrouter.ai/api/v1",
      NOCTURNE_OPENAI_MODEL: "google/gemini-2.5-flash",
      NOCTURNE_OUT_DIR: "/tmp/nocturne-pages",
    });
    expect(cfg.baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(cfg.model).toBe("google/gemini-2.5-flash");
    expect(cfg.outDir).toBe("/tmp/nocturne-pages");
  });
});
