import { NextResponse } from "next/server";
import { getGroqClient } from "@/lib/groq";
import {MODEL} from "@/lib/constants";

export async function POST(req: Request) {
  try {
    const { previousSummary, latestText, apiKey } = await req.json();

    const groq = getGroqClient(apiKey.trim());

    const prompt = `
You maintain conversation memory.

---

RULES:

If previous summary is EMPTY:
→ This is a NEW topic → create fresh summary

If previous summary exists:
→ Update it incrementally

---

Previous summary:
${previousSummary || "None"}

New conversation:
${latestText}

---

Return STRICT JSON:

{
  "summary": "Concise evolving summary (max 80 words)",
  "topics": ["topic1", "topic2", "topic3"]
}
`;

    const response = await groq.chat.completions.create({
      model: MODEL,
      messages: [{ role: "user", content: prompt }],
    });

    const raw = response.choices?.[0]?.message?.content || "";

    const jsonMatch = raw.match(/\{[\s\S]*\}/);

    if (!jsonMatch) throw new Error("Invalid JSON");

    return NextResponse.json(JSON.parse(jsonMatch[0]));

  } catch (err) {
    console.error("Memory error:", err);

    return NextResponse.json({
      summary: "",
      topics: [],
    });
  }
}