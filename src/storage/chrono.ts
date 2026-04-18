/**
 * chrono-storage HTTP client.
 *
 * Thin wrapper over `fetch` with **explicit** per-call timeouts. Bun's default
 * `fetch` has no timeout at all — every call in this service MUST pass
 * `AbortSignal.timeout(N)`.
 *
 * Error surface: every failure throws a typed {@link StorageError} whose
 * `.code` is one of `timeout | not_found | unavailable | integrity`. No retry
 * logic in v0 — the caller decides what to do.
 *
 * See [`docs/Api.md` in chrono-storage](../../../chrono-storage/docs/Api.md)
 * for the upstream contract.
 */
import { config } from "../config.ts";

export type StorageErrorCode =
  | "timeout"
  | "not_found"
  | "unavailable"
  | "integrity";

export class StorageError extends Error {
  readonly code: StorageErrorCode;
  readonly status: number | undefined;
  readonly upstreamCode: string | undefined;
  override readonly cause: unknown;

  constructor(
    code: StorageErrorCode,
    message: string,
    opts: {
      status?: number;
      upstreamCode?: string;
      cause?: unknown;
    } = {},
  ) {
    super(message);
    this.name = "StorageError";
    this.code = code;
    this.status = opts.status;
    this.upstreamCode = opts.upstreamCode;
    this.cause = opts.cause;
  }
}

// Timeouts per spec in issue #2.
const TIMEOUT_PUT_MS = 8_000;
const TIMEOUT_GET_MS = 5_000;
const TIMEOUT_HEAD_MS = 3_000;
// Internal split of the 5s GET budget across the two-hop presigned-URL flow.
// 2s to mint + 3s to fetch body; neither hop can starve the other.
const TIMEOUT_GET_MINT_MS = 2_000;
const TIMEOUT_GET_BODY_MS = 3_000;

/**
 * Build an absolute chrono-storage URL with `key` (and any extra) query
 * parameters. `key` is never URL-encoded by callers — we do it here.
 */
function buildObjectUrl(
  bucket: string,
  key: string,
  extra?: Record<string, string | undefined>,
): string {
  const base = config.CHRONO_STORAGE_URL.replace(/\/+$/, "");
  const u = new URL(
    `${base}/api/buckets/${encodeURIComponent(bucket)}/objects`,
  );
  u.searchParams.set("key", key);
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      if (v !== undefined) u.searchParams.set(k, v);
    }
  }
  return u.toString();
}

/**
 * Normalise a thrown `fetch` error into a {@link StorageError}.
 *
 * Bun's `fetch` surfaces abort-via-timeout as a `DOMException` with
 * `.name === "TimeoutError"` (when the signal came from
 * `AbortSignal.timeout`) or `.name === "AbortError"` (generic abort). We treat
 * both as `timeout` because in this module aborts only come from our own
 * `AbortSignal.timeout(...)`.
 */
function toStorageError(
  err: unknown,
  verb: string,
  bucket: string,
  key: string,
): StorageError {
  if (err instanceof StorageError) return err;
  if (err instanceof Error) {
    const n = err.name;
    if (n === "TimeoutError" || n === "AbortError") {
      return new StorageError(
        "timeout",
        `chrono-storage ${verb} ${bucket}/${key} timed out`,
        { cause: err },
      );
    }
  }
  return new StorageError(
    "unavailable",
    `chrono-storage ${verb} ${bucket}/${key} network error`,
    { cause: err },
  );
}

