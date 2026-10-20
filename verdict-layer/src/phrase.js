import Anthropic from "@anthropic-ai/sdk";
import { templateText } from "./facts.js";

const MODEL = process.env.VERDICT_MODEL ?? "claude-opus-5-5";

const SYSTEM = `You write the explanation line under a subway verdict for a rider who has seconds to read it.

Rules:
- The yes/no answer is already decided in the facts JSON. Never contradict or soften it.
- Use only facts in the JSON. If something is missing, say we don't know. Never guess.
- One to three short plain sentences. No markdown, no headings.
- Mention the nearest step-free alternative when one is provided.
- For car guidance, talk only about physical conditions: the elevator's car position, smell, cleanliness, A/C, crowding. If a car is not rated yet, say so.
- Never mention, imply or speculate about other riders or any group of people, and never describe any place as safe or unsafe.
- If evidence.mayNotBeCurrent is true, say the data may be a bit old.`;

let client = null;
function getClient() {
  if (client) return client;
  if (!process.env.ANTHROPIC_API_KEY) return null;
  client = new Anthropic();
  return client;
}

export async function phrase(verdict, question) {
  const c = getClient();
  if (!c || verdict.answer === "unknown") {
    return { text: templateText(verdict), by: "template" };
  }
  try {
    const res = await c.messages.create({
      model: MODEL,
      max_tokens: 1000,
      output_config: { effort: "low" },
      system: SYSTEM,
      messages: [
        {
          role: "user",
          content: `Rider question: ${question ?? "Can I get step-free to the platform, and where should I board?"}\n\nFacts:\n${JSON.stringify(verdict)}`,
        },
      ],
    });
    const text = res.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
    if (!text) throw new Error("empty model response");
    return { text, by: MODEL };
  } catch (err) {
    console.error("phrase(): falling back to template:", err.message);
    return { text: templateText(verdict), by: "template" };
  }
}
