import { useEffect, useState } from "react";
import { DEFAULT_SETTINGS } from "@/lib/defaultSettings";

export function useSettings() {
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);

  useEffect(() => {
    const stored = localStorage.getItem("app_settings");
    if (stored) {
      setSettings(JSON.parse(stored));
    }
  }, []);

  const updateSettings = (newSettings: any) => {
    setSettings(newSettings);
    localStorage.setItem("app_settings", JSON.stringify(newSettings));
  };

  return { settings, updateSettings };
}