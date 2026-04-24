import { getGroqClient } from "@/lib/groq";
import { MODEL } from "@/lib/constants";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

// ---------------------------------------------------------------------------
// Context helpers
// ---------------------------------------------------------------------------

/**
 * Trims the transcript to the last N lines for chat context.
 * Line-based (not word-based) because transcript chunks are already
 * meaningful units — splitting mid-chunk loses coherence.
 */
function getTranscriptContext(transcript: string, maxLines = 10): string {
  return (transcript || "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-maxLines)
    .join("\n");
}

/**
 * Detects whether the user message originated from clicking a suggestion card.
 * Must match all suggestion types defined in the suggestions route.
 */
function isSuggestionClick(content: string): boolean {
  return /^\[(QUESTION|INSIGHT|ACTION|FACT-CHECK|ANSWER)\]/i.test(content);
}

/**
 * Strips the type prefix before passing to the model.
 * "[INSIGHT] JSESSIONID is vulnerable..." becomes "JSESSIONID is vulnerable..."
 */
function stripSuggestionPrefix(content: string): string {
  return content.replace(/^\[[\w-]+\]\s*/i, "").trim();
}

// ---------------------------------------------------------------------------
// Rate limit helper
// ---------------------------------------------------------------------------

/**
 * Parses the Groq 429 error message to extract the recommended wait time.
 * Groq puts the retry time in the error message body, not the headers.
 * Falls back to 5000ms if the format is unrecognized.
 */
function parseRetryAfterMs(err: unknown): number {
  const apiErr = err as { error?: { message?: string }; message?: string };
  const msg = apiErr?.error?.message ?? apiErr?.message ?? "";
  const match = msg.match(/(\d+(\.\d+)?)\s*s/);
  return match ? Math.ceil(parseFloat(match[1])) * 1000 : 5000;
}

// ---------------------------------------------------------------------------
// Shared rule blocks
// ---------------------------------------------------------------------------

/**
 * Custom prompt override block — shared by both prompt builders.
 *
 * Injected BEFORE task rules with explicit authority framing so the model
 * treats it as highest priority rather than a low-priority afterthought.
 */
function buildCustomPromptBlock(customPrompt?: string): string {
  if (!customPrompt?.trim()) return "";
  return `
⚠️ USER PRIORITY INSTRUCTIONS (these override the defaults below):
"""
${customPrompt.trim()}
"""
Apply these instructions to your entire response. They take precedence over all rules below.
`;
}

/**
 * Hallucination guard — injected into both prompt builders.
 *
 * WHY: Previous chat responses invented specifics not in the transcript:
 * "1x A100", "30% increase in frontend latency", "2-second buffer". These
 * are confidently wrong and actively mislead participants in a live meeting.
 *
 * The framing "a wrong specific is worse than no specific" gives the model
 * a clear decision rule when it's tempted to fill a gap with plausible data.
 */
const HALLUCINATION_GUARD = `
⚠️ HALLUCINATION GUARD:
Never invent specific numbers, product names, percentages, timeframes, or
technical specifications that are not explicitly stated in the conversation
context above. If you do not have a specific fact, say what you know in
general terms and acknowledge the gap — do not fill it with plausible-sounding
data. A wrong specific is worse than no specific.
`;

/**
 * Anti-deferral rule — injected into both prompt builders.
 *
 * WHY: Previous chat responses ended with "let's schedule a follow-up",
 * "can we confirm with the team", "let's discuss during the next meeting".
 * These are non-answers that waste the participant's time. The rule is
 * explicit: give the answer now. If genuinely unable to answer, say exactly
 * what information is missing — do not deflect.
 */
const NO_DEFERRAL_RULE = `
⚠️ NO DEFERRAL:
Never end your response by suggesting a follow-up meeting, scheduling a call,
asking the team to confirm something offline, or deferring the answer to later.
Give the answer now with what you know. If you genuinely cannot answer without
more information, state exactly what is missing and why — do not deflect.
`;

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

/**
 * Prompt for suggestion card clicks.
 *
 * Goal: a fast, actionable expansion the participant can read and use in
 * under 10 seconds. They are in a live meeting — brevity is critical.
 *
 * Capped at 2-3 sentences to match the `full` field length in suggestions.
 * The participant already read the preview and full — this must add something
 * new, not restate either.
 */
function buildSuggestionExpandPrompt(
  topic: string,
  transcriptContext: string,
  customPrompt?: string
): string {
  return `You are a real-time meeting copilot. A participant clicked a suggestion card during a live meeting and needs a fast, useful expansion.

CONVERSATION CONTEXT:
"""
${transcriptContext}
"""

SELECTED SUGGESTION:
"${topic}"

---
${buildCustomPromptBlock(customPrompt)}
YOUR TASK:

Give a crisp, immediately actionable response the participant can read in under 10 seconds.

REQUIREMENTS:
- 2-3 sentences maximum. The participant is in a live meeting — brevity is respect.
- Do NOT open by restating or paraphrasing the suggestion. The participant just read it.
  Lead with the first new fact, risk, or concrete step they do not already know.
- Be specific to THIS conversation. Reference what was actually discussed.
- End with one concrete thing the participant can do or say right now.

NEVER: restate the suggestion, add padding, use hedge words like "consider" or
"it's important to", write more than 3 sentences.
${HALLUCINATION_GUARD}
${NO_DEFERRAL_RULE}
TONE: Direct. Like a trusted colleague whispering the key point across the table.`;
}

/**
 * Prompt for freeform typed questions.
 *
 * Less constrained than the expansion prompt — the user typed a question
 * so they have more tolerance for a full answer. Still bounded to avoid
 * wall-of-text responses in the chat panel.
 */
function buildChatPrompt(
  transcriptContext: string,
  customPrompt?: string
): string {
  return `You are a knowledgeable meeting copilot answering questions in real time.

CONVERSATION CONTEXT (what has been discussed so far):
"""
${transcriptContext}
"""

---
${buildCustomPromptBlock(customPrompt)}
INSTRUCTIONS:
- Answer directly and specifically. Do not repeat the question. Do not say "Great question."
- Start with the answer — not with context-setting, preamble, or acknowledgment.
- Use the conversation context to make your answer relevant to what is being discussed.
- Be concise but complete: 2-4 sentences for simple questions, more for complex ones.
- If the answer requires a list or steps, use them. Otherwise write in prose.
${HALLUCINATION_GUARD}
${NO_DEFERRAL_RULE}`;
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { messages, transcript, apiKey, customPrompt, contextWindow } = body;

    // --- Input validation ---
    if (!apiKey || typeof apiKey !== "string" || apiKey.trim().length < 20) {
      return new Response(
        JSON.stringify({ error: "Invalid API key" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const groq = getGroqClient(apiKey.trim());

    // Keep last 20 messages for full session continuity.
    // The spec says "one continuous chat per session" — a smaller slice breaks that.
    const safeMessages: ChatMessage[] = (messages || [])
      .slice(-20)
      .map((m: ChatMessage) => ({ role: m.role, content: m.content }));

    const lastUserContent = [...safeMessages]
      .reverse()
      .find((m) => m.role === "user")?.content ?? "";

    const transcriptContext = getTranscriptContext(transcript, contextWindow || 10);

    const isSuggestion = isSuggestionClick(lastUserContent);
    const cleanedTopic = stripSuggestionPrefix(lastUserContent);

    const systemPrompt = isSuggestion
      ? buildSuggestionExpandPrompt(cleanedTopic, transcriptContext, customPrompt)
      : buildChatPrompt(transcriptContext, customPrompt);

    const groqParams = {
      model: MODEL,
      stream: true as const,
      // 0.35: precise enough for suggestion expansions, natural enough for chat.
      temperature: 0.35,
      // 250 tokens comfortably fits 2-3 sentence expansions (~80-120 tokens)
      // and 2-4 sentence chat answers (~120-200 tokens) without generating
      // padding to fill a larger budget.
      max_tokens: 250,
      messages: [
        { role: "system" as const, content: systemPrompt },
        ...safeMessages,
      ],
    };

    // --- Call Groq with one automatic retry on 429 ---
    let stream;
    try {
      stream = await groq.chat.completions.create(groqParams);
    } catch (err: unknown) {
      const apiErr = err as { status?: number };

      if (apiErr?.status === 429) {
        const retryAfterMs = parseRetryAfterMs(err);

        if (retryAfterMs <= 8000) {
          // Wait exactly as long as Groq recommends, then retry once.
          await new Promise((r) => setTimeout(r, retryAfterMs));
          try {
            stream = await groq.chat.completions.create(groqParams);
          } catch {
            // Second failure — return a clean 429 the frontend handles gracefully.
            return new Response(
              JSON.stringify({ error: "rate_limited" }),
              { status: 429, headers: { "Content-Type": "application/json" } }
            );
          }
        } else {
          // Wait time exceeds 8s — fail fast so the UI doesn't stall.
          return new Response(
            JSON.stringify({ error: "rate_limited" }),
            { status: 429, headers: { "Content-Type": "application/json" } }
          );
        }
      } else {
        if (process.env.NODE_ENV === "development") {
          console.error("[chat] Groq error:", err);
        }
        return new Response(
          JSON.stringify({ error: "model_error" }),
          { status: 500, headers: { "Content-Type": "application/json" } }
        );
      }
    }

    // --- Token-by-token streaming ---
    //
    // Each token is enqueued immediately as it arrives from Groq.
    // This produces visible character-by-character typing in the UI.
    // Without this, the response appears all at once after a multi-second delay.
    const encoder = new TextEncoder();

    return new Response(
      new ReadableStream({
        async start(controller) {
          let fullText = "";

          try {
            for await (const chunk of stream) {
              const token = chunk.choices?.[0]?.delta?.content;
              if (!token) continue;

              fullText += token;
              controller.enqueue(encoder.encode(token));
            }

            // Empty response fallback — should be rare but guards against
            // the model returning nothing under heavy load.
            if (!fullText.trim()) {
              controller.enqueue(
                encoder.encode("Not enough context to give a useful answer.")
              );
            }
          } catch {
            if (process.env.NODE_ENV === "development") {
              console.error("[chat] Streaming error");
            }
            controller.enqueue(
              encoder.encode("\n\n⚠️ Response interrupted. Please try again.")
            );
          } finally {
            controller.close();
          }
        },
      }),
      {
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          // Prevents Vercel/proxies from buffering the stream.
          "X-Content-Type-Options": "nosniff",
        },
      }
    );
  } catch {
    if (process.env.NODE_ENV === "development") {
      console.error("[chat] Unexpected error");
    }
    return new Response(
      JSON.stringify({ error: "unknown_error" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}