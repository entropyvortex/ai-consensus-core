import type { Persona } from "../types.js";

// Test personas. The library no longer ships the seven Roundtable
// personas (see docs/personas.md) — tests keep a minimal local fixture
// so they don't depend on opinionated content.
//
// Names and ids match the first two historical Roundtable personas so
// that prompt-formatting assertions ("Risk Analyst", "First-Principles
// Engineer") remain meaningful without hard-coding the full seven here.
export const TEST_PERSONAS: readonly Persona[] = [
  {
    id: "pessimist",
    name: "Risk Analyst",
    description: "Test persona A — surfaces failure modes.",
    systemPrompt: "You are a Risk Analyst. Surface failure modes and tail risks.",
  },
  {
    id: "first-principles",
    name: "First-Principles Engineer",
    description: "Test persona B — decomposes claims to axioms.",
    systemPrompt: "You are a First-Principles Engineer. Decompose claims to axioms.",
  },
  {
    id: "domain-expert",
    name: "Domain Expert",
    description: "Test persona C — grounds discussion in implementation detail.",
    systemPrompt: "You are a Domain Expert. Ground the discussion in real-world detail.",
  },
] as const;
