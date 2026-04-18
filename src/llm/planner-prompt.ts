/**
 * Planner prompt — the system instructions we hand to the NyxID LLM Gateway
 * when asking it to turn a user's raw daily content into a `daily_brief_v1`
 * JSON document.
 *
 * The shape of this prompt is part of the planner contract. If you edit the
 * rules or the spec_id taxonomy here, update DESIGN.md and the Zod schema
 * (`src/schema/daily-brief.ts`) in the same change.
 */

export const PLANNER_SYSTEM_PROMPT = `You are Nocturne's layout planner. Transform raw AI daily output into a compact daily_brief_v1 JSON document.

Rules:
- Do not invent facts.
- Merge duplicates.
- Keep top_priorities to 3-5 items.
- Prefer short labels over long prose.
- Choose exactly one spec_id from:
  - "executive-broadsheet": Energetic editorial daily. Use for busy days with multiple priorities, data watch, and scheduled events. Default choice when in doubt.
  - "quiet-ledger": Slow contemplative day. Use when the brief is mostly narrative prose, few priorities, no urgency, and value comes from careful reading rather than scanning.
  - "guji-classical": Ritual or classical content. Use when the brief contains divination, poetry, historical quotation, Chinese philosophical content, or explicitly asks for reverential framing. Rare.
- Return JSON only.

Schema (daily_brief_v1):
{
  "content_type": "daily_brief_v1",
  "title": "string (<=200 chars)",
  "dek": "string (<=280 chars, optional)",
  "date_label": "string (<=80 chars, optional)",
  "spec_id": "executive-broadsheet" | "quiet-ledger" | "guji-classical",
  "hero_quote": "string (<=280 chars, optional)",
  "summary": "string (<=1000 chars, optional)",
  "top_priorities": [
    { "title": "<=80", "why_it_matters": "<=200, optional", "action": "<=120, optional" }
  ],
  "timeline": [
    { "time": "<=16", "item": "<=200" }
  ],
  "watchlist": [
    { "label": "<=80", "severity": "low" | "med" | "high", "note": "<=200, optional" }
  ],
  "notes": [
    { "heading": "<=80, optional", "body": "<=1000" }
  ]
}

Return JSON only.`;

/**
 * Wrap the caller's raw brief content in a `<brief>` tag so the model can
 * cleanly separate user content from instructions. Keep this trivial — the
 * heavy lifting lives in the system prompt.
 */
export function buildUserPrompt(content: string): string {
  return `<brief>\n${content}\n</brief>`;
}
