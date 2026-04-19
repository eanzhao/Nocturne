/** @jsxImportSource hono/jsx */
import type { DailyBrief } from '../../schema/daily-brief.ts';
import { sanitizeOptional } from '../../utils/sanitize.ts';

/**
 * Single-figure plate block.
 *
 * Reads ONE `visual_intent` + matching `visual_asset` by `blockRef`.
 * Three rendering states:
 *   1. No matching intent → returns null (block absent from layout).
 *   2. Intent present, asset absent or status != 'ok' → typographic
 *      placeholder (caption/credit only). Preserves layout slot so the
 *      page doesn't reflow when the asset eventually arrives.
 *   3. Intent + ok-status asset → real <img> or <video> rendered via
 *      the media proxy `/m/{page_id}/{block_ref}`.
 *
 * The `pageIdHint` prop lets the renderer inject the page id for the
 * media proxy URL without FigurePlate needing to know about routing.
 * Default is "page-id-placeholder" (tests / fallback).
 */
export function FigurePlate({
  brief,
  blockRef,
  pageIdHint,
}: {
  brief: DailyBrief;
  blockRef: string;
  pageIdHint?: string;
}) {
  const intent = brief.visual_intents?.find((i) => i.block_ref === blockRef);
  if (!intent) return null;

  const asset = brief.visual_assets?.find((a) => a.block_ref === blockRef);
  const ok = asset?.status === 'ok';
  const pageId = pageIdHint ?? 'page-id-placeholder';
  const mediaUrl = `/m/${pageId}/${blockRef}`;
  const posterUrl = `/m/${pageId}/${blockRef}/poster`;

  const caption = sanitizeOptional(intent.caption, 200);
  const credit = sanitizeOptional(intent.credit, 120);
  const alt = sanitizeOptional(intent.alt, 200) ?? '';

  const spanAttr = intent.column_span ?? 'medium';
  const placementAttr = intent.placement_hint ?? 'inset';

  return (
    <figure
      class="figure-plate"
      data-block-ref={blockRef}
      data-state={ok ? 'ok' : 'placeholder'}
      data-column-span={spanAttr}
      data-placement={placementAttr}
    >
      {ok && asset!.mime.startsWith('image/') ? (
        <img src={mediaUrl} alt={alt} loading="lazy" />
      ) : null}
      {ok && asset!.mime.startsWith('video/') ? (
        <video
          src={mediaUrl}
          poster={posterUrl}
          autoplay
          loop
          muted
          playsinline
        />
      ) : null}
      {ok && !asset!.mime.startsWith('image/') && !asset!.mime.startsWith('video/') ? (
        <div class="figure-placeholder" data-reason="unsupported-mime">
          <div class="placeholder-shape" data-kind={intent.kind} />
        </div>
      ) : null}
      {!ok ? (
        <div class="figure-placeholder" aria-label="figure not yet generated">
          <div class="placeholder-shape" data-kind={intent.kind} />
        </div>
      ) : null}
      {caption !== undefined || credit !== undefined ? (
        <figcaption>
          {caption !== undefined ? <span class="caption">{caption}</span> : null}
          {credit !== undefined ? <span class="credit">{credit}</span> : null}
        </figcaption>
      ) : null}
    </figure>
  );
}
