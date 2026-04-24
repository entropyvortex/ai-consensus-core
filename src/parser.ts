// ─────────────────────────────────────────────────────────────
// Parser — extractors for confidence and judge sections
// ─────────────────────────────────────────────────────────────

function clampConfidence(n: number): number {
  if (Number.isNaN(n)) return 50;
  return Math.min(100, Math.max(0, n));
}

function isWhitespace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f" || ch === "\v";
}

function isDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9";
}

/**
 * Extract the trailing `CONFIDENCE: N` value. Clamps to [0, 100] and
 * defaults to 50 when the marker is absent or the following value is
 * malformed.
 *
 * The default is intentional: an absent marker is a model compliance
 * issue, not a "low-confidence" signal, so we treat it as neutral rather
 * than letting it skew the consensus score downward.
 *
 * Implemented with linear-time string parsing (no regex, no ReDoS). A
 * prefix with no digits after it yields `parseInt("")` → NaN, which
 * `clampConfidence` collapses to the 50 default — the single invalid-
 * input path.
 */
export function extractConfidence(text: string): number {
  const lower = text.toLowerCase();
  const prefix = "confidence:";
  const idx = lower.indexOf(prefix);
  if (idx === -1) return 50;

  let i = idx + prefix.length;
  while (i < text.length && isWhitespace(text[i]!)) i++;

  const start = i;
  while (i < text.length && isDigit(text[i]!)) i++;

  const n = Number.parseInt(text.slice(start, i), 10);
  return clampConfidence(n);
}

/**
 * Extract the judge's self-reported synthesis confidence. Tolerates both
 * `JUDGE_CONFIDENCE: 87` and `JUDGE_CONFIDENCE: [87]` forms, since the
 * JUDGE_PERSONA prompt wraps the placeholder in brackets.
 *
 * Implemented with linear-time string parsing (no regex, no ReDoS). A
 * prefix with no digits after it yields `parseInt("")` → NaN, which
 * `clampConfidence` collapses to the 50 default — the single invalid-
 * input path.
 */
export function extractJudgeConfidence(text: string): number {
  const lower = text.toLowerCase();
  const prefix = "judge_confidence:";
  const idx = lower.indexOf(prefix);
  if (idx === -1) return 50;

  let i = idx + prefix.length;
  while (i < text.length && isWhitespace(text[i]!)) i++;

  if (i < text.length && text[i] === "[") {
    i++;
    while (i < text.length && isWhitespace(text[i]!)) i++;
  }

  const start = i;
  while (i < text.length && isDigit(text[i]!)) i++;

  const n = Number.parseInt(text.slice(start, i), 10);
  return clampConfidence(n);
}

/**
 * Extract a named `## Heading`-style section from a judge synthesis.
 * Returns the trimmed section body, or "" if not found.
 */
export function extractJudgeSection(text: string, heading: string): string {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`##\\s*${escaped}\\s*\\n([\\s\\S]*?)(?=\\n##\\s|$)`, "i");
  const m = pattern.exec(text);
  if (!m) return "";
  return (m[1] ?? "").trim();
}

/**
 * Strip the trailing `CONFIDENCE: N` line from a body. Used when quoting
 * a participant response back to a downstream model, so the marker from
 * an earlier round doesn't bleed into the next round's parser pass.
 */
export function stripConfidenceLine(text: string): string {
  return text.replace(/\nCONFIDENCE:\s*\d+\s*$/i, "").trim();
}
