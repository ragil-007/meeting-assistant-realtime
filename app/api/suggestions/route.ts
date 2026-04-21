import { NextResponse } from "next/server";
import { getGroqClient } from "@/lib/groq";
import { MODEL } from "@/lib/constants";

// 🔧 normalize
const normalize = (text: string) =>
  text.toLowerCase().replace(/[^\w\s]/g, "").trim();

// 🔧 similarity
const isSimilar = (a: string, b: string) => {
  const wordsA = new Set(a.split(" "));
  const wordsB = new Set(b.split(" "));

  let overlap = 0;
  wordsA.forEach((w) => {
    if (wordsB.has(w)) overlap++;
  });

  return overlap / Math.max(wordsA.size, 1) > 0.6;
};

// 🔥 stronger quality filter
const isLowQuality = (text: string) => {
  const t = text.toLowerCase().trim();

  return (
    t.length < 6 ||
    t.split(" ").length < 2 ||
    [
      "i agree",
      "this is",
      "we should",
      "something important",
      "good point",
    ].some((w) => t.includes(w))
  );
};

export async function POST(req: Request) {
  try {
    const {
      transcript,
      apiKey,
      previousSuggestions,
      memory,
      customPrompt,
      contextWindow,
    } = await req.json();

    if (!transcript || !apiKey) {
      return NextResponse.json(
        { error: "Missing data" },
        { status: 400 }
      );
    }

    const groq = getGroqClient(apiKey.trim());

    // 🔥 smarter trimming (token efficient)
    const trimmedTranscript = transcript
      .split(" ")
      .slice(-(contextWindow ? contextWindow * 40 : 120))
      .join(" ");

    const isEarlyStage =
      !memory?.summary || (previousSuggestions?.length || 0) < 3;

    // 🔥 CONTEXT SIGNAL DETECTION (NEW)
    const lower = trimmedTranscript.toLowerCase();

    const hasQuestion =
      lower.includes("?") ||
      /\b(what|why|how|when|should|can)\b/.test(lower);

    const hasDecision =
      /\b(decide|decision|final|choose|approve)\b/.test(lower);

    const hasUncertainty =
      /\b(not sure|unclear|maybe|guess)\b/.test(lower);

    const hasClaim =
      /\b(always|never|everyone|guarantee|100%)\b/.test(lower);

    // 🔥 SUPER PROMPT (THIS IS YOUR EDGE)
    const SYSTEM_PROMPT = `
${customPrompt || ""}

You are an elite real-time meeting assistant.

Your job:
Generate EXACTLY 3 highly useful suggestions.

---

CONTEXT:
${trimmedTranscript}

---

SITUATION ANALYSIS:

${
  hasQuestion
    ? "- A question is being discussed → include an ANSWER or follow-up question"
    : ""
}
${
  hasDecision
    ? "- A decision is being made → include an ACTION suggestion"
    : ""
}
${
  hasUncertainty
    ? "- Discussion is unclear → include a CLARIFICATION question"
    : ""
}
${
  hasClaim
    ? "- Strong claim detected → include a FACT-CHECK insight"
    : ""
}

---

TYPES (must mix intelligently):
- question
- insight
- action

---

RULES:

- EXACTLY 3 suggestions
- Each suggestion MUST serve a DIFFERENT purpose
- Avoid generic suggestions
- Be specific to the transcript
- Make preview useful even without clicking
- Do NOT repeat previous suggestions

---

FORMAT (STRICT JSON ARRAY):

[
  {
    "type": "question | insight | action",
    "preview": "max 10 words, sharp and useful",
    "full": "clear, natural expansion",
    "score": 0-100
  }
]

---

${
  isEarlyStage
    ? "EARLY STAGE: Infer intelligently and avoid generic output."
    : "ADVANCED STAGE: Build on discussion and add depth."
}

---

AVOID:
${JSON.stringify(previousSuggestions || [])}

---

RETURN ONLY JSON ARRAY.
`;

    const userPrompt = `
Transcript:
${trimmedTranscript}

Focus on:
- what is unclear
- what matters most
- what should happen next
`;

    let response;

    try {
      response = await groq.chat.completions.create({
        model: MODEL,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
      });
    } catch (err: any) {
      if (err?.status === 429) {
        return NextResponse.json({
          error: "RATE_LIMIT",
          retryAfter: 60,
        });
      }

      throw err;
    }

    const raw = response.choices?.[0]?.message?.content || "";

    const jsonMatch = raw.match(/\[[\s\S]*\]/);
    if (!jsonMatch) throw new Error("Invalid JSON");

    let parsed;
    try {
      parsed = JSON.parse(jsonMatch[0]);
    } catch {
      throw new Error("JSON parse failed");
    }

    let cleaned = parsed
      .slice(0, 6)
      .map((item: any) => ({
        type: item?.type || "insight",
        preview: item?.preview?.trim(),
        full: item?.full?.trim(),
        score: Number(item?.score) || 50,
      }))
      .filter(
        (s: any) =>
          s.preview &&
          s.full &&
          !isLowQuality(s.preview)
      );

    const final: typeof cleaned = [];

    for (const s of cleaned) {
      const normPreview = normalize(s.preview);

      const exists = final.some((f) =>
        isSimilar(normPreview, normalize(f.preview))
      );

      if (!exists) final.push(s);
      if (final.length === 3) break;
    }

    final.sort((a, b) => b.score - a.score);

    // 🔥 STRICT GUARANTEE
    if (final.length !== 3) {
      return NextResponse.json([
        {
          type: "question",
          preview: "What decision are we making?",
          full: "Clarify the core decision driving this discussion.",
          score: 85,
        },
        {
          type: "insight",
          preview: "Context still unclear",
          full: "The discussion lacks a clearly defined direction.",
          score: 75,
        },
        {
          type: "action",
          preview: "Define next step",
          full: "Agree on one concrete next step.",
          score: 90,
        },
      ]);
    }

    return NextResponse.json(final);
  } catch (err) {
    console.error("Suggestions error:", err);

    return NextResponse.json([
      {
        type: "question",
        preview: "What outcome are we targeting?",
        full: "Clarify the intended result of this discussion.",
        score: 80,
      },
      {
        type: "insight",
        preview: "No clear direction",
        full: "The discussion lacks a defined goal.",
        score: 70,
      },
      {
        type: "action",
        preview: "Set next step",
        full: "Define one clear next action.",
        score: 85,
      },
    ]);
  }
}