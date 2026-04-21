import Groq from "groq-sdk";

export const getGroqClient = (apiKey: string) => {
  return new Groq({
    apiKey,
  });
};