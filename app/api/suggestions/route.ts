import { NextResponse } from "next/server";
import { getGroqClient } from "@/lib/groq";
import { MODEL } from "@/lib/constants";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface Suggestion {
  type: "question" | "insight" | "action" | "fact-check" | "answer";
  preview: string;
  full: string;
}

// ---------------------------------------------------------------------------
// Context Helpers
// ---------------------------------------------------------------------------

function getContextWindow(transcript: string, maxWords = 300): string {
  const words = transcript.trim().split(/\s+/);
  return words.slice(-maxWords).join(" ");
}

function getRecentFocus(transcript: string, maxWords = 60): string {
  const words = transcript.trim().split(/\s+/);
  return words.slice(-maxWords).join(" ");
}

// ---------------------------------------------------------------------------
// Conversation Context Detection
// ---------------------------------------------------------------------------
interface ConversationContext {
  mode: string;
  recentSignals: string[];
  typingGuidance: string;
}

function detectConversationContext(transcript: string): ConversationContext {
  const lower = transcript.toLowerCase();
  const recentWords = lower.split(/\s+/).slice(-80).join(" ");
  const recentSignals: string[] = [];

  const recentQuestionCount = (recentWords.match(/\?/g) || []).length;
  if (recentQuestionCount >= 2) recentSignals.push("multiple_questions_asked");
  else if (recentQuestionCount === 1) recentSignals.push("question_asked");

  if (
    /\b\d+(%|ms|mb|gb|kb|s|x|k|m)?\b/.test(recentWords) ||
    /\b(always|never|guaranteed|proven|according to|studies show|research|technically)\b/.test(recentWords)
  ) {
    recentSignals.push("factual_claim_made");
  }

  if (/\b(let's|we will|we should|going to|decided|agreed|plan to|will be)\b/.test(recentWords)) {
    recentSignals.push("decision_or_commitment");
  }

  if (/\b(means|is called|refers to|is defined as|basically|essentially|in other words|what this does)\b/.test(recentWords)) {
    recentSignals.push("concept_introduced");
  }

  if (/\b(not sure|unclear|confused|don't know|wondering|what about|how does|what happens|does anyone)\b/.test(recentWords)) {
    recentSignals.push("uncertainty_expressed");
  }

  if (/\b(issue|problem|risk|concern|worried|breaks|fails|error|wrong|bad|careful|watch out)\b/.test(recentWords)) {
    recentSignals.push("risk_or_problem_raised");
  }

  const wordCount = lower.split(/\s+/).length;
  const questionDensity = (lower.match(/\?/g) || []).length / (wordCount / 100);

  const decisionScore = [
    "decide", "should we", "which option", "trade-off", "tradeoff",
    "risk", "cost", "benefit", "choose", "go with", "pros and cons",
  ].filter((k) => lower.includes(k)).length;

  const techScore = [
    "deploy", "api", "database", "latency", "architecture", "schema",
    "bug", "performance", "memory", "cache", "query", "endpoint",
    "service", "server", "client", "framework", "library", "stack",
  ].filter((k) => lower.includes(k)).length;

  const lectureScore = [
    "basically", "what this means", "in other words", "for example",
    "to summarize", "let me explain", "what is", "how does", "in short",
  ].filter((k) => lower.includes(k)).length;

  let mode = "general meeting";
  if (questionDensity > 3) mode = "interview or Q&A";
  else if (decisionScore >= 3) mode = "decision-making";
  else if (techScore >= 3) mode = "technical discussion";
  else if (lectureScore >= 3) mode = "explanation or lecture";

  let typingGuidance: string;

  if (recentSignals.includes("multiple_questions_asked")) {
    typingGuidance = `Multiple questions were just asked. Prioritize: (1) a direct "answer" to the most important unanswered question, (2) an "insight" that adds context, (3) a "question" that goes deeper.`;
  } else if (recentSignals.includes("question_asked") && recentSignals.includes("factual_claim_made")) {
    typingGuidance = `A question was asked and a factual claim was made. Prioritize: (1) an "answer" to the question, (2) a "fact-check" on the claim, (3) the most useful remaining type.`;
  } else if (recentSignals.includes("question_asked")) {
    typingGuidance = `A question was just asked. Prioritize: (1) an "answer" that directly addresses it, (2) a follow-up "question" that goes deeper, (3) an "insight" or "fact-check".`;
  } else if (recentSignals.includes("factual_claim_made") && recentSignals.includes("risk_or_problem_raised")) {
    typingGuidance = `A factual claim and a risk were both raised. Prioritize: (1) a "fact-check" on the claim, (2) an "insight" about the risk, (3) a "question" that clarifies the most important unknown.`;
  } else if (recentSignals.includes("factual_claim_made")) {
    typingGuidance = `A factual claim was just made. Prioritize: (1) a "fact-check" that verifies or adds nuance, (2) an "insight" the speaker didn't mention, (3) a "question" or "action".`;
  } else if (recentSignals.includes("decision_or_commitment") && recentSignals.includes("risk_or_problem_raised")) {
    typingGuidance = `A decision is being made and a risk was raised. Prioritize: (1) a "question" exposing the most important unknown, (2) an "insight" about the risk, (3) an "action" to mitigate it.`;
  } else if (recentSignals.includes("decision_or_commitment")) {
    typingGuidance = `A decision was just made. Prioritize: (1) a "question" surfacing what the group doesn't know, (2) an "action" to follow through, (3) an "insight" about a hidden implication.`;
  } else if (recentSignals.includes("concept_introduced") && recentSignals.includes("uncertainty_expressed")) {
    typingGuidance = `A concept was introduced and uncertainty was expressed. Prioritize: (1) an "answer" that clarifies, (2) an "insight" that adds context, (3) a "question" that deepens understanding.`;
  } else if (recentSignals.includes("concept_introduced")) {
    typingGuidance = `A new concept was introduced. Prioritize: (1) an "insight" adding context the speaker didn't mention, (2) an "answer" to the implicit "why does this matter", (3) a "question" or "fact-check".`;
  } else if (recentSignals.includes("uncertainty_expressed")) {
    typingGuidance = `Uncertainty was expressed. Prioritize: (1) an "answer" resolving it directly, (2) a "question" surfacing the root of the confusion, (3) an "insight" that reframes the issue.`;
  } else if (recentSignals.includes("risk_or_problem_raised")) {
    typingGuidance = `A risk or problem was raised. Prioritize: (1) an "insight" about actual severity, (2) an "action" to address it, (3) a "question" exposing what's still unknown.`;
  } else if (mode === "decision-making") {
    typingGuidance = `Decision context. Use: (1) a "question" exposing the most critical unknown, (2) an "insight" about a hidden tradeoff, (3) an "action" or second "question".`;
  } else if (mode === "interview or Q&A") {
    typingGuidance = `Q&A context. Use: (1) an "answer", (2) a follow-up "question", (3) an "insight".`;
  } else if (mode === "technical discussion") {
    typingGuidance = `Technical discussion. Use a balanced mix: "question", "insight", and either "fact-check" or "action".`;
  } else if (mode === "explanation or lecture") {
    typingGuidance = `Explanation context. Use: (1) an "insight" adding context the speaker skipped, (2) a clarifying "question", (3) an "answer" to the implicit "so what?".`;
  } else {
    typingGuidance = `General meeting. At least one "question" to move things forward; vary the other two based on what was actually said.`;
  }

  return { mode, recentSignals, typingGuidance };
}

// ---------------------------------------------------------------------------
// Validation & Deduplication
// ---------------------------------------------------------------------------

function isValidSuggestion(s: unknown): s is Suggestion {
  if (!s || typeof s !== "object") return false;
  const obj = s as Record<string, unknown>;
  if (typeof obj.preview !== "string" || obj.preview.trim().length < 10) return false;
  if (typeof obj.full !== "string" || obj.full.trim().length < 20) return false;
  return true;
}

function deduplicateBatch(suggestions: Suggestion[]): Suggestion[] {
  const seen = new Set<string>();
  return suggestions.filter((s) => {
    const key = s.preview.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 35);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizePreview(preview: string): string {
  return preview.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 40);
}

function truncateToSentences(text: string, maxSentences: number): string {
  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return sentences.slice(0, maxSentences).join(" ");
}

// ---------------------------------------------------------------------------
// Prompt Builder
// ---------------------------------------------------------------------------

/**
 * PROMPT DESIGN NOTES — changes in this version:
 *
 * 1. ADDITIVE rule (rule 5) now includes an explicit self-test.
 *    The previous version said "never restate" but the model kept doing it
 *    because the instruction was abstract. The self-test makes it concrete:
 *    "Could this sentence appear in a summary of what was said? If yes, rewrite it."
 *    This forces the model to actively verify each suggestion before outputting it.
 *
 * 2. JSON schema example now shows BAD vs GOOD for the `full` field.
 *    The model learns output format from examples more reliably than from rules.
 *    Showing "BAD: X — GOOD: Y" directly in the schema comment calibrates the
 *    model at the exact moment it's deciding what to write.
 *
 * 3. HALLUCINATION GUARD and CROSS-BATCH FRESHNESS unchanged — both working.
 *
 * 4. BANNED PHRASES rule unchanged — list is sufficient.
 */
function buildSystemPrompt(
  contextWindow: string,
  recentFocus: string,
  ctx: ConversationContext,
  previousBatchPreviews: string[],
  customPrompt?: string
): string {
  const hasCustomPrompt = !!customPrompt?.trim();

  const customPromptBlock = hasCustomPrompt
    ? `
⚠️ USER INSTRUCTIONS — HIGHEST PRIORITY (override everything below):
"""
${customPrompt!.trim()}
"""
Follow these exactly. If they specify suggestion types, use only those types and ignore the type guidance below.
`
    : "";

  const customSpecifiesTypes =
    hasCustomPrompt &&
    /\b(question|insight|action|fact.?check|answer|only|exclusively|just)\b/i.test(customPrompt!);

  const typeGuidanceBlock = customSpecifiesTypes
    ? `TYPE: Follow the user instructions above exactly.`
    : `TYPE GUIDANCE (based on what just happened):
${ctx.typingGuidance}

Never produce 3 suggestions of the same type.`;

  const crossBatchBlock =
    previousBatchPreviews.length > 0
      ? `
RECENT SUGGESTIONS ALREADY SHOWN (do not repeat these ideas — the user already saw them):
${previousBatchPreviews.map((p, i) => `  ${i + 1}. "${p}"`).join("\n")}

Every suggestion in this batch must cover a DIFFERENT topic or angle than the ones above.
If the conversation hasn't moved on, find a different dimension: a risk not yet raised,
a different stakeholder perspective, a follow-on implication, or a contrasting view.
`
      : "";

  return `You are a real-time meeting copilot. Surface the 3 most useful things for a participant RIGHT NOW — grounded in what was actually said in THIS conversation.

CONVERSATION TYPE: ${ctx.mode}
RECENT SIGNALS: ${ctx.recentSignals.length > 0 ? ctx.recentSignals.join(", ") : "none detected"}

---

RECENT CONTEXT (last ~5 minutes):
"""
${contextWindow}
"""

WHAT WAS JUST SAID (last ~60 seconds — this drives type selection):
"""
${recentFocus}
"""

---
${customPromptBlock}
${crossBatchBlock}
${typeGuidanceBlock}

---

⚠️ HALLUCINATION GUARD — READ THIS BEFORE GENERATING:
Never invent specific numbers, product names, version numbers, percentages,
timeframes, or technical specifications that are not explicitly stated in the
conversation context above.

If you want to include a specific fact but it is not in the transcript:
  - DO NOT invent a plausible-sounding number or name
  - DO say what is generally known about the topic in plain terms
  - DO acknowledge the gap if precision matters ("the exact figure wasn't stated")

A confident wrong specific actively misleads the participant.
It is always better to be vague than to be precisely wrong.

---

RULES:

1. GROUNDING — every suggestion must reference something actually said.
   Name a specific technology, person, decision, or claim from the transcript.
   A suggestion that could appear in any meeting must not be generated.

2. TYPE CORRECTNESS:
   - "answer": directly answers a question that was just asked. Specific and factual.
   - "question": surfaces a gap the group has NOT addressed. Exposes an unknown.
   - "insight": adds important context the speaker did not mention.
   - "fact-check": verifies or qualifies a specific claim that was made.
   - "action": a concrete next step tied directly to what was just decided or raised.

3. LENGTH — strict:
   - preview: one complete sentence, max 120 characters, standalone value.
   - full: EXACTLY ONE sentence. Pick the single most important new fact, risk,
     or next step. Do not pad. Do not hedge.

4. BANNED PHRASES — never use these in any field:
   "it's essential", "it's crucial", "it's important to", "make sure to",
   "consider", "you should think about", "a small investment", "keep in mind",
   "as observed", "as mentioned", "as noted", "as you said".
   These are filler. Say the thing directly.

5. ADDITIVE — this is the most important rule.
   Before writing each suggestion, apply this self-test:
     "Could this sentence appear in a summary of what was already said?"
     If YES → it is a restatement. Discard it and write something new.
     If NO  → it adds something. Keep it.

   A suggestion is only valid if it adds a fact, risk, implication, data point,
   or question that was NOT present in the transcript.

   BAD (restatement — fails the self-test):
     "The thermal limits of the mobile nodes were causing issues."  ← the speaker said this
     "Legacy JDBC connectors still cause blocking calls."           ← the speaker said this
     "CPU throttling is a known issue."                            ← the speaker said this

   GOOD (additive — passes the self-test):
     "JDBC's blocking I/O model means a single slow query monopolizes a thread,
      compounding latency under the 22% session spike."
     "Magnetocaloric coolers have no moving parts, making them more reliable
      than liquid cooling under sustained 48-hour test loads."
     "Spring WebFlux requires replacing every blocking library in the call chain —
      one missed dependency stalls the entire reactive migration."

---

Respond ONLY with a valid JSON array. No preamble, no markdown fences, no text outside the array.

[
  {
    "type": "answer",
    "preview": "One sentence, max 120 chars, standalone value — must pass the self-test above",
    "full": "Exactly one sentence. Must contain one specific fact NOT already in the transcript. BAD: 'The thermal limits are causing issues as observed.' GOOD: 'Magnetocaloric coolers have no moving parts — more reliable than liquid cooling for sustained 48-hour test loads.'"
  }
]`;
}

// ---------------------------------------------------------------------------
// Fallbacks
// ---------------------------------------------------------------------------

function buildFallbacks(recentFocus: string, ctx: ConversationContext): Suggestion[] {
  const words = recentFocus.trim().split(/\s+/);
  const anchor = words.slice(0, 8).join(" ").replace(/[^a-zA-Z0-9\s]/g, "").trim();
  const topic = anchor.length > 6 ? `"${anchor}..."` : "this topic";

  const fallbacksByMode: Record<string, Suggestion[]> = {
    "decision-making": [
      {
        type: "question",
        preview: "Who owns this decision, and what is the rollback plan if it is wrong?",
        full: `For ${topic}, naming one accountable person and a clear reversal path are the two things most often missing before a commitment is made.`,
      },
      {
        type: "insight",
        preview: "The reversibility of this decision determines how fast you can safely move.",
        full: `For ${topic}, irreversible decisions need more upfront scrutiny — reversible ones can move faster with less consensus.`,
      },
      {
        type: "action",
        preview: "Write down the decision criteria now, before the outcome is known.",
        full: `Capturing what success looks like for ${topic} prevents hindsight bias and makes it easier to detect when conditions have changed enough to revisit.`,
      },
    ],
    "interview or Q&A": [
      {
        type: "answer",
        preview: "Strong answers name a failure mode, not just the happy path.",
        full: `For ${topic}, identifying a known edge case or counterintuitive cost distinguishes a strong answer from a textbook one.`,
      },
      {
        type: "question",
        preview: "Ask for a specific example — it reveals depth better than continued explanation.",
        full: `For ${topic}, asking "walk me through a case where this actually happened" separates surface familiarity from real understanding.`,
      },
      {
        type: "insight",
        preview: "The constraint the approach does NOT handle is the most important part of the answer.",
        full: `Every approach for ${topic} has a ceiling — naming it shows real understanding rather than pattern recall.`,
      },
    ],
    "technical discussion": [
      {
        type: "question",
        preview: "What happens to this approach at 10x current load?",
        full: `Scale assumptions are the most common thing left unstated in technical discussions about ${topic}, and the most expensive to discover late.`,
      },
      {
        type: "fact-check",
        preview: "Performance claims depend heavily on the specific workload — context is missing here.",
        full: `For ${topic}, numbers without workload context are misleading; the figures that matter are under the actual access patterns being discussed.`,
      },
      {
        type: "action",
        preview: "Define the rollback plan before merging — not after something breaks.",
        full: `For ${topic}, the rollback plan is typically the last thing written and the first thing needed.`,
      },
    ],
    "explanation or lecture": [
      {
        type: "insight",
        preview: "The explanation covered the happy path but skipped the failure case.",
        full: `For ${topic}, the scenario where the concept breaks or behaves unexpectedly is where real understanding is built.`,
      },
      {
        type: "question",
        preview: "Can you give an example of when this would NOT work?",
        full: `For ${topic}, boundary conditions reveal whether someone has conceptual understanding or just pattern recognition.`,
      },
      {
        type: "answer",
        preview: "The practical implication here is often counterintuitive at scale.",
        full: `For ${topic}, real-world behavior diverges from the theoretical model in ways that only become clear under specific conditions.`,
      },
    ],
  };

  const defaultFallbacks: Suggestion[] = [
    {
      type: "question",
      preview: "What is the one thing about this that still is not settled?",
      full: `For ${topic}, naming the open question explicitly prevents the meeting from ending with false alignment.`,
    },
    {
      type: "insight",
      preview: "The gap between what was said and what was decided needs to be closed explicitly.",
      full: `For ${topic}, the specific next step — not just the direction — is what prevents this from being relitigated in the next meeting.`,
    },
    {
      type: "action",
      preview: "State the next concrete step and who owns it before moving on.",
      full: `For ${topic}, leaving without a named owner and specific next action is the most common source of unnecessary follow-up meetings.`,
    },
  ];

  return fallbacksByMode[ctx.mode] ?? defaultFallbacks;
}

// ---------------------------------------------------------------------------
// Rate Limit Helper
// ---------------------------------------------------------------------------

function parseRetryAfterMs(errMessage: string): number {
  const match = errMessage.match(/(\d+(\.\d+)?)\s*s/);
  return match ? Math.ceil(parseFloat(match[1])) * 1000 : 6000;
}

// ---------------------------------------------------------------------------
// Route Handler
// ---------------------------------------------------------------------------
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const {
      transcript,
      apiKey,
      customPrompt,
      contextWordLimit,
      minNewWords,
      previousBatchPreviews,
    } = body;

    if (!transcript || typeof transcript !== "string") {
      return NextResponse.json({ error: "Missing transcript" }, { status: 400 });
    }
    if (!apiKey || typeof apiKey !== "string") {
      return NextResponse.json({ error: "Missing API key" }, { status: 400 });
    }

    const wordCount = transcript.trim().split(/\s+/).length;
    const minWords = typeof minNewWords === "number" ? minNewWords : 15;
    if (wordCount < minWords) {
      return NextResponse.json({ skip: true, reason: "not_enough_content" });
    }

    const maxWords = typeof contextWordLimit === "number" ? contextWordLimit : 300;
    const contextWindow = getContextWindow(transcript, maxWords);
    const recentFocus = getRecentFocus(transcript, 60);
    const ctx = detectConversationContext(transcript);

    const safePreviousPreviews: string[] = Array.isArray(previousBatchPreviews)
      ? previousBatchPreviews
          .filter((p): p is string => typeof p === "string" && p.length > 0)
          .slice(0, 6)
      : [];

    const systemPrompt = buildSystemPrompt(
      contextWindow,
      recentFocus,
      ctx,
      safePreviousPreviews,
      customPrompt
    );

    const groq = getGroqClient(apiKey.trim());

    const groqParams = {
      model: MODEL,
      temperature: 0.5,
      max_tokens: 600,
      messages: [
        { role: "system" as const, content: systemPrompt },
        {
          role: "user" as const,
          content:
            "Generate 3 suggestions based on what was just said. Apply the self-test to every suggestion: if it could appear in a summary of what was already said, rewrite it. Be specific to THIS conversation.",
        },
      ],
    };

    let raw = "";
    try {
      const response = await groq.chat.completions.create(groqParams);
      raw = response.choices?.[0]?.message?.content ?? "";
    } catch (err: unknown) {
      const apiErr = err as { status?: number; error?: { message?: string } };

      if (apiErr?.status === 429) {
        const errMsg = apiErr?.error?.message ?? "";
        const retryAfterMs = parseRetryAfterMs(errMsg);

        if (retryAfterMs <= 8000) {
          await new Promise((r) => setTimeout(r, retryAfterMs));
          try {
            const retryResponse = await groq.chat.completions.create(groqParams);
            raw = retryResponse.choices?.[0]?.message?.content ?? "";
          } catch {
            return NextResponse.json(
              buildFallbacks(recentFocus, ctx),
              { headers: { "X-Rate-Limited": "true" } }
            );
          }
        } else {
          return NextResponse.json(
            buildFallbacks(recentFocus, ctx),
            { headers: { "X-Rate-Limited": "true" } }
          );
        }
      } else {
        throw err;
      }
    }

    let parsed: unknown[] = [];
    try {
      const stripped = raw.replace(/```json|```/gi, "").trim();
      const match = stripped.match(/\[[\s\S]*\]/);
      if (match) parsed = JSON.parse(match[0]);
    } catch {
      // fall through to fallback fill
    }

    const valid: Suggestion[] = parsed
      .filter(isValidSuggestion)
      .map((s) => ({
        type: s.type,
        preview: s.preview.trim(),
        full: truncateToSentences(s.full.trim(), 2),
      }));

    const deduplicated = deduplicateBatch(valid);

    const normalizedPrevious = safePreviousPreviews.map(normalizePreview);
    const crossBatchFiltered = deduplicated.filter(
      (s) =>
        !normalizedPrevious.some(
          (p) =>
            p === normalizePreview(s.preview) ||
            (normalizePreview(s.preview).length >= 30 &&
              p.includes(normalizePreview(s.preview).slice(0, 30)))
        )
    );

    const final = crossBatchFiltered.slice(0, 3);

    if (final.length < 3) {
      const fallbacks = buildFallbacks(recentFocus, ctx);
      for (const fb of fallbacks) {
        if (final.length >= 3) break;
        const alreadyPresent = final.some(
          (s) => normalizePreview(s.preview) === normalizePreview(fb.preview)
        );
        if (!alreadyPresent) final.push(fb);
      }
    }

    return NextResponse.json(final);
  } catch (err) {
    console.error("[suggestions] Unexpected error:", err);
    return NextResponse.json(
      buildFallbacks("the current discussion", {
        mode: "general meeting",
        recentSignals: [],
        typingGuidance: "Use a balanced mix of question, insight, and action.",
      })
    );
  }
}