import { describe, expect, it } from "bun:test";
import { planDailyBriefWithOpenAI } from "./openai.ts";
import { PlannerTimeout, PlannerUpstreamError } from "./openai-compat.ts";

describe("planDailyBriefWithOpenAI", () => {
  it("calls the chat/completions URL with a Bearer api key and returns a brief", async () => {
    const seenUrls: string[] = [];
    const seenAuth: (string | null)[] = [];

    const fetchImpl = async (url: string, init: RequestInit) => {
      seenUrls.push(url);
      seenAuth.push(new Headers(init.headers).get("authorization"));
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  content_type: "daily_brief_v1",
                  spec_id: "executive-broadsheet",
                  title: "T",
                  summary: "s",
                  top_priorities: [],
                  watchlist: [],
                  timeline: [],
                  notes: [],
                }),
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const result = await planDailyBriefWithOpenAI("hello", {
      apiKey: "sk-test",
      baseUrl: "https://example.test/v1",
      model: "gpt-test",
      fetchImpl,
    });

    expect(seenUrls).toEqual(["https://example.test/v1/chat/completions"]);
    expect(seenAuth).toEqual(["Bearer sk-test"]);
    expect(result.brief.title).toBe("T");
  });

  it("defaults baseUrl to https://api.openai.com/v1", async () => {
    let capturedUrl = "";
    const fetchImpl = async (url: string, _init: RequestInit) => {
      capturedUrl = url;
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  content_type: "daily_brief_v1",
                  spec_id: "executive-broadsheet",
                  title: "T",
                  summary: "s",
                  top_priorities: [],
                  watchlist: [],
                  timeline: [],
                  notes: [],
                }),
              },
            },
          ],
        }),
        { status: 200 },
      );
    };
    await planDailyBriefWithOpenAI("x", {
      apiKey: "k",
      model: "m",
      fetchImpl,
    });
    expect(capturedUrl).toBe("https://api.openai.com/v1/chat/completions");
  });

  it("surfaces a 401 as PlannerUpstreamError", async () => {
    const fetchImpl = async () => new Response("bad key", { status: 401 });
    await expect(
      planDailyBriefWithOpenAI("x", {
        apiKey: "bad",
        model: "m",
        fetchImpl,
      }),
    ).rejects.toBeInstanceOf(PlannerUpstreamError);
  });

  it("surfaces AbortSignal timeout as PlannerTimeout", async () => {
    const fetchImpl = async (_url: string, init: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    };
    await expect(
      planDailyBriefWithOpenAI("x", {
        apiKey: "k",
        model: "m",
        fetchImpl,
        timeoutMs: 10,
      }),
    ).rejects.toBeInstanceOf(PlannerTimeout);
  });
});
