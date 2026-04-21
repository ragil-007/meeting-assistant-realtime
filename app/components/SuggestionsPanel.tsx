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
  setSuggestionBatches: React.Dispatch<
    React.SetStateAction<SuggestionBatch[]>
  >;

  memory: {
    summary: string;
    topics: string[];
    lastUpdated: number;
  };
  setMemory: React.Dispatch<any>;

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

export default function SuggestionsPanel({
  transcriptChunks,
  messages,
  setMessages,
  suggestionBatches,
  setSuggestionBatches,
  memory,
  setMemory,
  isRecording,
  settings,
}: Props) {
  const safeChunks = transcriptChunks ?? [];

  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<"idle" | "analyzing" | "updated">("idle");

  const lastSourceHashRef = useRef<string>("");
  const hasGeneratedFirst = useRef(false);
  const lastRunRef = useRef(0);

  const chunksRef = useRef<TranscriptChunk[]>([]);
  useEffect(() => {
    chunksRef.current = safeChunks;
  }, [safeChunks]);

  const apiKey = settings.apiKey?.trim();
  const hasApiKey = !!apiKey && apiKey.length > 10;

  const normalize = (text: string) =>
    text.toLowerCase().replace(/[^\w\s]/g, "").trim();

  // 🔥 MEMORY
  const updateMemory = async (latestText: string) => {
    if (!latestText || latestText.length < 30) return;
    if (!hasApiKey) return;

    try {
      const res = await fetch("/api/memory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          previousSummary: memory.summary,
          latestText,
          apiKey,
        }),
      });

      if (!res.ok || res.status === 429) return;

      const data = await res.json();

      setMemory({
        summary: data.summary,
        topics: data.topics,
        lastUpdated: Date.now(),
      });
    } catch (err) {
      console.error("Memory error:", err);
    }
  };

  const fetchSuggestions = useCallback(
    async (segmentText: string, force = false) => {
      if (!hasApiKey || loading) return;

      const now = Date.now();

      // 🔥 throttle protection
      if (!force && now - lastRunRef.current < 25000) return;
      lastRunRef.current = now;

      const sourceHash = normalize(segmentText);

      const MIN_CHANGE_LENGTH = 40;

      if (!force && lastSourceHashRef.current) {
        const prev = lastSourceHashRef.current;
        const diff = sourceHash.replace(prev, "");

        if (diff.length < MIN_CHANGE_LENGTH) {
          return;
        }
      }

      lastSourceHashRef.current = sourceHash;

      setLoading(true);
      setStatus("analyzing");

      try {
        const res = await fetch("/api/suggestions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            transcript: segmentText,
            memory,
            previousSuggestions: suggestionBatches
              .flatMap((b) => b.items)
              .slice(0, 15),
            apiKey,
            customPrompt: settings.suggestionPrompt,
            contextWindow: settings.suggestionContext,
          }),
        });

        if (!res.ok || res.status === 429) return;

        const data = await res.json();
        if (!Array.isArray(data)) return;

        const cleaned: Suggestion[] = data
          .slice(0, 3)
          .map((s: any) => ({
            type: s?.type || "info",
            preview: s?.preview || s?.text || "No preview",
            full:
              s?.full ||
              s?.text ||
              s?.preview ||
              "No content",
            score: Number(s?.score) || 50,
          }));

        if (cleaned.length !== 3) return;

        const newBatch: SuggestionBatch = {
          id: Date.now(),
          timestamp: Date.now(),
          items: cleaned.sort((a, b) => b.score - a.score),
          sourceHash,
        };

        setSuggestionBatches((prev) => [newBatch, ...prev]);

        updateMemory(segmentText);

        // ✅ UX feedback
        setStatus("updated");
        setTimeout(() => setStatus("idle"), 2000);
      } catch (err) {
        console.error("Suggestions error:", err);
      } finally {
        setLoading(false);
      }
    },
    [hasApiKey, loading, memory, suggestionBatches, settings]
  );

  // 🔥 FIRST TRIGGER (instant, no delay)
  useEffect(() => {
    if (!hasApiKey) return;
    if (!isRecording) return;

    const contextSize = settings.suggestionContext || 5;

    const combined = safeChunks
      .slice(-contextSize)
      .map((c) => c.text)
      .join(" ");

    if (
      combined.length > 80 &&
      !hasGeneratedFirst.current
    ) {
      fetchSuggestions(combined, true);
      hasGeneratedFirst.current = true;
    }
  }, [safeChunks, isRecording]);

  // 🔥 TRUE 30s LOOP
  useEffect(() => {
    if (!hasApiKey) return;
    if (!isRecording) return;

    const interval = setInterval(() => {
      const chunks = chunksRef.current;
      if (!chunks || chunks.length === 0) return;

      const contextSize = settings.suggestionContext || 5;

      const combined = chunks
        .slice(-contextSize)
        .map((c) => c.text)
        .join(" ");

      if (combined.length > 50) {
        fetchSuggestions(combined);
      }
    }, 30000);

    return () => clearInterval(interval);
  }, [hasApiKey, isRecording, settings.suggestionContext, fetchSuggestions]);

  // 💬 CLICK
  const handleSuggestionClick = async (suggestion: Suggestion) => {
    if (!hasApiKey) {
      alert("Set API key first!");
      return;
    }

    const contextSize = settings.chatContext || 5;

    const transcriptText = safeChunks
      .slice(-contextSize)
      .map((c) => c.text)
      .join("\n");

    const userMessage: Message = {
      role: "user",
      content: `[${suggestion.type.toUpperCase()}] ${suggestion.full}`,
      timestamp: Date.now(),
    };

    setMessages((prev) => [...prev, userMessage]);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [...messages, userMessage].slice(-20),
          transcript: transcriptText,
          apiKey,
          customPrompt: settings.expandPrompt,
          contextWindow: settings.chatContext,
        }),
      });

      if (!res.ok || !res.body) throw new Error();

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let finalText = "";

      const assistantMessage: Message = {
        role: "assistant",
        content: "",
        timestamp: Date.now(),
      };

      setMessages((prev) => [...prev, assistantMessage]);

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        finalText += decoder.decode(value);

        setMessages((prev) => {
          const updated = [...prev];
          updated[updated.length - 1].content = finalText;
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
    }
  };

  return (
    <div className="border rounded-xl p-4 h-full flex flex-col min-h-0">
      <div className="flex-shrink-0">
        <h2 className="font-semibold mb-2">Suggestions</h2>

        <button
          onClick={() => {
            if (!hasApiKey) {
              alert("Set API key first!");
              return;
            }

            const combined = safeChunks
              .slice(-(settings.suggestionContext || 5))
              .map((c) => c.text)
              .join(" ");

            fetchSuggestions(combined, true);
          }}
          disabled={loading || safeChunks.length === 0}
          className="bg-gray-700 px-3 py-1 rounded mb-2 hover:bg-gray-600 disabled:opacity-50"
        >
          {loading ? "Generating..." : "Refresh"}
        </button>

        {/* 🔥 UX STATUS */}
        <div className="text-xs text-gray-400 mb-2">
          {status === "analyzing" && "🧠 Analyzing context..."}
          {status === "updated" && "✅ Suggestions updated"}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto space-y-5 pr-1 min-h-0">
        {suggestionBatches.length === 0 && (
          <p className="text-sm text-gray-500">
            {loading
              ? "Analyzing conversation..."
              : "Suggestions will appear here..."}
          </p>
        )}

        {suggestionBatches.map((batch) => (
          <div key={batch.id} className="space-y-2">
            <div className="text-xs text-gray-500">
              {new Date(batch.timestamp).toLocaleTimeString()}
            </div>

            {batch.items.map((s, i) => (
              <div
                key={i}
                onClick={() => handleSuggestionClick(s)}
                className={`p-3 border rounded-lg cursor-pointer transition ${
                  i === 0
                    ? "border-blue-400 bg-gray-800"
                    : "hover:bg-gray-800"
                }`}
              >
                <p className="text-sm font-medium">
                  {s.preview}
                </p>

                <span className="text-xs text-blue-400 uppercase mt-1 inline-block">
                  {s.type}
                </span>

                {i === 0 && (
                  <span className="ml-2 text-[10px] text-green-400">
                    ★ Top
                  </span>
                )}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}