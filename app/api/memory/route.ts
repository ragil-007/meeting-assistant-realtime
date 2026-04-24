import { NextResponse } from "next/server";
import { getGroqClient } from "@/lib/groq";
import { MODEL } from "@/lib/constants";

// 🔁 retry helper
async function callWithRetry(fn: () => Promise<any>, retries = 2) {
  try {
    return await fn();
  } catch (err: any) {
    if (err?.status === 429 && retries > 0) {
      const retryAfter =
        err?.headers?.get?.("retry-after") || 2;

      await new Promise((r) =>
        setTimeout(r, retryAfter * 1000)
      );

      return callWithRetry(fn, retries - 1);
    }
    throw err;
  }
}

export async function POST(req: Request) {
  try {
    const { previousSummary, latestText, apiKey } =
      await req.json();

    // 🔒 VALIDATION
    if (!apiKey || apiKey.length < 20) {
      return NextResponse.json(
        { error: "Invalid API key" },
        { status: 400 }
      );
    }

    if (!latestText || latestText.length < 20) {
      return NextResponse.json({
        summary: previousSummary || "",
        topics: [],
      });
    }

    const groq = getGroqClient(apiKey);

    const prompt = `
You maintain a concise evolving memory of a live conversation.

---

RULES:

- If previous summary is empty → create a new one
- If it exists → update it incrementally
- Keep it SHORT and useful

---

Previous summary:
${previousSummary || "None"}

New conversation:
${latestText}

---

STRICT OUTPUT:
Return ONLY valid JSON.

{
  "summary": "Max 80 words",
  "topics": ["topic1", "topic2", "topic3"]
}
`;

    let response;

    try {
      response = await callWithRetry(() =>
        groq.chat.completions.create({
          model: MODEL,
          temperature: 0.3,
          max_tokens: 120,
          messages: [{ role: "user", content: prompt }],
        })
      );
    } catch (err: any) {
      if (err?.status === 429) {
        return NextResponse.json(
          {
            error: "RATE_LIMIT",
            message: "Memory update delayed",
          },
          { status: 429 }
        );
      }

      // 🔒 SAFE LOG
      if (process.env.NODE_ENV === "development") {
        console.error("Groq error (memory)");
      }

      return NextResponse.json({
        summary: previousSummary || "",
        topics: [],
      });
    }

    const raw = response.choices?.[0]?.message?.content || "";

    let parsed;

    try {
      const match = raw.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(match ? match[0] : raw);
    } catch {
      // 🔒 SAFE LOG
      if (process.env.NODE_ENV === "development") {
        console.error("Memory JSON parse failed");
      }

      return NextResponse.json({
        summary: previousSummary || "",
        topics: [],
      });
    }

    return NextResponse.json({
      summary: parsed?.summary || previousSummary || "",
      topics: Array.isArray(parsed?.topics)
        ? parsed.topics.slice(0, 5)
        : [],
    });
  } catch {
    // 🔒 SAFE LOG
    if (process.env.NODE_ENV === "development") {
      console.error("Memory route failed");
    }

    return NextResponse.json({
      summary: "",
      topics: [],
    });
  }
}