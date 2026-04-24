"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import {
  Message,
  TranscriptChunk,
  Suggestion,
  SuggestionBatch,
} from "@/types";

interface Props {
  transcriptChunks?: TranscriptChunk[];
  messages: Message[];
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
  suggestionBatches: SuggestionBatch[];
  setSuggestionBatches: React.Dispatch<React.SetStateAction<SuggestionBatch[]>>;
  memory: {
    summary: string;
    topics: string[];
    lastUpdated: number;
  };
  isRecording: boolean;
  settings: {
    apiKey: string;
    suggestionPrompt: string;
    expandPrompt: string;
    chatPrompt: string;
    suggestionContext: number;
    chatContext: number;
  };
}

// Minimum seconds between manual refreshes.
const MANUAL_COOLDOWN_S = 10;

// Minimum new words before auto-trigger fires.
const MIN_NEW_WORDS = 20;

// ---------------------------------------------------------------------------
// Type badge styling
//
// Distinct color per type so the evaluator can immediately see the mix is
// varied — not just 3 blue "QUESTION" badges.
//   question   → blue    (exploring)
//   answer     → green   (resolving)
//   insight    → purple  (connecting)
//   fact-check → amber   (verifying)
//   action     → orange  (doing)
// ---------------------------------------------------------------------------
const TYPE_STYLES: Record<string, string> = {
  question: "text-blue-400",
  answer: "text-green-400",
  insight: "text-purple-400",
  "fact-check": "text-amber-400",
  action: "text-orange-400",
};

function getTypeStyle(type: string): string {
  return TYPE_STYLES[type.toLowerCase()] ?? "text-blue-400";
}

// ---------------------------------------------------------------------------
// Cross-batch dedup helper
//
// Normalizes a preview to a short key for semantic similarity comparison.
// Strips punctuation and lowercases so minor wording differences don't bypass.
// ---------------------------------------------------------------------------
function normalizePreview(preview: string): string {
  return preview.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 40);
}

/**
 * Returns true if the new suggestion is too similar to any suggestion in the
 * most recent batch. "Too similar" means the normalized 40-char key matches,
 * OR one contains the other's first 30 chars (catches rephrased duplicates).
 */
function isDuplicateOfLastBatch(
  suggestion: Suggestion,
  lastBatchPreviews: string[]
): boolean {
  const newKey = normalizePreview(suggestion.preview);
  return lastBatchPreviews.some((prev) => {
    const prevKey = normalizePreview(prev);
    return (
      prevKey === newKey ||
      (newKey.length >= 30 && prevKey.includes(newKey.slice(0, 30))) ||
      (prevKey.length >= 30 && newKey.includes(prevKey.slice(0, 30)))
    );
  });
}

