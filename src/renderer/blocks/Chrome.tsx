/** @jsxImportSource hono/jsx */
import { sanitizeText } from '../../utils/sanitize.ts';

/**
 * Rendering context for the chrome zone.
 *
 * The chrome is the ONE part of the page that is not purely content-driven
 * — it has to know *which* page it is (for the rate endpoint and the
 * "all your Nocturnes" link) and *when/by whom* it was generated (for the
 * provenance strip).
 *
 *   - `user_id` — the NyxID user who owns the page. Empty string is a
 *     valid value in dev / preview mode (no owner).
 *   - `seq` — monotonic issue number for this user ("#42" on the strip).
 *   - `page_id` — opaque slug that routes here.
 *   - `created_at` — ISO8601, rendered as a human date.
 *   - `model` — LLM model identifier used to author the brief.
 *   - `owner_slug` — optional; when present, the "All your Nocturnes" link
 *     goes to `/u/{owner_slug}` (matches the mounted archive route in app.ts);
 *     otherwise the link is suppressed.
 */
export interface ChromeCtx {
  user_id: string;
  seq: number;
  page_id: string;
  created_at: string;
  model: string;
  owner_slug?: string;
}

/**
 * Chrome zone block.
 *
 * Rendered OUTSIDE the content columns as a flex strip near the page foot.
 * All interactive behavior lives in a single inline <script> appended at
 * the end of the document — no framework, no hydration.
 *
 * Markup contract (from `src/renderer/blocks/TODO.md`):
 *
 *   - `.chrome-zone` wraps the group. `print.css` keys off this class.
 *   - The Export-as-PDF button has `data-action="export-pdf"` and a sibling
 *     popover with `data-nocturne-popover="export-pdf"` that starts hidden.
 *   - Rate buttons post to `/v/{slug}/rate?score=good|bad`. The UI shows
 *     "up"/"down" on `data-rating`; the script maps to the backend enum.
 *   - Copy-permalink button uses `navigator.clipboard`.
 *   - A separate `.provenance-strip` (outside .chrome-zone) is archival and
 *     survives printing per print.css.
 *
 * The script at the end uses `data-*` hooks so this markup is identical for
 * every spec.
 */
export function Chrome({ ctx }: { ctx: ChromeCtx }) {
  const ownerLink =
    ctx.owner_slug !== undefined && ctx.owner_slug.length > 0
      ? `/u/${encodeURIComponent(ctx.owner_slug)}`
      : null;

  return (
    <div class="chrome-zone" data-nocturne-chrome data-page-id={ctx.page_id}>
      <button
        type="button"
        class="chrome-btn"
        data-action="export-pdf"
        aria-haspopup="dialog"
      >
        Export as PDF
      </button>

      <div class="rate-group" role="group" aria-label="Rate this page">
        <button
          type="button"
          class="chrome-btn"
          data-action="rate"
          data-rating="up"
          aria-label="Rate up"
        >
          <span aria-hidden="true">▲</span> Good
        </button>
        <button
          type="button"
          class="chrome-btn"
          data-action="rate"
          data-rating="down"
          aria-label="Rate down"
        >
          <span aria-hidden="true">▼</span> Bad
        </button>
      </div>

      <button
        type="button"
        class="chrome-btn"
        data-action="copy-permalink"
      >
        Copy permalink
      </button>

      {ownerLink !== null ? (
        <a class="chrome-btn" href={ownerLink}>
          All your Nocturnes
        </a>
      ) : null}

      <div class="spacer" />

      <div
        class="export-pdf-popover"
        data-nocturne-popover="export-pdf"
        role="dialog"
        hidden
      >
        Use &ldquo;Save as PDF&rdquo; in your browser&rsquo;s print dialog.
      </div>
    </div>
  );
}

/**
 * Provenance strip — separate from the chrome buttons because
 * `print.css` explicitly preserves this on paper while hiding the rest.
 *
 * Shape: `Issue #<seq> · <YYYY-MM-DD> · <model> · NOCTURNE`
 */
