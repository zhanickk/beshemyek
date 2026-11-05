import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

export const DEEPSEEK_DEFAULT_MODEL = "deepseek-v4-flash";

export function getDeepSeekModel(): string {
  return process.env.DEEPSEEK_MODEL ?? DEEPSEEK_DEFAULT_MODEL;
}

export function createDeepSeekProvider(apiKey: string) {
  return createOpenAICompatible({
    name: "deepseek",
    baseURL: "https://api.deepseek.com/v1",
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });
}
