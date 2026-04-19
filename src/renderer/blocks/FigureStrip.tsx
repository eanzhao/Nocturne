/** @jsxImportSource hono/jsx */
import type { DailyBrief } from '../../schema/daily-brief.ts';
import { FigurePlate } from './FigurePlate.tsx';

/**
 * Figure strip block — renders one FigurePlate per visual_intent.
 *
 * Used by specs that want a row of figures (bauhaus-modular,
 * constructivist-agitprop). Each FigurePlate independently degrades
 * to placeholder if its asset is missing, so partial generation
 * results still produce a coherent strip.
 */
export function FigureStrip({
  brief,
  pageIdHint,
}: {
  brief: DailyBrief;
  pageIdHint?: string;
}) {
  const intents = brief.visual_intents;
  if (!intents || intents.length === 0) return null;

  return (
    <div class="figure-strip">
      {intents.map((intent) => (
        <FigurePlate brief={brief} blockRef={intent.block_ref} pageIdHint={pageIdHint} />
      ))}
    </div>
  );
}
