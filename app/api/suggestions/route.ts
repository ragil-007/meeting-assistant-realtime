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

    // 🔥 dynamic trimming
    const trimmedTranscript = transcript
      .split(" ")
      .slice(-(contextWindow ? contextWindow * 40 : 120))
      .join(" ");

    const isEarlyStage =
      !memory?.summary || (previousSuggestions?.length || 0) < 3;

    // 🔥 FIXED PROMPT (customPrompt has FINAL authority)
    const SYSTEM_PROMPT = `
You are an elite real-time meeting assistant.

Your goal:
Generate EXACTLY 3 high-value suggestions based on the conversation.

---

CONTEXT:
${trimmedTranscript}

---

REQUIREMENTS:

Each suggestion must:
- Be grounded in the transcript
- Add NEW value (not rephrasing)
- Be immediately useful in conversation

FORMAT (STRICT JSON):

[
  {
    "type": "question | insight | action",
    "preview": "max 10 words",
    "full": "clear, natural expansion",
    "score": 0-100
  }
]

---

QUALITY RULES:

- Each suggestion MUST serve a different purpose
- Avoid vague phrases
- Avoid repetition
- Avoid generic advice

---

${isEarlyStage ? `
EARLY STAGE:
- Infer intelligently from limited context
- Be specific
` : `
ADVANCED STAGE:
- Build on discussion
- Add depth or challenge assumptions
`}

---

AVOID:
${JSON.stringify(previousSuggestions || [])}

---

USER INSTRUCTION (HIGHEST PRIORITY):
${customPrompt || "Generate sharp, non-generic suggestions."}

Follow the USER INSTRUCTION strictly.

RETURN ONLY JSON ARRAY.
`;

    const userPrompt = `
Transcript:
${trimmedTranscript}

Focus on:
- unclear areas
- hidden assumptions
- next steps
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
        const retry =
          err?.headers?.get?.("retry-after") || "60";

        return NextResponse.json({
          error: "RATE_LIMIT",
          retryAfter: Number(retry),
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
        type: item?.type,
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
      const normFull = normalize(s.full);

      const exists = final.some((f) =>
        isSimilar(normPreview, normalize(f.preview)) ||
        isSimilar(normFull, normalize(f.full))
      );

      if (!exists) {
        final.push(s);
      }

      if (final.length === 3) break;
    }

    final.sort((a, b) => b.score - a.score);

    if (final.length < 3) {
      return NextResponse.json([
        {
          type: "question",
          preview: "What decision are we actually making?",
          full: "Clarify the core decision this discussion is trying to reach.",
          score: 85,
        },
        {
          type: "insight",
          preview: "Discussion lacks clear direction",
          full: "Points are being discussed, but no clear objective is defined.",
          score: 75,
        },
        {
          type: "action",
          preview: "Define next actionable step",
          full: "Agree on one concrete next step before continuing discussion.",
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