export function ProvenanceStrip({ ctx }: { ctx: ChromeCtx }) {
  const date = toDateLabel(ctx.created_at);
  const model = sanitizeText(ctx.model, 80);
  const seq = Math.max(0, Math.floor(ctx.seq));
  return (
    <footer class="provenance-strip" aria-label="Page metadata">
      <span class="issue">Issue #{seq}</span>
      <span class="sep" aria-hidden="true">·</span>
      <span class="date">{date}</span>
      <span class="sep" aria-hidden="true">·</span>
      <span class="model">{model}</span>
      <span class="sep" aria-hidden="true">·</span>
      <span class="wordmark">NOCTURNE</span>
    </footer>
  );
}

/**
 * Convert an ISO string to `YYYY-MM-DD` without pulling in a date library.
 * Returns the input unchanged if it doesn't parse, which is the safe thing
 * to do — misparsing would silently render the wrong date.
 */
function toDateLabel(iso: string): string {
  const sanitized = sanitizeText(iso, 40);
  const d = new Date(sanitized);
  if (Number.isNaN(d.getTime())) return sanitized;
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Inline script for the chrome zone. Keep it small, vanilla, and safe:
 *
 *   - Export: unhide the popover and call window.print(). Popover dismisses
 *     on any subsequent outside-click.
 *   - Rate: POST `/v/{page_id}/rate` with `{rating}` JSON body. Optimistically
 *     set aria-pressed on the clicked button; on network failure, roll back
 *     and toggle a brief error via title attribute.
 *   - Copy: navigator.clipboard.writeText(location.href); toggle title.
 *
 * This script is emitted verbatim into the HTML (no templating) so it stays
 * reviewable.
 */
export const CHROME_SCRIPT = String.raw`
(function () {
  var root = document.querySelector('[data-nocturne-chrome]');
  if (!root) return;
  var pageId = root.getAttribute('data-page-id') || '';
  var popover = root.querySelector('[data-nocturne-popover="export-pdf"]');
  var exportBtn = root.querySelector('[data-action="export-pdf"]');
  var rateBtns = root.querySelectorAll('[data-action="rate"]');
  var copyBtn = root.querySelector('[data-action="copy-permalink"]');
  var popoverJustOpened = false;

  function openPopover() {
    if (!popover) return;
    popover.hidden = false;
    popoverJustOpened = true;
    setTimeout(function () { popoverJustOpened = false; }, 0);
  }
  function closePopover() {
    if (popover) popover.hidden = true;
  }

  if (exportBtn) {
    exportBtn.addEventListener('click', function () {
      openPopover();
      try { window.print(); } catch (e) {}
    });
  }

  document.addEventListener('click', function (e) {
    if (popoverJustOpened) return;
    if (popover && popover.contains(e.target)) return;
    closePopover();
  });

  rateBtns.forEach(function (btn) {
    btn.addEventListener('click', function () {
      var rating = btn.getAttribute('data-rating');
      if (!pageId || !rating) return;
      // Map UI "up"/"down" to backend contract "good"/"bad" per src/routes/rate.ts.
      var score = rating === 'up' ? 'good' : rating === 'down' ? 'bad' : null;
      if (!score) return;
      var prev = btn.getAttribute('aria-pressed');
      btn.setAttribute('aria-pressed', 'true');
      fetch('/v/' + encodeURIComponent(pageId) + '/rate?score=' + score, {
        method: 'POST'
      }).catch(function () {
        btn.setAttribute('aria-pressed', prev || 'false');
        btn.setAttribute('title', 'Rate failed — try again');
      });
    });
  });

  if (copyBtn && navigator.clipboard) {
    copyBtn.addEventListener('click', function () {
      navigator.clipboard.writeText(location.href).then(function () {
        copyBtn.setAttribute('title', 'Copied');
      }).catch(function () {
        copyBtn.setAttribute('title', 'Copy failed');
      });
    });
  }
})();
`;
