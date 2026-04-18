/**
 * Tests for `planDailyBrief`. We inject a fake `fetch` via `PlannerOptions`
 * so nothing escapes the process.
 *
 * `src/config.ts` throws at import time when required env vars are missing,
 * so the tests set valid values on `process.env` before `await import()`ing
 * the gateway module.
 */

import { beforeAll, describe, expect, test } from 'bun:test';

import type { FetchLike } from './gateway.ts';

// Set the env BEFORE importing anything that transitively loads config.ts.
// We use `??=` so we cooperate with other test files that share the same
// process and may have already primed these (see src/middleware/auth.test.ts).
// `config` reads env exactly once at module import, so the first test file to
// touch it wins. Tests that depend on a specific base URL must pass it
// explicitly via `baseUrl` in PlannerOptions.
const ENV_DEFAULTS: Record<string, string> = {
  BASE_URL: 'http://localhost:7701',
  DATABASE_URL: 'postgresql://u:p@h:5432/d',
  CHRONO_STORAGE_URL: 'http://127.0.0.1:3805',
  NYXID_BASE_URL: 'https://nyx-api.test',
  NYXID_JWKS_URL: 'https://nyx-api.test/.well-known/jwks.json',
  NYXID_JWT_ISSUER: 'https://nyx-api.test',
  NYXID_JWT_AUDIENCE: 'nocturne',
  NYXID_SERVICE_SECRET: 'x'.repeat(32),
};
for (const [k, v] of Object.entries(ENV_DEFAULTS)) {
  process.env[k] ??= v;
}

// Lazy-imported so the env is in place first.
type GatewayModule = typeof import('./gateway.ts');
let gateway: GatewayModule;

beforeAll(async () => {
  gateway = await import('./gateway.ts');
});

// -- Helpers ----------------------------------------------------------------

function makeJsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return new Response(text, {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function wrapLLMContent(content: string | object): object {
  return {
    choices: [
      {
        message: {
          content: typeof content === 'string' ? content : JSON.stringify(content),
        },
      },
    ],
  };
}

const VALID_BRIEF = {
  content_type: 'daily_brief_v1',
  title: 'Morning digest',
  spec_id: 'executive-broadsheet',
  top_priorities: [{ title: 'Ship the planner' }],
};

// -- Tests ------------------------------------------------------------------

describe('planDailyBrief', () => {
  test('happy path — mock fetch returns valid JSON → parsed DailyBrief returned', async () => {
    let calledUrl = '';
    let calledInit: RequestInit | undefined;
    const fetchImpl: FetchLike = async (url, init) => {
      calledUrl = String(url);
      calledInit = init;
      return makeJsonResponse(200, wrapLLMContent(VALID_BRIEF));
    };

    const result = await gateway.planDailyBrief('raw content', 'tok_abc', {
      fetchImpl,
      baseUrl: 'https://nyx-api.example',
    });

    expect(result.brief.content_type).toBe('daily_brief_v1');
    expect(result.brief.title).toBe('Morning digest');
    expect(result.brief.spec_id).toBe('executive-broadsheet');
    expect(result.brief.top_priorities).toHaveLength(1);
    expect(result.fallbackReason).toBeUndefined();
    expect(result.rawLLMOutput).toBeUndefined();

    expect(calledUrl).toBe('https://nyx-api.example/api/v1/llm/gateway/v1/chat/completions');
    const headers = new Headers(calledInit!.headers);
    expect(headers.get('authorization')).toBe('Bearer tok_abc');
    expect(headers.get('content-type')).toBe('application/json');

    const sentBody = JSON.parse(String(calledInit!.body));
    expect(sentBody.model).toBe('gpt-5.4'); // default
    expect(sentBody.response_format).toEqual({ type: 'json_object' });
    expect(sentBody.messages).toHaveLength(2);
    expect(sentBody.messages[0].role).toBe('system');
    expect(sentBody.messages[1].role).toBe('user');
    expect(sentBody.messages[1].content).toContain('<brief>');
    expect(sentBody.messages[1].content).toContain('raw content');
  });

  test('custom model from options overrides config', async () => {
    let sentModel = '';
    const fetchImpl: FetchLike = async (_url, init) => {
      sentModel = JSON.parse(String(init!.body)).model;
      return makeJsonResponse(200, wrapLLMContent(VALID_BRIEF));
    };

    await gateway.planDailyBrief('raw', 'tok', {
      fetchImpl,
      model: 'claude-sonnet-4-7',
    });
    expect(sentModel).toBe('claude-sonnet-4-7');
  });

  test('invalid spec_id in otherwise-valid JSON → fallback to executive-broadsheet', async () => {
    const bad = { ...VALID_BRIEF, spec_id: 'signal-poster' };
    const fetchImpl: FetchLike = async () =>
      makeJsonResponse(200, wrapLLMContent(bad));

    const result = await gateway.planDailyBrief('raw', 'tok', { fetchImpl });

    expect(result.brief.spec_id).toBe('executive-broadsheet');
    expect(result.fallbackReason).toBe('invalid_spec_id');
    expect(result.rawLLMOutput).toEqual(bad);
  });

  test('invalid spec_id AND another schema error → hard error (no silent fallback)', async () => {
    // spec_id bad + title too long — must NOT fall back.
    const bad = {
      ...VALID_BRIEF,
      spec_id: 'nope',
      title: 'x'.repeat(300),
    };
    const fetchImpl: FetchLike = async () =>
      makeJsonResponse(200, wrapLLMContent(bad));

    await expect(
      gateway.planDailyBrief('raw', 'tok', { fetchImpl }),
    ).rejects.toBeInstanceOf(gateway.PlannerInvalidOutput);
  });

  test('malformed JSON content → throws PlannerInvalidOutput with raw string', async () => {
    const fetchImpl: FetchLike = async () =>
      makeJsonResponse(200, wrapLLMContent('{not json'));

    let caught: unknown;
    try {
      await gateway.planDailyBrief('raw', 'tok', { fetchImpl });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(gateway.PlannerInvalidOutput);
    const err = caught as InstanceType<typeof gateway.PlannerInvalidOutput>;
    expect(err.rawResponse).toBe('{not json');
  });

  test('schema failure (non spec_id) → throws PlannerInvalidOutput', async () => {
    const bad = { content_type: 'daily_brief_v1' }; // missing title + spec_id
    const fetchImpl: FetchLike = async () =>
      makeJsonResponse(200, wrapLLMContent(bad));

    await expect(
      gateway.planDailyBrief('raw', 'tok', { fetchImpl }),
    ).rejects.toBeInstanceOf(gateway.PlannerInvalidOutput);
  });

  test('soft timeout → throws PlannerTimeout (fetch never resolves, short timeout)', async () => {
    // fetch honors the provided AbortSignal → rejects with AbortError once aborted.
    const fetchImpl: FetchLike = (_url, init) => {
      return new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (signal) {
          signal.addEventListener('abort', () => {
            // Mimic what real fetch does: reject with the signal's reason.
            const reason =
              signal.reason ??
              new DOMException('The operation was aborted.', 'AbortError');
            reject(reason);
          });
        }
      });
    };

    const started = Date.now();
    await expect(
      gateway.planDailyBrief('raw', 'tok', { fetchImpl, timeoutMs: 50 }),
    ).rejects.toBeInstanceOf(gateway.PlannerTimeout);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test('429 rate-limit → throws PlannerRateLimited (passthrough)', async () => {
    const fetchImpl: FetchLike = async () =>
      makeJsonResponse(429, { error: 'slow down' }, { 'retry-after': '30' });

    let caught: unknown;
    try {
      await gateway.planDailyBrief('raw', 'tok', { fetchImpl });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(gateway.PlannerRateLimited);
    const err = caught as InstanceType<typeof gateway.PlannerRateLimited>;
    expect(err.retryAfter).toBe('30');
    expect(err.body).toContain('slow down');
  });

  test('non-200 non-429 → throws PlannerUpstreamError', async () => {
    const fetchImpl: FetchLike = async () =>
      makeJsonResponse(500, { error: 'boom' });

    let caught: unknown;
    try {
      await gateway.planDailyBrief('raw', 'tok', { fetchImpl });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(gateway.PlannerUpstreamError);
    const err = caught as InstanceType<typeof gateway.PlannerUpstreamError>;
    expect(err.status).toBe(500);
  });
});
