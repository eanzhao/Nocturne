import { describe, expect, it } from "bun:test";
import { loadLocalConfig, LocalConfigError } from "./config.ts";

describe("loadLocalConfig", () => {
  it("requires NOCTURNE_OPENAI_API_KEY", () => {
    expect(() => loadLocalConfig({})).toThrow(LocalConfigError);
  });

  it("returns defaults when only the api key is set", () => {
    const cfg = loadLocalConfig({ NOCTURNE_OPENAI_API_KEY: "sk-x" });
    expect(cfg.apiKey).toBe("sk-x");
    expect(cfg.baseUrl).toBe("https://api.openai.com/v1");
    expect(cfg.model).toBe("gpt-4o-mini");
    expect(cfg.outDir).toBe("./out");
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
