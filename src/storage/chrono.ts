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
 * Download the raw bytes of `bucket/key`.
 *
 * Timeout: 5s. Throws `not_found` (404) distinctly from `unavailable` (5xx).
 */
export async function getObject(
  bucket: string,
  key: string,
): Promise<{ body: ArrayBuffer; contentType: string }> {
  const url = buildObjectUrl(bucket, key);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      signal: AbortSignal.timeout(TIMEOUT_GET_MS),
    });
  } catch (err) {
    throw toStorageError(err, "GET", bucket, key);
  }

  if (res.status === 404) {
    const upstreamCode = await extractUpstreamCode(res);
    throw new StorageError(
      "not_found",
      `chrono-storage GET ${bucket}/${key}: not found`,
      { status: 404, upstreamCode },
    );
  }
  if (res.status >= 500) {
    const upstreamCode = await extractUpstreamCode(res);
    throw new StorageError(
      "unavailable",
      `chrono-storage GET ${bucket}/${key}: upstream ${res.status}`,
      { status: res.status, upstreamCode },
    );
  }
  if (!res.ok) {
    const upstreamCode = await extractUpstreamCode(res);
    throw new StorageError(
      "integrity",
      `chrono-storage GET ${bucket}/${key}: ${res.status} ${upstreamCode ?? ""}`.trim(),
      { status: res.status, upstreamCode },
    );
  }

  let body: ArrayBuffer;
  try {
    body = await res.arrayBuffer();
  } catch (err) {
    throw new StorageError(
      "integrity",
      `chrono-storage GET ${bucket}/${key}: body read failed`,
      { status: res.status, cause: err },
    );
  }

  // chrono-storage sets Content-Type on HEAD; GET here returns the object
  // body directly, so we fall back to the response's own Content-Type.
  const contentType =
    res.headers.get("content-type") ?? "application/octet-stream";
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
  head: TIMEOUT_HEAD_MS,
} as const;
