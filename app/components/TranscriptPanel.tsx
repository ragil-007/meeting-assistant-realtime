"use client";

import { useEffect, useRef, useState } from "react";

type TranscriptChunk = {
  text: string;
  timestamp: number;
};

interface Props {
  transcriptChunks: TranscriptChunk[];
  setTranscriptChunks: React.Dispatch<
    React.SetStateAction<TranscriptChunk[]>
  >;

  isRecording: boolean;
  setIsRecording: React.Dispatch<React.SetStateAction<boolean>>;

  settings: {
    apiKey: string;
  };
}

export default function TranscriptPanel({
  transcriptChunks = [],
  setTranscriptChunks,
  isRecording,
  setIsRecording,
  settings,
}: Props) {
  const [liveText, setLiveText] = useState("");
  const [autoScroll, setAutoScroll] = useState(true);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const chunkIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const liveIntervalRef = useRef<NodeJS.Timeout | null>(null);

  const isRecordingRef = useRef(false);
  const isRestartingRef = useRef(false);

  const scrollRef = useRef<HTMLDivElement | null>(null);

  // 🔑 API KEY
  const apiKey = settings?.apiKey?.trim();
  const hasApiKey = !!apiKey && apiKey.length > 10;

  // 🔥 SMART AUTO-SCROLL
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    if (autoScroll) {
      el.scrollTop = el.scrollHeight;
    }
  }, [transcriptChunks, liveText, autoScroll]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;

    const nearBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight < 60;

    setAutoScroll(nearBottom);
  };

  // 🧠 Transcription
  const handleTranscription = async (blob: Blob) => {
    if (!hasApiKey || blob.size === 0) return;

    try {
      const file = new File([blob], "chunk.webm", {
        type: "audio/webm",
      });

      const formData = new FormData();
      formData.append("audio", file);
      formData.append("apiKey", apiKey);

      const res = await fetch("/api/transcribe", {
        method: "POST",
        body: formData,
      });

      if (!res.ok) return;

      const data = await res.json();

      if (data.text) {
        setTranscriptChunks((prev) => [
          ...prev,
          {
            text: data.text.trim(),
            timestamp: Date.now(),
          },
        ]);

        setLiveText("");
      }
    } catch (err) {
      console.error("Transcription error:", err);
    }
  };

  // 🎤 START RECORDER
  const startRecorder = async () => {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
    });

    streamRef.current = stream;

    const mediaRecorder = new MediaRecorder(stream);

    mediaRecorder.ondataavailable = async (e) => {
      if (e.data.size > 0) {
        await handleTranscription(e.data);
      }
    };

    mediaRecorder.onstop = () => {
      // 🔥 prevent duplicate restart loops
      if (isRecordingRef.current && !isRestartingRef.current) {
        isRestartingRef.current = true;

        setTimeout(() => {
          if (isRecordingRef.current) {
            mediaRecorder.start();
            mediaRecorderRef.current = mediaRecorder;
          }
          isRestartingRef.current = false;
        }, 50);
      }
    };

    mediaRecorder.start();
    mediaRecorderRef.current = mediaRecorder;
  };

  // 🎯 TOGGLE RECORDING
  const handleToggleRecording = async () => {
    if (!hasApiKey) {
      alert("Set API key first!");
      return;
    }

    if (!isRecording) {
      await startRecorder();

      isRecordingRef.current = true;
      setIsRecording(true);

      // 🔥 30s chunk cycle (STRICT)
      chunkIntervalRef.current = setInterval(() => {
        if (
          mediaRecorderRef.current &&
          mediaRecorderRef.current.state === "recording"
        ) {
          mediaRecorderRef.current.stop();
        }
      }, 30000);

      // ✨ live typing indicator
      liveIntervalRef.current = setInterval(() => {
        setLiveText((prev) =>
          prev.length > 20 ? "." : prev + "."
        );
      }, 1500);
    } else {
      isRecordingRef.current = false;
      setIsRecording(false);

      mediaRecorderRef.current?.stop();

      // 🔥 stop all mic tracks
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;

      if (chunkIntervalRef.current)
        clearInterval(chunkIntervalRef.current);
      if (liveIntervalRef.current)
        clearInterval(liveIntervalRef.current);

      chunkIntervalRef.current = null;
      liveIntervalRef.current = null;

      setLiveText("");
    }
  };

  // 🧹 Cleanup
  useEffect(() => {
    return () => {
      mediaRecorderRef.current?.stop();
      streamRef.current?.getTracks().forEach((t) => t.stop());

      if (chunkIntervalRef.current)
        clearInterval(chunkIntervalRef.current);
      if (liveIntervalRef.current)
        clearInterval(liveIntervalRef.current);
    };
  }, []);

  return (
    <div className="border rounded-xl p-4 h-full flex flex-col min-h-0">
      {/* HEADER (fixed) */}
      <div className="flex-shrink-0">
        <h2 className="font-semibold mb-2">Transcript</h2>

        <button
          onClick={handleToggleRecording}
          className={`px-3 py-2 rounded transition ${
            isRecording
              ? "bg-red-600 hover:bg-red-500"
              : "bg-blue-600 hover:bg-blue-500"
          }`}
        >
          {isRecording ? "Stop Recording" : "Start Mic"}
        </button>

        {isRecording && (
          <p className="text-green-400 text-xs mt-2">
            🎙 Listening...
          </p>
        )}
      </div>

      {/* SCROLL AREA */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto space-y-2 pr-1 mt-3 min-h-0"
      >
        {transcriptChunks.length === 0 ? (
          <p className="text-gray-500 text-sm">
            Speak to see transcript here...
          </p>
        ) : (
          transcriptChunks.map((chunk) => (
            <div key={chunk.timestamp} className="text-sm">
              {chunk.text}
            </div>
          ))
        )}

        {isRecording && liveText && (
          <div className="text-sm text-gray-400 italic">
            {liveText}
          </div>
        )}
      </div>
    </div>
  );
}