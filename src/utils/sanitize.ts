/**
 * Text sanitization for renderer block inputs.
 *
 * Nocturne treats all content strings as untrusted user/LLM input. Every
 * renderer block funnels every string field through `sanitizeText` before
 * handing it to Hono JSX (which already escapes). This function handles the
 * layer _above_ escaping: invisible characters, whitespace ballooning, and
 * hard size caps that protect the page budget.
 *
 * Three things happen here, in order:
 *   1. Hard byte-size gate. Anything above `HARD_LIMIT_BYTES` is rejected.
 *      This stops a malicious caller from shipping a megabyte of homoglyphs
 *      that would pass `maxLen` after collapsing.
 *   2. Zero-width / control stripping. Removes characters that render as
 *      nothing but inflate length, break layout, or spoof the visible text
 *      (classic homograph attacks).
 *   3. Whitespace normalization + truncation. Collapses runs of any
 *      whitespace (including CJK full-width space) to a single ASCII space,
 *      trims ends, and truncates to `maxLen` characters with an ellipsis.
 *
 * `maxLen` is enforced in _characters_ (JS code units, good enough for
 * pre-sanitized short text), not bytes. Callers pass the schema's per-field
 * max (e.g. `title: 200`).
 */

/** Absolute upper bound on any single input string — 10 KB of UTF-16 bytes. */
const HARD_LIMIT_BYTES = 10 * 1024;

/**
 * Characters to strip entirely before further processing.
 *
 *   \u200B ZERO WIDTH SPACE
 *   \u200C ZERO WIDTH NON-JOINER
 *   \u200D ZERO WIDTH JOINER
 *   \u200E LEFT-TO-RIGHT MARK
 *   \u200F RIGHT-TO-LEFT MARK
 *   \u202A-\u202E bidi embedding / override controls (spoof protection)
 *   \u2060 WORD JOINER
 *   \u2066-\u2069 isolate controls
 *   \uFEFF BOM / ZWNBSP
 *   ASCII C0 controls except \t \n \r (keep those so whitespace collapse sees them)
 */
const ZERO_WIDTH_AND_CONTROLS_RE =
  // eslint-disable-next-line no-control-regex
  /[\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/**
 * Any Unicode whitespace run → single ASCII space.
 *
 * `\s` in JS regex already matches `\u3000` (ideographic space) and other
 * Unicode space separators when the `u` flag is on.
 */
const WHITESPACE_RUN_RE = /\s+/gu;

/**
 * Strip zero-width / control characters, normalize whitespace, and truncate.
 *
 * @param s      Raw input string.
 * @param maxLen Maximum length in JS code units after cleanup.
 * @throws If the input exceeds {@link HARD_LIMIT_BYTES} in UTF-16 bytes.
 */
export function sanitizeText(s: string, maxLen: number): string {
  if (typeof s !== 'string') {
    // Defense in depth — schema layer should have caught this.
    throw new TypeError('sanitizeText expects a string');
  }

  // 2-bytes-per-JS-char is a fine upper bound for the purpose of the gate.
  // We only need to reject abusive sizes; we don't need exact UTF-8 bytes.
  const approxBytes = s.length * 2;
  if (approxBytes > HARD_LIMIT_BYTES) {
    throw new RangeError(
      `sanitizeText: input exceeds hard limit (${HARD_LIMIT_BYTES} bytes)`,
    );
  }

  if (maxLen < 0 || !Number.isFinite(maxLen)) {
    throw new RangeError('sanitizeText: maxLen must be a non-negative finite number');
  }

  const stripped = s.replace(ZERO_WIDTH_AND_CONTROLS_RE, '');
  const collapsed = stripped.replace(WHITESPACE_RUN_RE, ' ').trim();

  if (collapsed.length <= maxLen) {
    return collapsed;
  }

  // Truncate with an ellipsis so the reader sees the cut was intentional.
  // We must fit the ellipsis inside maxLen.
  if (maxLen <= 1) {
    return collapsed.slice(0, maxLen);
  }
  return collapsed.slice(0, Math.max(0, maxLen - 1)) + '\u2026';
}

/**
 * Convenience: sanitize an optional field, returning `undefined` when the
 * input is nullish or sanitizes to the empty string.
 */
export function sanitizeOptional(
  s: string | undefined | null,
  maxLen: number,
): string | undefined {
  if (s === undefined || s === null) return undefined;
  const out = sanitizeText(s, maxLen);
  return out.length === 0 ? undefined : out;
}
