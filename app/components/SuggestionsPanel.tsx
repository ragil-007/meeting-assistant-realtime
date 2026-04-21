"use client";

import { useEffect, useState, useRef } from "react";
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

  const scrollRef = useRef<HTMLDivElement | null>(null);

  const lastProcessedIndexRef = useRef<number>(-1);
  const lastSourceHashRef = useRef<string>("");
  const memoryCounterRef = useRef(0);
  const lastFetchTimeRef = useRef(0);

  // 🔑 API KEY
  const apiKey = settings.apiKey?.trim();
  const hasApiKey = !!apiKey && apiKey.length > 10;

  const normalize = (text: string) =>
    text.toLowerCase().replace(/[^\w\s]/g, "").trim();

  const typeLabelMap: Record<string, string> = {
    question: "❓ Question",
    insight: "🧠 Insight",
    action: "⚡ Action",
  };

  const safeTypeLabel = (type?: string) =>
    typeLabelMap[type || ""] || "ℹ️ Info";

  const safeTypeTag = (type?: string) =>
    (type || "info").toUpperCase();

  // 🧠 MEMORY
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

  // 🔁 AUTO GENERATION
  useEffect(() => {
    if (!isRecording || !hasApiKey || safeChunks.length === 0) return;

    const latestIndex = safeChunks.length - 1;
    if (latestIndex === lastProcessedIndexRef.current) return;

    lastProcessedIndexRef.current = latestIndex;

    const contextSize = settings.suggestionContext || 5;

    const combinedText = safeChunks
      .slice(-contextSize)
      .map((c) => c.text)
      .join(" ");

    if (combinedText.length < 30) return;

    fetchSuggestions(combinedText);

    memoryCounterRef.current++;
    if (memoryCounterRef.current % 2 === 0) {
      updateMemory(combinedText);
    }
  }, [safeChunks, isRecording, settings.suggestionContext, hasApiKey]);

  // ⏱ INTERVAL BACKUP
  useEffect(() => {
    if (!isRecording || !hasApiKey) return;

    const interval = setInterval(() => {
      if (safeChunks.length === 0) return;

      const contextSize = settings.suggestionContext || 5;

      const combined = safeChunks
        .slice(-contextSize)
        .map((c) => c.text)
        .join(" ");

      if (combined.length > 30) {
        fetchSuggestions(combined, true);
      }
    }, 20000);

    return () => clearInterval(interval);
  }, [safeChunks, isRecording, settings.suggestionContext, hasApiKey]);

  // 🚀 FETCH
  const fetchSuggestions = async (
    segmentText: string,
    force = false
  ) => {
    if (!hasApiKey) return;

    const now = Date.now();
    if (!force && now - lastFetchTimeRef.current < 3500) return;
    lastFetchTimeRef.current = now;

    const sourceHash = normalize(segmentText);
    if (!force && sourceHash === lastSourceHashRef.current) return;
    lastSourceHashRef.current = sourceHash;

    setLoading(true);

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
          force,
        }),
      });

      if (!res.ok || res.status === 429) return;

      const data = await res.json();
      if (!Array.isArray(data)) return;

      const cleaned: Suggestion[] = data
        .slice(0, 3)
        .map((s: any) => ({
          type: s?.type || "info",
          preview:
            s?.preview ||
            s?.text ||
            "No preview available",
          full:
            s?.full ||
            s?.text ||
            s?.preview ||
            "No content available",
          score: Number(s?.score) || 50,
        }));

      const newBatch: SuggestionBatch = {
        id: Date.now(),
        timestamp: Date.now(),
        items: cleaned.sort((a, b) => b.score - a.score),
        sourceHash,
      };

      setSuggestionBatches((prev) => [newBatch, ...prev]);
    } catch (err) {
      console.error("Suggestions error:", err);
    } finally {
      setLoading(false);
    }
  };

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
      content: `[${safeTypeTag(suggestion?.type)}] ${
        suggestion?.full || suggestion?.preview
      }`,
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
          content:
            "⚠️ Failed to generate response. Please try again.",
          timestamp: Date.now(),
        },
      ]);
    }
  };

  return (
    <div className="border rounded-xl p-4 h-full flex flex-col min-h-0">

      {/* 🔥 FIXED HEADER */}
      <div className="flex-shrink-0">
        <h2 className="font-semibold mb-2">Suggestions</h2>

        <button
          onClick={() => {
            if (!hasApiKey) {
              alert("Set API key first!");
              return;
            }

            if (safeChunks.length > 0) {
              const contextSize =
                settings.suggestionContext || 5;

              const combined = safeChunks
                .slice(-contextSize)
                .map((c) => c.text)
                .join(" ");

              fetchSuggestions(combined, true);
            }
          }}
          disabled={loading || safeChunks.length === 0}
          className="bg-gray-700 px-3 py-1 rounded mb-3 hover:bg-gray-600 disabled:opacity-50"
        >
          {loading ? "Generating..." : "Refresh"}
        </button>
      </div>

      {/* 🔥 SCROLL ONLY THIS */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto space-y-5 pr-1 min-h-0"
      >
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
                  {safeTypeLabel(s.type)}
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