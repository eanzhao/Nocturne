/**
 * Test-only bootstrap: guarantees the env vars `src/config.ts` requires are
 * populated BEFORE any transitive import of it evaluates.
 *
 * Imported at the very top of test files that touch modules depending on
 * `config`. Imports are hoisted in declaration order, so placing this import
 * first means its side-effects run before `./chrono.ts` (and its `config`
 * import chain) are evaluated.
 */
process.env.BASE_URL ??= "http://localhost:7701";
process.env.DATABASE_URL ??= "postgres://localhost/test";
process.env.CHRONO_STORAGE_URL ??= "http://127.0.0.1:3805";
process.env.NYXID_BASE_URL ??= "http://127.0.0.1:9000";
process.env.NYXID_JWKS_URL ??= "http://127.0.0.1:9000/.well-known/jwks.json";
process.env.NYXID_JWT_ISSUER ??= "http://127.0.0.1:9000";
process.env.NYXID_JWT_AUDIENCE ??= "nocturne";
process.env.NYXID_SERVICE_SECRET ??=
  "test-secret-test-secret-test-secret-xxxxxxxxxx";
