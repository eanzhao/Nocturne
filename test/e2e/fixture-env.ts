/**
 * E2E env bootstrap — MUST be imported FIRST by every `test/e2e/*.e2e.ts` file.
 *
 * `src/config.ts` reads `process.env` at module-load time and fails fast on
 * missing variables. Because Bun evaluates top-level imports in declaration
 * order, a test file that imports an application module (e.g. `src/app.ts`)
 * without first running this bootstrap would trip that fail-fast and never
 * reach any real test code.
 *
 * We pin the NyxID + chrono-storage URLs to fixed loopback ports that the
 * fixture server in `./fixture-server.ts` also binds to. These ports are in
 * the high range (37xxx) so they don't collide with any real local service.
 *
 * The ports are intentionally the same across every E2E file — Bun runs all
 * tests inside a single `bun test` invocation in one process, so the fixture
 * server becomes a singleton that all E2E files share (see `startFixture` in
 * `./fixture-server.ts`).
 */
process.env.BASE_URL ??= "http://localhost:7701";
process.env.DATABASE_URL ??= "postgres://localhost/test";
process.env.CHRONO_STORAGE_URL ??= "http://127.0.0.1:37050";
process.env.NYXID_BASE_URL ??= "http://127.0.0.1:37051";
process.env.NYXID_JWKS_URL ??= "http://127.0.0.1:37051/.well-known/jwks.json";
process.env.NYXID_SERVICE_SECRET ??=
  "test-secret-test-secret-test-secret-xxxxxxxxxx";
process.env.NODE_ENV ??= "test";

/**
 * Fixed ports the fixture HTTP servers bind to. Kept in sync with the URLs
 * above; if you change one, change both.
 */
export const FIXTURE_CHRONO_PORT = 37050;
export const FIXTURE_NYXID_PORT = 37051;
