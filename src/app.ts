import { OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";
import { createRoute } from "@hono/zod-openapi";
import { formatRouter } from "./routes/format";
import { viewRouter } from "./routes/view";
import { rateRouter } from "./routes/rate";
import { archiveRoutes } from "./routes/archive";
import { archiveShareRoutes } from "./routes/archive-share";

/**
 * Nocturne Hono app.
 *
 * Routes:
 *   GET  /health                   — liveness
 *   GET  /openapi.json             — OpenAPI 3.0.3 spec
 *   POST /format                   — generate a Nocturne page (behind NyxID proxy)
 *   GET  /v/{slug}                 — public SSR page view (immutable cache)
 *   POST /v/{slug}/rate            — rate a page good|bad
 *   GET  /u/{slug}                 — tiered-privacy archive list
 *   POST /u/share                  — create a share token
 *   GET  /u/share                  — list own share tokens
 *   DELETE /u/share/{token_id}     — revoke a share token
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

// Wire the v0-alpha routes.
app.route("/", formatRouter);         // POST /format
app.route("/", viewRouter);           // GET  /v/{slug}
app.route("/", rateRouter);           // POST /v/{slug}/rate
app.route("/", archiveRoutes());      // GET  /u/{slug}
app.route("/", archiveShareRoutes()); // POST /u/share, GET /u/share, DELETE /u/share/{token_id}