/** Best-effort extract of the `error.code` field from the JSON envelope. */
async function extractUpstreamCode(res: Response): Promise<string | undefined> {
  try {
    const clone = res.clone();
    const body = (await clone.json()) as {
      error?: { code?: unknown } | null;
    } | null;
    const code = body?.error?.code;
    return typeof code === "string" ? code : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Upload `body` to `bucket/key`.
 *
 * Timeout: 8s.
 */
export async function putObject(
  bucket: string,
  key: string,
  body: Uint8Array | ArrayBuffer | string,
  contentType: string,
): Promise<{ url: string }> {
  const url = buildObjectUrl(bucket, key, { contentType });
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      // `fetch` in Bun accepts string / Uint8Array / ArrayBuffer directly; we
      // narrow to the caller-supplied body without casting through a
      // browser-lib type that isn't in `tsconfig.json`'s `lib`.
      body: body as string | Uint8Array | ArrayBuffer,
      headers: { "Content-Type": contentType },
      signal: AbortSignal.timeout(TIMEOUT_PUT_MS),
    });
  } catch (err) {
    throw toStorageError(err, "PUT", bucket, key);
  }

  if (!res.ok) {
    const upstreamCode = await extractUpstreamCode(res);
    if (res.status === 404) {
      throw new StorageError(
        "not_found",
        `chrono-storage PUT ${bucket}/${key}: bucket not found`,
        { status: res.status, upstreamCode },
      );
    }
    if (res.status >= 500) {
      throw new StorageError(
        "unavailable",
        `chrono-storage PUT ${bucket}/${key}: upstream ${res.status}`,
        { status: res.status, upstreamCode },
      );
    }
    throw new StorageError(
      "integrity",
      `chrono-storage PUT ${bucket}/${key}: ${res.status} ${upstreamCode ?? ""}`.trim(),
      { status: res.status, upstreamCode },
    );
  }

  // Envelope: { data: { url: "s3://..." }, error: null }
  let json: { data?: { url?: unknown } | null } | null = null;
  try {
    json = (await res.json()) as {
      data?: { url?: unknown } | null;
    };
  } catch (err) {
    throw new StorageError(
      "integrity",
      `chrono-storage PUT ${bucket}/${key}: invalid JSON response`,
      { status: res.status, cause: err },
    );
  }
  const returnedUrl = json?.data?.url;
  if (typeof returnedUrl !== "string" || returnedUrl.length === 0) {
    throw new StorageError(
      "integrity",
      `chrono-storage PUT ${bucket}/${key}: missing url in response`,
      { status: res.status },
    );
  }
  return { url: returnedUrl };
}

/**
 * Build the presigned-URL endpoint for reading `bucket/key`.
 */
function buildPresignedUrlEndpoint(bucket: string, key: string): string {
  const base = config.CHRONO_STORAGE_URL.replace(/\/+$/, "");
  const u = new URL(
    `${base}/api/buckets/${encodeURIComponent(bucket)}/presigned-url`,
  );
  u.searchParams.set("key", key);
  return u.toString();
}

/**
 * Download the raw bytes of `bucket/key`.
 *
 * chrono-storage has no content-retrieval endpoint on `/api/buckets/:bucket/objects`
 * — that path is the LIST endpoint. The real object-body flow is two HTTP calls:
 *
 *   1. `GET /api/buckets/:bucket/presigned-url?key=K` → `{presignedUrl, expiresAt}`
 *   2. `fetch(presignedUrl)` → the actual S3 response body.
 *
 * Both hops share the 5s budget; the first gets 2s and the second gets the
 * remaining 3s, so a stuck mint can't starve the body fetch.
 *
 * Timeout: 5s total. Throws `not_found` (404 from either hop) distinctly from
 * `unavailable` (5xx).
 */
