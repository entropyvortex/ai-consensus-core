import { describe, it, expect } from "vitest";
import {
  extractConfidence,
  extractJudgeConfidence,
  extractJudgeSection,
  stripConfidenceLine,
} from "../parser.js";

describe("extractConfidence", () => {
  it("parses the standard trailing CONFIDENCE line", () => {
    expect(extractConfidence("Thoughtful analysis.\nCONFIDENCE: 87")).toBe(87);
  });

  it("returns 50 (neutral) when the marker is absent", () => {
    // An absent marker is a model compliance failure, not a low-confidence
    // signal. Defaulting to 50 prevents the consensus score from being
    // silently skewed downward.
    expect(extractConfidence("No marker at all.")).toBe(50);
    expect(extractConfidence("")).toBe(50);
  });

  it("returns 50 when the captured group fails to parse", () => {
    // The regex requires \d+, so truly malformed values never match at all —
    // but a belt-and-suspenders NaN check in the implementation also keeps
    // us safe from a future relaxed regex.
    expect(extractConfidence("CONFIDENCE: not-a-number")).toBe(50);
  });

  it("is case-insensitive on the marker", () => {
    expect(extractConfidence("confidence: 75")).toBe(75);
    expect(extractConfidence("CoNfIdEnCe: 75")).toBe(75);
  });

  it("matches the first occurrence when several are present", () => {
    // The roundtable reference uses a non-global regex, so the first match
    // wins. We preserve that ordering — later confidences are treated as
    // commentary, not overrides.
    expect(extractConfidence("CONFIDENCE: 30\nmore\nCONFIDENCE: 90")).toBe(30);
  });

  it("clamps values above 100", () => {
    expect(extractConfidence("CONFIDENCE: 150")).toBe(100);
    expect(extractConfidence("CONFIDENCE: 9999")).toBe(100);
  });

  it("accepts the boundary values 0 and 100", () => {
    expect(extractConfidence("CONFIDENCE: 0")).toBe(0);
    expect(extractConfidence("CONFIDENCE: 100")).toBe(100);
  });

  it("tolerates extra whitespace after the colon", () => {
    expect(extractConfidence("CONFIDENCE:    72")).toBe(72);
    expect(extractConfidence("CONFIDENCE:\t72")).toBe(72);
  });

  it("picks out the marker even when surrounded by narrative text", () => {
    expect(extractConfidence("…therefore CONFIDENCE: 65 (with caveats)")).toBe(65);
  });
});

describe("extractJudgeConfidence", () => {
  it("parses the unbracketed form JUDGE_CONFIDENCE: 87", () => {
    expect(extractJudgeConfidence("JUDGE_CONFIDENCE: 87")).toBe(87);
  });

  it("parses the bracketed form JUDGE_CONFIDENCE: [87]", () => {
    // The JUDGE_PERSONA prompt wraps the placeholder in brackets, and many
    // models emit them literally. Accepting both forms is the difference
    // between a working judge and a silently-broken one.
    expect(extractJudgeConfidence("JUDGE_CONFIDENCE: [87]")).toBe(87);
    expect(extractJudgeConfidence("JUDGE_CONFIDENCE: [ 87 ]")).toBe(87);
  });

  it("returns 50 when the marker is absent", () => {
    expect(extractJudgeConfidence("no judge marker here")).toBe(50);
  });

  it("is case-insensitive", () => {
    expect(extractJudgeConfidence("judge_confidence: 42")).toBe(42);
  });

  it("clamps values above 100", () => {
    expect(extractJudgeConfidence("JUDGE_CONFIDENCE: 250")).toBe(100);
  });
});

describe("extractJudgeSection", () => {
  const body = `## Majority Position
They agree on X with qualifications.

## Minority Positions
Alice dissented on Y, citing cost.

## Unresolved Disputes
- Whether Z applies in edge case A

## Synthesis Confidence
JUDGE_CONFIDENCE: 82`;

  it("extracts a named section up to the next heading", () => {
    expect(extractJudgeSection(body, "Majority Position")).toBe(
      "They agree on X with qualifications.",
    );
  });

  it("extracts the final section up to end of text", () => {
    expect(extractJudgeSection(body, "Synthesis Confidence")).toBe(
      "JUDGE_CONFIDENCE: 82",
    );
  });

  it("returns an empty string when the section is missing", () => {
    expect(extractJudgeSection(body, "Nonexistent Section")).toBe("");
  });

  it("is case-insensitive on the heading", () => {
    expect(extractJudgeSection(body, "majority POSITION")).toBe(
      "They agree on X with qualifications.",
    );
  });

  it("escapes regex metacharacters in the heading", () => {
    // Without escaping, a heading like `Section.A` would match `SectionxA`
    // via the regex wildcard. That would be a silent, hard-to-diagnose bug
    // if the judge prompt ever evolves to include punctuation in headings.
    const text = "## Section.A\nreal body\n\n## Section.B\nother\n";
    expect(extractJudgeSection(text, "Section.A")).toBe("real body");
    expect(extractJudgeSection("## SectionXA\nbad\n", "Section.A")).toBe("");
  });

  it("trims whitespace from the extracted body", () => {
    const text = "## Heading\n\n   padded body   \n\n## Next\n";
    expect(extractJudgeSection(text, "Heading")).toBe("padded body");
  });
});

describe("stripConfidenceLine", () => {
  it("removes the trailing CONFIDENCE line", () => {
    expect(stripConfidenceLine("body text\nCONFIDENCE: 80")).toBe("body text");
  });

  it("leaves content alone when no marker is present", () => {
    expect(stripConfidenceLine("just body")).toBe("just body");
  });

  it("is case-insensitive", () => {
    expect(stripConfidenceLine("body\nconfidence: 80")).toBe("body");
  });

  it("strips only the trailing marker, not mid-body mentions", () => {
    const text =
      "This mentions CONFIDENCE: 50 in passing.\nActual body.\nCONFIDENCE: 80";
    expect(stripConfidenceLine(text)).toBe(
      "This mentions CONFIDENCE: 50 in passing.\nActual body.",
    );
  });

  it("tolerates trailing whitespace after the confidence value", () => {
    expect(stripConfidenceLine("body\nCONFIDENCE: 80   ")).toBe("body");
  });
});
