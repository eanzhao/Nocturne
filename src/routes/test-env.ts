/**
 * Test-only env bootstrap for route tests. Must be imported FIRST — before
 * any import that transitively loads `src/config.ts`, because that file
 * reads `process.env` at module-load time and fails fast on missing vars.
 *
 * Keeping the test secret stable across test files gives us a deterministic
 * `deriveUserSlug` output, which lets the archive-share tests assert on the
 * owner slug without re-computing it.
 */
process.env.BASE_URL ??= "http://localhost:7701";
process.env.DATABASE_URL ??= "postgres://localhost/test";
process.env.CHRONO_STORAGE_URL ??= "http://127.0.0.1:3805";
process.env.NYXID_BASE_URL ??= "http://127.0.0.1:9000";
process.env.NYXID_JWKS_URL ??= "http://127.0.0.1:9000/.well-known/jwks.json";
process.env.NYXID_SERVICE_SECRET ??=
  "test-secret-test-secret-test-secret-xxxxxxxxxx";
process.env.NODE_ENV ??= "test";
