import "./test-env.ts";
import { describe, expect, it } from "bun:test";
import { generatePage, type Planner } from "./pipeline.ts";
import type { DailyBrief } from "../schema/daily-brief.ts";

const fakeBrief: DailyBrief = {
  content_type: "daily_brief_v1",
  spec_id: "executive-broadsheet",
  title: "Test Brief",
  summary: "A short summary.",
  top_priorities: [],
  watchlist: [],
  timeline: [],
  notes: [],
};

const stubPlanner: Planner = async () => ({ brief: fakeBrief });

describe("generatePage", () => {
  it("returns HTML plus a 22-char base62 pageId for a valid plan", async () => {
    const result = await generatePage("hello world", {
      planner: stubPlanner,
      model: "test-model",
      userId: "local",
      seq: 1,
    });
    expect(result.html).toContain("<!doctype html>");
    expect(result.html).toContain("Test Brief");
    expect(result.pageId).toMatch(/^[0-9A-Za-z]{16,24}$/);
    expect(result.fallbackReason).toBeUndefined();
  });

  it("propagates planner fallbackReason", async () => {
    const fallbackPlanner: Planner = async () => ({
      brief: fakeBrief,
      fallbackReason: "invalid_spec_id",
    });
    const result = await generatePage("x", {
      planner: fallbackPlanner,
      model: "test-model",
      userId: "local",
      seq: 1,
    });
    expect(result.fallbackReason).toBe("invalid_spec_id");
  });

  it("uses the caller-supplied createdAt when provided (determinism for tests)", async () => {
    const fixed = "2026-04-18T00:00:00.000Z";
    const result = await generatePage("x", {
      planner: stubPlanner,
      model: "test-model",
      userId: "local",
      seq: 1,
      createdAt: fixed,
    });
    expect(result.createdAt).toBe(fixed);
  });
});
