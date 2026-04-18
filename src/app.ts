import { OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";
import { createRoute } from "@hono/zod-openapi";

/**
 * Nocturne Hono app.
 *
 * v0 surface: only /health and /openapi.json. Real routes land in
 * issues #7 + #8.
 */

export const app = new OpenAPIHono();

const HealthResponse = z
  .object({
    status: z.literal("ok"),
    service: z.literal("nocturne"),
    timestamp: z.string().datetime(),
  })
  .openapi("Health");

const healthRoute = createRoute({
  method: "get",
  path: "/health",
  summary: "Liveness check",
  responses: {
    200: {
      content: { "application/json": { schema: HealthResponse } },
      description: "Service is up",
    },
  },
});

app.openapi(healthRoute, (c) =>
  c.json({
    status: "ok" as const,
    service: "nocturne" as const,
    timestamp: new Date().toISOString(),
  }),
);

app.doc("/openapi.json", {
  openapi: "3.0.3",
  info: {
    title: "Nocturne",
    version: "0.0.1",
    description:
      "Turn any LLM output into a beautiful, long-lived, China-reachable URL.",
  },
});
