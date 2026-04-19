import { describe, expect, it } from "bun:test";
import { buildSystemPrompt } from "./planner-prompt.ts";

describe("buildSystemPrompt", () => {
  it("default (no args) contains 'Respond in English'", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("Respond in English");
  });

  it("language: 'en' contains 'Respond in English'", () => {
    const prompt = buildSystemPrompt({ language: "en" });
    expect(prompt).toContain("Respond in English");
  });

  it("language: 'zh' contains 'Simplified Chinese' and '简体中文'", () => {
    const prompt = buildSystemPrompt({ language: "zh" });
    expect(prompt).toContain("Simplified Chinese");
    expect(prompt).toContain("简体中文");
  });

  it("both variants contain core rule 'You are Nocturne's layout planner'", () => {
    expect(buildSystemPrompt({ language: "en" })).toContain(
      "You are Nocturne's layout planner",
    );
    expect(buildSystemPrompt({ language: "zh" })).toContain(
      "You are Nocturne's layout planner",
    );
  });

  it("both variants contain 'Return JSON only'", () => {
    expect(buildSystemPrompt({ language: "en" })).toContain("Return JSON only");
    expect(buildSystemPrompt({ language: "zh" })).toContain("Return JSON only");
  });
});
