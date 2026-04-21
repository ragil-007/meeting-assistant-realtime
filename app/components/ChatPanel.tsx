"use client";

import { useEffect, useRef, useState, useMemo } from "react";
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
  const [autoScroll, setAutoScroll] = useState(true);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const isStreamingRef = useRef(false);

  const MAX_MESSAGES = 25;
  const visibleMessages = messages.slice(-MAX_MESSAGES);

  // 🔑 API KEY
  const apiKey = settings?.apiKey?.trim();
  const hasApiKey = !!apiKey && apiKey.length > 10;

  // 🧠 CONTEXT
  const transcriptText = useMemo(() => {
    const recentChunks = safeChunks.slice(
      -(settings.chatContext || 5)
    );
    return recentChunks.map((t) => t.text).join("\n");
  }, [safeChunks, settings.chatContext]);

  // 🔥 FIXED AUTO-SCROLL (NO PAGE JUMP)
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    if (autoScroll) {
      el.scrollTop = el.scrollHeight;
    }
  }, [visibleMessages, loading, autoScroll]);

  // 👀 Detect manual scroll
  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;

    const nearBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight < 60;

    setAutoScroll(nearBottom);
  };

  const handleSend = async () => {
    if (!input.trim() || loading || isStreamingRef.current) return;

    if (!hasApiKey) {
      alert("Please enter a valid Groq API key in Settings");
      return;
    }

    const userMessage: Message = {
      role: "user",
      content: input.trim(),
      timestamp: Date.now(),
    };

    const updatedMessages: Message[] = [...messages, userMessage];
    setMessages(updatedMessages);

    setInput("");
    setLoading(true);
    isStreamingRef.current = true;

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messages: updatedMessages.slice(-20),
          apiKey,
          transcript: transcriptText,
          customPrompt: settings.chatPrompt,
          contextWindow: settings.chatContext,
        }),
      });

      if (!res.ok) {
        let errorMessage = "Failed to generate response.";

        try {
          const text = await res.text();
          const parsed = JSON.parse(text);
          errorMessage =
            parsed?.message || parsed?.error || text;
        } catch {}

        setMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            content: "⚠️ " + errorMessage,
            timestamp: Date.now(),
          },
        ]);

        return;
      }

      if (!res.body) throw new Error("No response body");

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

        const chunkText = decoder.decode(value);
        if (!chunkText) continue;

        finalText += chunkText;

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
          updated[updated.length - 1].content =
            "Not enough context to generate a useful response.";
          return updated;
        });
      }
    } catch (err: any) {
      console.error("🔥 CHAT ERROR:", err);

      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content:
            "⚠️ " +
            (err?.message ||
              "Network error while generating response."),
          timestamp: Date.now(),
        },
      ]);
    } finally {
      setLoading(false);
      isStreamingRef.current = false;
    }
  };

  const handleKeyDown = (
    e: React.KeyboardEvent<HTMLInputElement>
  ) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="border rounded-xl p-4 h-full flex flex-col min-h-0">

      {/* 🔥 FIXED HEADER */}
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

      {/* 💬 SCROLL ONLY THIS */}
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
              className={`max-w-[80%] p-3 rounded-lg text-sm ${
                msg.role === "user"
                  ? "bg-blue-600 ml-auto"
                  : "bg-gray-800 mr-auto"
              }`}
            >
              {msg.content}
            </div>
          ))
        )}

        {loading && (
          <div className="text-gray-400 text-sm">
            Thinking...
          </div>
        )}
      </div>

      {/* 🔥 FIXED INPUT */}
      <div className="flex gap-2 mt-1 flex-shrink-0">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Type a message..."
          disabled={loading}
          className="flex-1 px-3 py-2 rounded bg-gray-900 border border-gray-700 text-white text-sm disabled:opacity-50"
        />

        <button
          onClick={handleSend}
          disabled={loading || !input.trim()}
          className="bg-blue-600 px-4 py-2 rounded hover:bg-blue-500 disabled:opacity-50"
        >
          Send
        </button>
      </div>
    </div>
  );
}