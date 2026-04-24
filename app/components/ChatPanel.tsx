"use client";

import { useEffect, useRef, useState, useMemo, useCallback } from "react";
import { Message, TranscriptChunk } from "@/types";

interface Props {
  messages: Message[];
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
  transcriptChunks?: TranscriptChunk[];
  onExportJSON: () => void;
  onExportTXT: () => void;
  settings: {
    apiKey: string;
    suggestionPrompt: string;
    expandPrompt: string;
    chatPrompt: string;
    suggestionContext: number;
    chatContext: number;
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const MAX_MESSAGES = 25;
const SEND_COOLDOWN_MS = 2000;

// ---------------------------------------------------------------------------
// Rate limit state shape
// ---------------------------------------------------------------------------
interface RateLimitState {
  active: boolean;
  retryAfterMs: number;
  remainingMs: number;
}

const RATE_LIMIT_IDLE: RateLimitState = {
  active: false,
  retryAfterMs: 0,
  remainingMs: 0,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parses the retryAfter field from a 429 JSON response body.
 * Falls back to 5s so the UI always shows a countdown.
 */
async function parseRetryAfterFromResponse(res: Response): Promise<number> {
  try {
    const data = await res.json();
    const seconds =
      typeof data?.retryAfter === "number"
        ? data.retryAfter
        : typeof data?.retryAfter === "string"
        ? parseFloat(data.retryAfter)
        : 5;
    return Math.ceil(seconds) * 1000;
  } catch {
    return 5000;
  }
}

/**
 * Strips the [TYPE] prefix from suggestion-click messages for display.
 *
 * SuggestionsPanel sends messages prefixed with [QUESTION], [INSIGHT], etc.
 * so the chat route can detect and route them to the expand prompt.
 * The prefix is an internal routing mechanism — the user should never see
 * "[INSIGHT] What happens at 10x load?" in their chat bubble.
 * This strips it for rendering only; the stored message retains the prefix
 * so the chat history stays correct for the API.
 */
function stripTypePrefix(content: string): string {
  return content.replace(/^\[[\w-]+\]\s*/i, "").trim();
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
export default function ChatPanel({
  messages = [],
  setMessages,
  transcriptChunks,
  onExportJSON,
  onExportTXT,
  settings,
}: Props) {
  const safeChunks = transcriptChunks ?? [];

  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [sendCooldown, setSendCooldown] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [justFinished, setJustFinished] = useState(false);
  const [rateLimit, setRateLimit] = useState<RateLimitState>(RATE_LIMIT_IDLE);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const isStreamingRef = useRef(false);
  const forceScrollRef = useRef(false);
  const rateLimitTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const visibleMessages = messages.slice(-MAX_MESSAGES);
  const apiKey = settings?.apiKey?.trim();
  const hasApiKey = !!apiKey && apiKey.length > 10;

  const transcriptText = useMemo(() => {
    const recentChunks = safeChunks.slice(-(settings.chatContext || 3));
    return recentChunks.map((t) => t.text).join("\n");
  }, [safeChunks, settings.chatContext]);

  // -------------------------------------------------------------------------
  // Rate limit countdown ticker
  // -------------------------------------------------------------------------
  const startRateLimitCountdown = useCallback((retryAfterMs: number) => {
    if (rateLimitTimerRef.current) clearInterval(rateLimitTimerRef.current);

    const endsAt = Date.now() + retryAfterMs;
    setRateLimit({ active: true, retryAfterMs, remainingMs: retryAfterMs });

    rateLimitTimerRef.current = setInterval(() => {
      const remaining = endsAt - Date.now();

      if (remaining <= 0) {
        clearInterval(rateLimitTimerRef.current!);
        rateLimitTimerRef.current = null;
        setRateLimit(RATE_LIMIT_IDLE);
      } else {
        setRateLimit((prev) => ({ ...prev, remainingMs: remaining }));
      }
    }, 500);
  }, []);

  useEffect(() => {
    return () => {
      if (rateLimitTimerRef.current) clearInterval(rateLimitTimerRef.current);
    };
  }, []);

  // -------------------------------------------------------------------------
  // Scroll logic
  // -------------------------------------------------------------------------
  useEffect(() => {
    const handler = () => { forceScrollRef.current = true; };
    window.addEventListener("force-chat-scroll", handler);
    return () => window.removeEventListener("force-chat-scroll", handler);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    if (forceScrollRef.current) {
      el.scrollTop = el.scrollHeight;
      forceScrollRef.current = false;
      return;
    }

    if (isStreamingRef.current || autoScroll) {
      el.scrollTop = el.scrollHeight;
    }
  }, [visibleMessages, autoScroll]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    setAutoScroll(nearBottom);
  };

  // -------------------------------------------------------------------------
  // Send
  // -------------------------------------------------------------------------
  const handleSend = async () => {
    if (
      !input.trim() ||
      loading ||
      sendCooldown ||
      isStreamingRef.current ||
      rateLimit.active
    )
      return;

    if (!hasApiKey) {
      alert("Please enter a valid Groq API key in Settings");
      return;
    }

    setSendCooldown(true);
    setTimeout(() => setSendCooldown(false), SEND_COOLDOWN_MS);

    const userMessage: Message = {
      role: "user",
      content: input.trim(),
      timestamp: Date.now(),
    };

    const updatedMessages = [...messages, userMessage];

    forceScrollRef.current = true;
    setMessages(updatedMessages);
    setInput("");
    setLoading(true);
    isStreamingRef.current = true;

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: updatedMessages.slice(-10),
          apiKey,
          transcript: transcriptText,
          customPrompt: settings.chatPrompt,
          contextWindow: settings.chatContext,
        }),
      });

      if (res.status === 429) {
        const retryAfterMs = await parseRetryAfterFromResponse(res);
        const retryAfterSec = Math.ceil(retryAfterMs / 1000);

        startRateLimitCountdown(retryAfterMs);

        setMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            content: `⚠️ Groq rate limit hit. You can send again in ${retryAfterSec}s.`,
            timestamp: Date.now(),
          },
        ]);
        return;
      }

      if (!res.ok) throw new Error(`Unexpected response: ${res.status}`);
      if (!res.body) throw new Error("No response body from server");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let finalText = "";

      forceScrollRef.current = true;
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: "", timestamp: Date.now() },
      ]);

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunkText = decoder.decode(value, { stream: true });
        if (!chunkText) continue;

        finalText += chunkText;

        await new Promise((r) => setTimeout(r, 8));

        setMessages((prev) => {
          const updated = [...prev];
          updated[updated.length - 1] = {
            ...updated[updated.length - 1],
            content: finalText,
          };
          return updated;
        });
      }

      if (!finalText.trim()) {
        setMessages((prev) => {
          const updated = [...prev];
          updated[updated.length - 1] = {
            ...updated[updated.length - 1],
            content: "Not enough context to give a useful answer.",
          };
          return updated;
        });
      }

      setJustFinished(true);
      setTimeout(() => setJustFinished(false), 1200);
    } catch (err: unknown) {
      console.error("[ChatPanel] send error:", err);

      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: "⚠️ Something went wrong. Please try again.",
          timestamp: Date.now(),
        },
      ]);
    } finally {
      setLoading(false);
      isStreamingRef.current = false;
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleSend();
    }
  };

  // -------------------------------------------------------------------------
  // Derived UI state
  // -------------------------------------------------------------------------
  const isSendDisabled = loading || sendCooldown || !input.trim() || rateLimit.active;
  const rateLimitSecondsLeft = Math.ceil(rateLimit.remainingMs / 1000);

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------
  return (
    <div className="border rounded-xl p-4 h-full flex flex-col min-h-0">
      {/* Header */}
      <div className="flex justify-between items-center mb-3 flex-shrink-0">
        <h2 className="font-semibold">Chat</h2>
        <div className="flex gap-2">
          <button
            onClick={onExportJSON}
            className="bg-green-600 px-3 py-1 rounded text-xs hover:bg-green-500"
          >
            JSON
          </button>
          <button
            onClick={onExportTXT}
            className="bg-blue-600 px-3 py-1 rounded text-xs hover:bg-blue-500"
          >
            TXT
          </button>
        </div>
      </div>

      {/* Rate limit banner */}
      {rateLimit.active && (
        <div className="mb-2 flex items-center gap-2 rounded-lg bg-yellow-900/30 border border-yellow-700/50 px-3 py-2 text-xs text-yellow-300 flex-shrink-0">
          <span className="animate-pulse">⏳</span>
          <span>
            Rate limited — sending again in{" "}
            <span className="font-semibold tabular-nums">{rateLimitSecondsLeft}s</span>
          </span>
        </div>
      )}

      {/* Message list */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto space-y-3 mb-2 pr-1 min-h-0"
      >
        {visibleMessages.length === 0 ? (
          <p className="text-gray-500 text-sm">
            Click a suggestion or type a message...
          </p>
        ) : (
          visibleMessages.map((msg, i) => (
            <div
              key={i}
              className={`max-w-[80%] p-3 rounded-lg text-sm animate-fadeIn ${
                msg.role === "user"
                  ? "bg-blue-600 ml-auto"
                  : "bg-gray-800 mr-auto"
              }`}
            >
              {/*
               * Strip [TYPE] prefix for display only.
               * The stored message retains it so the chat route can detect
               * suggestion clicks via isSuggestionClick() on replay.
               * Freeform messages have no prefix so stripTypePrefix is a no-op.
               */}
              {stripTypePrefix(msg.content)}
            </div>
          ))
        )}

        {loading && (
          <div className="text-gray-400 text-xs italic animate-pulse">
            💭 Thinking...
          </div>
        )}

        {justFinished && (
          <div className="text-xs text-green-400">✓ Response ready</div>
        )}
      </div>

      {/* Input row */}
      <div className="flex gap-2 mt-1 flex-shrink-0">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={
            rateLimit.active
              ? `Rate limited — ${rateLimitSecondsLeft}s remaining…`
              : "Type a message..."
          }
          disabled={loading || rateLimit.active}
          className="flex-1 px-3 py-2 rounded bg-gray-900 border border-gray-700 text-white text-sm disabled:opacity-50"
        />

        <button
          onClick={handleSend}
          disabled={isSendDisabled}
          className={`bg-blue-600 px-4 py-2 rounded hover:bg-blue-500 ${
            isSendDisabled ? "opacity-50 cursor-not-allowed" : ""
          }`}
        >
          {rateLimit.active ? `${rateLimitSecondsLeft}s` : "Send"}
        </button>
      </div>
    </div>
  );
}