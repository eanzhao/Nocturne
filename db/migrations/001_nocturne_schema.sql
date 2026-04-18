-- Nocturne v0-alpha schema (idempotent).
-- Apply against the Supabase Postgres the user has configured
-- (currently shared with the `gbrain` project — we live under
-- our own `nocturne` schema so there is zero table-name overlap).

CREATE SCHEMA IF NOT EXISTS nocturne;

-- ---------------------------------------------------------------
-- pages: one row per generated Nocturne page.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS nocturne.pages (
  page_id      TEXT        PRIMARY KEY,
  user_id      UUID        NOT NULL,
  storage_key  TEXT        NOT NULL,
  spec_id      TEXT        NOT NULL,
  content_type TEXT        NOT NULL,
  rating       TEXT,                                    -- 'good' | 'bad' | NULL
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pages_user_id   ON nocturne.pages (user_id);
CREATE INDEX IF NOT EXISTS idx_pages_created   ON nocturne.pages (created_at DESC);

-- ---------------------------------------------------------------
-- page_sequence: atomic per-user monotonic Issue #.
-- UPSERT on every POST /format:
--   INSERT INTO nocturne.page_sequence (user_id, last_seq) VALUES ($1, 1)
--   ON CONFLICT (user_id) DO UPDATE
--     SET last_seq = nocturne.page_sequence.last_seq + 1
--   RETURNING last_seq;
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS nocturne.page_sequence (
  user_id  UUID   PRIMARY KEY,
  last_seq BIGINT NOT NULL DEFAULT 0
);

-- ---------------------------------------------------------------
-- planner_fallback_log: mining data for prompt refinement in v1.5.
-- Populated when the LLM returns a spec_id outside the enum or
-- when JSON validation succeeds but with a fallback_reason.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS nocturne.planner_fallback_log (
  id              BIGSERIAL   PRIMARY KEY,
  page_id         TEXT        REFERENCES nocturne.pages(page_id),
  fallback_reason TEXT        NOT NULL,
  raw_llm_output  JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_planner_fallback_reason
  ON nocturne.planner_fallback_log (fallback_reason);

-- ---------------------------------------------------------------
-- archive_share_tokens: shareable URLs for /u/{slug}?token=...
-- plaintext is returned ONCE on creation; we store SHA-256 hash.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS nocturne.archive_share_tokens (
  token_id    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL,
  token_hash  TEXT        UNIQUE NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at  TIMESTAMPTZ,
  revoked_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_archive_share_tokens_user
  ON nocturne.archive_share_tokens (user_id);

CREATE INDEX IF NOT EXISTS idx_archive_share_tokens_active
  ON nocturne.archive_share_tokens (user_id)
  WHERE revoked_at IS NULL;
