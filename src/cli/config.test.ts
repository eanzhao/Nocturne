import { describe, expect, it } from "bun:test";
import { loadLocalConfig } from "./config.ts";

describe("loadLocalConfig", () => {
  it("returns defaults when both env and file are empty", () => {
    const cfg = loadLocalConfig({});
    expect(cfg.apiKey).toBeUndefined();
    expect(cfg.baseUrl).toBe("https://api.openai.com/v1");
    expect(cfg.model).toBe("gpt-4o-mini");
    expect(cfg.outDir).toBe("./out");
    expect(cfg.sources).toEqual({
      model: "default",
      base_url: "default",
      out_dir: "default",
      api_key: "default",
      llm_route: "default",
      language: "default",
    });
    expect(cfg.llmRoute).toBeUndefined();
    expect(cfg.language).toBeUndefined();
  });

  it("file values are used when env is empty", () => {
    const cfg = loadLocalConfig(
      {},
      {
        model: "deepseek-chat",
        base_url: "https://nyx.example.com/gw/v1",
        out_dir: "/tmp/nocturne",
        api_key: "sk-from-file",
        llm_route: "chrono-llm",
      },
    );
    expect(cfg.model).toBe("deepseek-chat");
    expect(cfg.baseUrl).toBe("https://nyx.example.com/gw/v1");
    expect(cfg.outDir).toBe("/tmp/nocturne");
    expect(cfg.apiKey).toBe("sk-from-file");
    expect(cfg.llmRoute).toBe("chrono-llm");
    expect(cfg.sources).toEqual({
      model: "file",
      base_url: "file",
      out_dir: "file",
      api_key: "file",
      llm_route: "file",
      language: "default",
    });
  });

  it("env NOCTURNE_LLM_ROUTE wins over file llm_route", () => {
    const cfg = loadLocalConfig(
      { NOCTURNE_LLM_ROUTE: "another-service" },
      { llm_route: "chrono-llm" },
    );
    expect(cfg.llmRoute).toBe("another-service");
    expect(cfg.sources.llm_route).toBe("env");
  });

  it("env wins over file", () => {
    const cfg = loadLocalConfig(
      {
        NOCTURNE_OPENAI_MODEL: "gpt-4o",
        NOCTURNE_OPENAI_API_KEY: "sk-env",
      },
      {
        model: "deepseek-chat",
        api_key: "sk-from-file",
      },
    );
    expect(cfg.model).toBe("gpt-4o");
    expect(cfg.apiKey).toBe("sk-env");
    expect(cfg.sources.model).toBe("env");
    expect(cfg.sources.api_key).toBe("env");
  });

  it("language from file is surfaced as cfg.language with source 'file'", () => {
    const cfg = loadLocalConfig({}, { language: "zh" });
    expect(cfg.language).toBe("zh");
    expect(cfg.sources.language).toBe("file");
  });

  it("language unset in file → cfg.language undefined, source 'default'", () => {
    const cfg = loadLocalConfig({}, {});
    expect(cfg.language).toBeUndefined();
    expect(cfg.sources.language).toBe("default");
  });

  it("empty-string env values are treated as unset (file still wins)", () => {
    const cfg = loadLocalConfig(
      { NOCTURNE_OPENAI_API_KEY: "" },
      { api_key: "sk-from-file" },
    );
    expect(cfg.apiKey).toBe("sk-from-file");
    expect(cfg.sources.api_key).toBe("file");
  });
});
