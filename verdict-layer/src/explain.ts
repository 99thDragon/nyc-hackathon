// Layer 3: Claude writes the one-sentence reason. It never changes the answer.
import Anthropic from "@anthropic-ai/sdk";
import type { Verdict } from "./types.ts";

// The notes route this through AI Gateway as "anthropic/claude-sonnet-5.5". Swap
// `anthropicGenerate` for a gateway call; nothing else here needs to change.
export type Generate = (system: string, user: string) => Promise<string>;

const MODEL = process.env.VERDICT_MODEL ?? "claude-sonnet-5-5";

const SYSTEM = `You write the one-sentence reason under a subway verdict for a rider who has seconds to read it.

Rules:
- The answer is already decided. Never contradict, soften or change it.
- Use only facts in the JSON. If something is missing, say we don't know. Never guess.
- One short plain sentence, 25 words at most. No markdown.
- If a nearby step-free alternative appears in "official", mention it.
- If data_age_s is over 60, say the data may be a bit old.
- Talk only about physical conditions of elevators, stations and cars. Never mention or imply other riders or any group of people, and never call any place safe or unsafe.`;

// Output we refuse to show, so a bad generation falls back to the rule-written reason.
const BANNED = /homeless|unsafe|\bsafe(ty)?\b|sketch|danger|crime|\bpeople\b|\bpeople's\b/i;

let client: Anthropic | null = null;
export const anthropicGenerate: Generate | null = process.env.ANTHROPIC_API_KEY
  ? async (system, user) => {
      client ??= new Anthropic();
      const res = await client.messages.create({
        model: MODEL,
        max_tokens: 1000,
        output_config: { effort: "low" },
        system,
        messages: [{ role: "user", content: user }],
      });
      return res.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("")
        .trim();
    }
  : null;

export async function explain(
  v: Verdict,
  question: string | undefined,
  generate: Generate | null = anthropicGenerate,
): Promise<Verdict> {
  if (!generate || v.answer === "not_enough_data") return v;
  try {
    const text = await generate(
      SYSTEM,
      `Rider question: ${question ?? "Can I get step-free, and where should I board?"}\n\nVerdict:\n${JSON.stringify(v)}`,
    );
    if (!text || text.length > 300 || BANNED.test(text)) return v;
    return { ...v, reason: text }; // only `reason` changes
  } catch (err) {
    console.error("explain(): keeping the rule-written reason:", (err as Error).message);
    return v;
  }
}
