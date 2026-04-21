import { getGroqClient } from "@/lib/groq";
import { MODEL } from "@/lib/constants";

// 🔥 strict sentence enforcement
function enforceExactSentences(text: string, customPrompt?: string) {
  if (!customPrompt) return text;

  const match = customPrompt.match(/exactly\s+(\d+)\s+sentence/i);
  if (!match) return text;

  const target = Number(match[1]);
  if (!target || target <= 0) return text;

  let sentences = text
    .replace(/\n+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

  if (sentences.length === 0) return text;

  if (sentences.length > target) {
    sentences = sentences.slice(0, target);
  }

  if (sentences.length < target) {
    const last = sentences[sentences.length - 1];
    while (sentences.length < target) {
      sentences.push(last);
    }
  }

  return sentences.join(" ").replace(/\s+/g, " ").trim();
}

// 🔥 remove repeated phrases/sentences
function cleanRepetition(text: string) {
  return text.replace(/(.+?)\s+\1+/g, "$1");
}

export async function POST(req: Request) {
  try {
    const {
      messages,
      transcript,
      apiKey,
      customPrompt,
      contextWindow,
    } = await req.json();

    if (!apiKey) {
      return new Response("Missing API key", { status: 400 });
    }

    const groq = getGroqClient(apiKey.trim());

    // ✅ limit history
    const safeMessages = (messages || [])
      .slice(-6)
      .map((m: any) => ({
        role: m.role,
        content: m.content,
      }));

    const lastUser =
      safeMessages[safeMessages.length - 1]?.content || "";

    const isSuggestion =
      lastUser.startsWith("[QUESTION]") ||
      lastUser.startsWith("[INSIGHT]") ||
      lastUser.startsWith("[ACTION]");

    // ✅ trim transcript
    const trimmedTranscript = (transcript || "")
      .split("\n")
      .slice(-(contextWindow || 5))
      .join("\n");

    // 🔥 CLEAN + DOMINANT PROMPT
    const SYSTEM_PROMPT = `
You are a real-time meeting assistant.

CONTEXT:
${trimmedTranscript}

---

TASK:
${
  isSuggestion
    ? "Expand the selected suggestion into something the user can say out loud."
    : "Answer the user's question based on the conversation."
}

---

CRITICAL:
You MUST follow the USER INSTRUCTION exactly.
Do NOT override it.
Do NOT add extra sentences.
Do NOT add labels or prefixes.

---

USER INSTRUCTION:
${customPrompt || "Respond clearly."}
`;

    let stream;

    try {
      stream = await groq.chat.completions.create({
        model: MODEL,
        stream: true,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          ...safeMessages,
        ],
      });
    } catch (err: any) {
      if (err?.status === 429) {
        return new Response(
          JSON.stringify({
            error: "RATE_LIMIT",
            message: "Rate limit reached. Please wait.",
          }),
          { status: 429 }
        );
      }

      console.error("Groq API Error:", err);

      return new Response(
        JSON.stringify({
          error: "MODEL_ERROR",
          message: "Model failed to respond.",
        }),
        { status: 500 }
      );
    }

    const encoder = new TextEncoder();

    return new Response(
      new ReadableStream({
        async start(controller) {
          let finalText = "";

          try {
            for await (const chunk of stream) {
              let content =
                chunk.choices?.[0]?.delta?.content;

              if (!content) continue;

              // sanitize labels
              content = content
                .replace(/HIGH SIGNAL:\s*/gi, "")
                .replace(/LOW NOISE:\s*/gi, "")
                .replace(/INSIGHT:\s*/gi, "")
                .replace(/ANSWER:\s*/gi, "");

              finalText += content;
            }

            if (!finalText.trim()) {
              finalText =
                "Not enough context to give a useful answer.";
            }

            // 🔥 CLEAN + ENFORCE
            finalText = cleanRepetition(finalText);
            finalText = enforceExactSentences(
              finalText,
              customPrompt
            );

            controller.enqueue(encoder.encode(finalText));
          } catch (err) {
            console.error("Streaming error:", err);

            controller.enqueue(
              encoder.encode(
                "⚠️ Failed to generate response. Try again."
              )
            );
          } finally {
            controller.close();
          }
        },
      }),
      {
        headers: {
          "Content-Type": "text/plain",
        },
      }
    );
  } catch (err: any) {
    console.error("🔥 FULL CHAT ERROR:", err);

    return new Response(
      JSON.stringify({
        error: err?.message || "Unknown error",
      }),
      { status: 500 }
    );
  }
}