export async function getObject(
  bucket: string,
  key: string,
): Promise<{ body: ArrayBuffer; contentType: string }> {
  // --- Hop 1: mint the presigned URL -----------------------------------------
  const mintUrl = buildPresignedUrlEndpoint(bucket, key);
  let mintRes: Response;
  try {
    mintRes = await fetch(mintUrl, {
      method: "GET",
      signal: AbortSignal.timeout(TIMEOUT_GET_MINT_MS),
    });
  } catch (err) {
    throw toStorageError(err, "GET(mint)", bucket, key);
  }

  if (mintRes.status === 404) {
    const upstreamCode = await extractUpstreamCode(mintRes);
    throw new StorageError(
      "not_found",
      `chrono-storage GET ${bucket}/${key}: not found`,
      { status: 404, upstreamCode },
    );
  }
  if (mintRes.status >= 500) {
    const upstreamCode = await extractUpstreamCode(mintRes);
    throw new StorageError(
      "unavailable",
      `chrono-storage GET ${bucket}/${key}: mint upstream ${mintRes.status}`,
      { status: mintRes.status, upstreamCode },
    );
  }
  if (!mintRes.ok) {
    const upstreamCode = await extractUpstreamCode(mintRes);
    throw new StorageError(
      "integrity",
      `chrono-storage GET ${bucket}/${key}: mint ${mintRes.status} ${upstreamCode ?? ""}`.trim(),
      { status: mintRes.status, upstreamCode },
    );
  }

  let mintJson: {
    data?: { presignedUrl?: unknown; expiresAt?: unknown } | null;
  } | null = null;
  try {
    mintJson = (await mintRes.json()) as {
      data?: { presignedUrl?: unknown; expiresAt?: unknown } | null;
    };
  } catch (err) {
    throw new StorageError(
      "integrity",
      `chrono-storage GET ${bucket}/${key}: mint returned non-JSON`,
      { status: mintRes.status, cause: err },
    );
  }
  const presignedUrl = mintJson?.data?.presignedUrl;
  if (typeof presignedUrl !== "string" || presignedUrl.length === 0) {
    throw new StorageError(
      "integrity",
      `chrono-storage GET ${bucket}/${key}: mint missing presignedUrl`,
      { status: mintRes.status },
    );
  }

  // --- Hop 2: fetch the object body ------------------------------------------
  let bodyRes: Response;
  try {
    bodyRes = await fetch(presignedUrl, {
      method: "GET",
      signal: AbortSignal.timeout(TIMEOUT_GET_BODY_MS),
    });
  } catch (err) {
    throw toStorageError(err, "GET(body)", bucket, key);
  }

  if (bodyRes.status === 404) {
    // S3 404 after a successful mint means the object was deleted between
    // hops (or the presigned URL was scoped to a non-existent key, which
    // the mint endpoint SHOULD have rejected). Either way: not_found.
    throw new StorageError(
      "not_found",
      `chrono-storage GET ${bucket}/${key}: object gone after mint`,
      { status: 404 },
    );
  }
  if (bodyRes.status >= 500) {
    throw new StorageError(
      "unavailable",
      `chrono-storage GET ${bucket}/${key}: body upstream ${bodyRes.status}`,
      { status: bodyRes.status },
    );
  }
  if (!bodyRes.ok) {
    throw new StorageError(
      "integrity",
      `chrono-storage GET ${bucket}/${key}: body ${bodyRes.status}`,
      { status: bodyRes.status },
    );
  }

  let body: ArrayBuffer;
  try {
    body = await bodyRes.arrayBuffer();
  } catch (err) {
    throw new StorageError(
      "integrity",
      `chrono-storage GET ${bucket}/${key}: body read failed`,
      { status: bodyRes.status, cause: err },
    );
  }

  const contentType =
    bodyRes.headers.get("content-type") ?? "application/octet-stream";
  return { body, contentType };
}

/**
 * Probe whether `bucket/key` exists.
 *
 * Timeout: 3s. Returns `true` on 2xx, `false` on 404. Any other status or a
 * network error surfaces as a {@link StorageError} — an unknown upstream
 * condition must NOT be silently collapsed to "absent".
 */
export async function objectExists(
  bucket: string,
  key: string,
): Promise<boolean> {
  const url = buildObjectUrl(bucket, key);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "HEAD",
      signal: AbortSignal.timeout(TIMEOUT_HEAD_MS),
    });
  } catch (err) {
    throw toStorageError(err, "HEAD", bucket, key);
  }

  if (res.status === 404) return false;
  if (res.ok) return true;
  if (res.status >= 500) {
    throw new StorageError(
      "unavailable",
      `chrono-storage HEAD ${bucket}/${key}: upstream ${res.status}`,
      { status: res.status },
    );
  }
  throw new StorageError(
    "integrity",
    `chrono-storage HEAD ${bucket}/${key}: unexpected ${res.status}`,
    { status: res.status },
  );
}

/** Exposed for tests — the concrete timeout constants. */
export const __TIMEOUTS__ = {
  put: TIMEOUT_PUT_MS,
  get: TIMEOUT_GET_MS,
  getMint: TIMEOUT_GET_MINT_MS,
  getBody: TIMEOUT_GET_BODY_MS,
  head: TIMEOUT_HEAD_MS,
} as const;
