"use client";

import { useState, useEffect } from "react";

interface Settings {
  apiKey: string;
  suggestionPrompt: string;
  expandPrompt: string;
  chatPrompt: string;
  suggestionContext: number;
  chatContext: number;
}

interface Props {
  settings: Settings;
  setSettings: React.Dispatch<React.SetStateAction<Settings>>;
}

export default function SettingsPanel({
  settings,
  setSettings,
}: Props) {
  const [localSettings, setLocalSettings] =
    useState<Settings>(settings);

  // 🔥 NEW: API KEY STATUS
  const [status, setStatus] = useState<
    "idle" | "checking" | "valid" | "invalid"
  >("idle");

  // 🔄 Sync with parent
  useEffect(() => {
    setLocalSettings(settings);
  }, [settings]);

  const handleChange = (
    field: keyof Settings,
    value: string | number
  ) => {
    setLocalSettings((prev) => ({
      ...prev,
      [field]: value,
    }));
  };

  // 🔑 API KEY (instant apply)
  const handleApiKeyChange = (value: string) => {
    const updated = {
      ...localSettings,
      apiKey: value,
    };

    setLocalSettings(updated);
    setSettings(updated);

    localStorage.setItem(
      "app_settings",
      JSON.stringify(updated)
    );
  };

  // 🔥 NEW: VALIDATE API KEY (debounced)
  useEffect(() => {
    const key = localSettings.apiKey?.trim();

    if (!key) {
      setStatus("idle");
      return;
    }

    const timeout = setTimeout(async () => {
      setStatus("checking");

      try {
        const res = await fetch("/api/validate-key", {
          method: "POST",
          body: JSON.stringify({ apiKey: key }),
        });

        const data = await res.json();

        setStatus(data.valid ? "valid" : "invalid");
      } catch {
        setStatus("invalid");
      }
    }, 500); // debounce

    return () => clearTimeout(timeout);
  }, [localSettings.apiKey]);

  // 💾 Save rest
  const handleSave = () => {
    setSettings(localSettings);

    localStorage.setItem(
      "app_settings",
      JSON.stringify(localSettings)
    );

    alert("Settings saved ✅");
  };

  return (
    <div className="border rounded-xl h-full flex flex-col min-h-0">

      {/* HEADER */}
      <div className="flex-shrink-0 p-4 pb-2 border-b border-gray-700">
        <h2 className="font-semibold text-lg">Settings</h2>
      </div>

      {/* SCROLLABLE CONTENT */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4 min-h-0">

        {/* 🔑 API KEY + INDICATOR */}
        <div>
          <div className="flex justify-between items-center">
            <label className="text-sm text-gray-300">
              Groq API Key
            </label>

            {/* STATUS */}
            <div className="flex items-center gap-2 text-xs">
              <span
                className={`w-2.5 h-2.5 rounded-full ${
                  status === "valid"
                    ? "bg-green-500"
                    : status === "invalid"
                    ? "bg-red-500"
                    : status === "checking"
                    ? "bg-yellow-400 animate-pulse"
                    : "bg-gray-500"
                }`}
              />

              <span className="text-gray-400">
                {status === "valid" && "Valid"}
                {status === "invalid" && "Invalid"}
                {status === "checking" && "Checking..."}
                {status === "idle" && "Not set"}
              </span>
            </div>
          </div>

          <input
            type="password"
            value={localSettings.apiKey}
            onChange={(e) =>
              handleApiKeyChange(e.target.value)
            }
            placeholder="Paste your Groq API key"
            className="w-full mt-1 px-3 py-2 rounded bg-gray-900 border border-gray-700 text-sm"
          />
        </div>

        {/* Suggestion Prompt */}
        <div>
          <label className="text-sm text-gray-300">
            Suggestion Prompt
          </label>
          <textarea
            value={localSettings.suggestionPrompt}
            onChange={(e) =>
              handleChange("suggestionPrompt", e.target.value)
            }
            rows={4}
            className="w-full mt-1 px-3 py-2 rounded bg-gray-900 border border-gray-700 text-sm"
          />
        </div>

        {/* Expand Prompt */}
        <div>
          <label className="text-sm text-gray-300">
            Expand Prompt
          </label>
          <textarea
            value={localSettings.expandPrompt}
            onChange={(e) =>
              handleChange("expandPrompt", e.target.value)
            }
            rows={4}
            className="w-full mt-1 px-3 py-2 rounded bg-gray-900 border border-gray-700 text-sm"
          />
        </div>

        {/* Chat Prompt */}
        <div>
          <label className="text-sm text-gray-300">
            Chat Prompt
          </label>
          <textarea
            value={localSettings.chatPrompt}
            onChange={(e) =>
              handleChange("chatPrompt", e.target.value)
            }
            rows={4}
            className="w-full mt-1 px-3 py-2 rounded bg-gray-900 border border-gray-700 text-sm"
          />
        </div>

        {/* Context */}
        <div className="flex gap-3">
          <div className="flex-1">
            <label className="text-sm text-gray-300">
              Suggestion Context
            </label>
            <input
              type="number"
              value={localSettings.suggestionContext}
              onChange={(e) =>
                handleChange(
                  "suggestionContext",
                  Number(e.target.value)
                )
              }
              className="w-full mt-1 px-3 py-2 rounded bg-gray-900 border border-gray-700 text-sm"
            />
          </div>

          <div className="flex-1">
            <label className="text-sm text-gray-300">
              Chat Context
            </label>
            <input
              type="number"
              value={localSettings.chatContext}
              onChange={(e) =>
                handleChange(
                  "chatContext",
                  Number(e.target.value)
                )
              }
              className="w-full mt-1 px-3 py-2 rounded bg-gray-900 border border-gray-700 text-sm"
            />
          </div>
        </div>

      </div>

      {/* FOOTER */}
      <div className="flex-shrink-0 p-4 pt-2 border-t border-gray-700">
        <button
          onClick={handleSave}
          className="w-full bg-blue-600 py-2 rounded hover:bg-blue-500"
        >
          Save Settings
        </button>
      </div>
    </div>
  );
}