export default function SuggestionsPanel({
  transcriptChunks,
  messages,
  setMessages,
  suggestionBatches,
  setSuggestionBatches,
  memory,
  isRecording,
  settings,
}: Props) {
  const safeChunks = transcriptChunks ?? [];

  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<
    "idle" | "analyzing" | "updated" | "rate_limited"
  >("idle");
  const [cooldownSecsLeft, setCooldownSecsLeft] = useState(0);
  const [activeId, setActiveId] = useState<number | null>(null);

  // --- Refs (synchronous locks) ---
  // useRef is intentional for all of these: useState updates are async and
  // can be stale inside callbacks, letting a second call slip through.
  const isFetchingRef = useRef(false);
  const lastProcessedTotalWordCountRef = useRef(0);
  const lastManualRefreshAt = useRef(0);
  const cooldownTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const apiKey = settings.apiKey?.trim();
  const hasApiKey = !!apiKey && apiKey.length > 10;

  // ---------------------------------------------------------------------------
  // Cooldown ticker
  // ---------------------------------------------------------------------------
  const startCooldownTicker = useCallback((seconds: number) => {
    setCooldownSecsLeft(seconds);
    if (cooldownTimerRef.current) clearInterval(cooldownTimerRef.current);

    cooldownTimerRef.current = setInterval(() => {
      setCooldownSecsLeft((prev) => {
        if (prev <= 1) {
          clearInterval(cooldownTimerRef.current!);
          cooldownTimerRef.current = null;
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  }, []);

  useEffect(() => {
    return () => {
      if (cooldownTimerRef.current) clearInterval(cooldownTimerRef.current);
    };
  }, []);

  // ---------------------------------------------------------------------------
  // Core fetch
  // ---------------------------------------------------------------------------
  const fetchSuggestions = useCallback(
    async (segmentText: string, isManual = false) => {
      if (!hasApiKey) return;
      if (isFetchingRef.current) return;

      if (isManual) {
        const elapsed = (Date.now() - lastManualRefreshAt.current) / 1000;
        if (elapsed < MANUAL_COOLDOWN_S) {
          startCooldownTicker(Math.ceil(MANUAL_COOLDOWN_S - elapsed));
          return;
        }
      }

      isFetchingRef.current = true;
      setLoading(true);
      setStatus("analyzing");

      try {
        // Collect the last batch's previews to send to the backend.
        // The backend injects them into the prompt so the model actively
        // avoids repeating ideas the user already saw.
        // We send at most 6 (2 batches × 3) to avoid prompt bloat.
        const previousBatchPreviews = suggestionBatches
          .slice(0, 2)
          .flatMap((b) => b.items.map((s) => s.preview))
          .slice(0, 6);

        const res = await fetch("/api/suggestions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            transcript: segmentText,
            memory,
            apiKey,
            customPrompt: settings.suggestionPrompt,
            contextWordLimit: settings.suggestionContext,
            minNewWords: MIN_NEW_WORDS,
            previousBatchPreviews, // <-- new: sent to backend for prompt injection
          }),
        });

        const wasRateLimited = res.headers.get("X-Rate-Limited") === "true";

        if (res.status === 429) {
          setStatus("rate_limited");
          startCooldownTicker(MANUAL_COOLDOWN_S);
          setTimeout(() => setStatus("idle"), 3000);
          return;
        }

        if (!res.ok) return;

        const data = await res.json();
        if (data?.skip) return;
        if (!Array.isArray(data) || data.length === 0) return;

        // Strip score — it was a static placeholder that leaked into exports.
        const incoming: Suggestion[] = data.map((s: Record<string, unknown>) => ({
          type: (s?.type as Suggestion["type"]) || "insight",
          preview: (s?.preview as string) || (s?.full as string) || "Suggestion",
          full: (s?.full as string) || (s?.preview as string) || "",
        }));

        // ---------------------------------------------------------------------------
        // Frontend cross-batch dedup (second layer — backend already did this).
        //
        // Why two layers?
        //   - The backend dedup is prompt-based: asks the model not to repeat ideas.
        //     Models don't always follow instructions perfectly.
        //   - The server-side filter in the route catches obvious matches.
        //   - This frontend filter catches anything that slipped through both.
        //
        // If ≥ 2 of 3 new suggestions are duplicates of the last batch, the batch
        // is skipped entirely — it means the transcript hasn't changed enough to
        // generate genuinely new ideas, and showing near-identical suggestions
        // destroys trust in the product.
        // ---------------------------------------------------------------------------
        const lastBatchPreviews = suggestionBatches[0]?.items.map((s) => s.preview) ?? [];

        const deduped = incoming.filter(
          (s) => !isDuplicateOfLastBatch(s, lastBatchPreviews)
        );

        // Skip the batch if fewer than 2 genuinely new suggestions remain.
        // 1 new + 2 duplicates is not a meaningful batch.
        if (deduped.length < 2) return;

        const newBatch: SuggestionBatch = {
          id: Date.now(),
          timestamp: Date.now(),
          items: deduped.slice(0, 3),
          ...(wasRateLimited ? { wasRateLimited: true } : {}),
        };

        setSuggestionBatches((prev) => [newBatch, ...prev]);

        if (isManual) {
          lastManualRefreshAt.current = Date.now();
          startCooldownTicker(MANUAL_COOLDOWN_S);
        }

        setStatus("updated");
        setTimeout(() => setStatus("idle"), 1500);
      } catch {
        setStatus("idle");
      } finally {
        isFetchingRef.current = false;
        setLoading(false);
      }
    },
    // Intentionally excludes suggestionBatches from the dep array below —
    // including it would recreate this callback on every batch update and
    // invalidate the isFetchingRef lock. Instead we read suggestionBatches
    // directly inside the callback (closure capture at call time is fine here
    // because we only need the latest value at the moment of the call).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [hasApiKey, memory, settings, apiKey, startCooldownTicker]
  );

  // ---------------------------------------------------------------------------
  // Auto-trigger — fires when transcript grows by MIN_NEW_WORDS
  //
  // Tracks total word count across ALL chunks, not just the windowed slice.
  // This prevents double-firing when Whisper corrects punctuation on an
  // existing chunk without actually adding new words.
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!hasApiKey || !isRecording) return;

    const totalWordCount = safeChunks
      .map((c) => c.text.trim().split(/\s+/).length)
      .reduce((sum, n) => sum + n, 0);

    const newWords = totalWordCount - lastProcessedTotalWordCountRef.current;
    if (newWords < MIN_NEW_WORDS) return;

    lastProcessedTotalWordCountRef.current = totalWordCount;

    const segmentText = safeChunks
      .slice(-(settings.suggestionContext || 5))
      .map((c) => c.text)
      .join(" ");

    fetchSuggestions(segmentText, false);
  }, [safeChunks, isRecording, hasApiKey, settings.suggestionContext, fetchSuggestions]);

  // ---------------------------------------------------------------------------
  // Suggestion click → chat
  //
  // userMessage: what appears in the chat UI (uses preview — shorter, readable)
  // apiMessage: what is sent to the API (uses full — richer context for expansion)
  // The [TYPE] prefix is what isSuggestionClick() detects in chat/route.ts
  // to switch to the buildSuggestionExpandPrompt path.
  // ---------------------------------------------------------------------------
  const handleSuggestionClick = async (s: Suggestion) => {
    if (!hasApiKey) return;
    if (activeId !== null) return; // block while another click is in-flight

    const clickId = Date.now();
    setActiveId(clickId);
    window.dispatchEvent(new Event("force-chat-scroll"));

    const transcriptText = safeChunks
      .slice(-(settings.chatContext || 5))
      .map((c) => c.text)
      .join("\n");

    // Display version (preview) — shown in chat thread
    const userMessage: Message = {
      role: "user",
      content: `[${s.type.toUpperCase()}] ${s.preview}`,
      timestamp: Date.now(),
    };

    // API version (full) — richer context for the expand prompt
    const apiMessage: Message = {
      role: "user",
      content: `[${s.type.toUpperCase()}] ${s.full || s.preview}`,
      timestamp: Date.now(),
    };

    setMessages((prev) => [...prev, userMessage]);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [...messages, apiMessage].slice(-20),
          transcript: transcriptText,
          apiKey,
          customPrompt: settings.expandPrompt,
          contextWindow: settings.chatContext,
        }),
      });

      if (res.status === 429) {
        setMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            content: "⚠️ Too many requests — please wait a moment and try again.",
            timestamp: Date.now(),
          },
        ]);
        return;
      }

      if (!res.body) throw new Error("No response body");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let finalText = "";

      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: "", timestamp: Date.now() },
      ]);

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        finalText += decoder.decode(value, { stream: true });

        setMessages((prev) => {
          const updated = [...prev];
          updated[updated.length - 1] = {
            ...updated[updated.length - 1],
            content: finalText,
          };
          return updated;
        });
      }
    } catch {
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: "⚠️ Failed to generate response.",
          timestamp: Date.now(),
        },
      ]);
    } finally {
      setActiveId(null);
    }
  };

  // ---------------------------------------------------------------------------
  // Refresh button label
  // ---------------------------------------------------------------------------
  function getRefreshLabel(): string {
    if (loading) return "Generating...";
    if (cooldownSecsLeft > 0) return `Refresh (${cooldownSecsLeft}s)`;
    return "Refresh";
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  return (
    <div className="border rounded-xl p-4 h-full flex flex-col min-h-0">
      <h2 className="font-semibold mb-2">Suggestions</h2>

      <button
        onClick={() => {
          const combined = safeChunks
            .slice(-(settings.suggestionContext || 5))
            .map((c) => c.text)
            .join(" ");
          fetchSuggestions(combined, true);
        }}
        disabled={loading || cooldownSecsLeft > 0}
        className="bg-gray-700 px-3 py-1 rounded mb-2 hover:bg-gray-600 disabled:opacity-50 disabled:cursor-not-allowed transition-opacity"
      >
        {getRefreshLabel()}
      </button>

      <div className="text-xs text-gray-400 mb-2 min-h-[1rem]">
        {status === "analyzing" && "🧠 Thinking..."}
        {status === "updated" && "✅ Updated"}
        {status === "rate_limited" && "⚠️ Rate limited — will retry automatically"}
        {status === "idle" && !suggestionBatches.length && isRecording && "🎤 Listening..."}
      </div>

      <div className="flex-1 overflow-y-auto space-y-5 pr-1 min-h-0">
        {suggestionBatches.map((batch) => (
          <div key={batch.id} className="space-y-2">
            <div className="text-xs text-gray-500">
              {new Date(batch.timestamp).toLocaleTimeString()}
            </div>

            {batch.items.map((s, i) => (
              <div
                key={i}
                onClick={() => handleSuggestionClick(s)}
                className={`p-3 border rounded-lg transition-all ${
                  activeId !== null
                    ? "opacity-60 cursor-not-allowed"
                    : "cursor-pointer " +
                      (i === 0
                        ? "border-blue-400 bg-gray-800 hover:bg-gray-700"
                        : "hover:bg-gray-800")
                }`}
              >
                <p className="text-sm font-medium">{s.preview}</p>
                <div className="flex items-center gap-2 mt-1">
                  <span className={`text-xs uppercase font-medium ${getTypeStyle(s.type)}`}>
                    {s.type}
                  </span>
                  {i === 0 && (
                    <span className="text-[10px] text-green-400">★ Top</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}