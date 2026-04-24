import Groq from "groq-sdk";

export const getGroqClient = (apiKey: string) => {
  // 🔒 sanitize
  const cleanedKey = apiKey?.trim();

  // 🔒 validate
  if (!cleanedKey || cleanedKey.length < 20) {
    throw new Error("Invalid API key");
  }

  return new Groq({
    apiKey: cleanedKey,
  });
};