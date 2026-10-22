import { z } from "zod";
import { searchCatalog, type Product } from "../domain/catalog.js";

const toolArguments = z.object({ query: z.string().min(1).max(300) });

type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
};

type LlmConfig = {
  provider: string;
  baseUrl: string;
  apiKey: string | undefined;
  model: string;
};

export interface LlmProvider {
  readonly name: string;
  complete(messages: ChatMessage[], tools?: unknown[]): Promise<ChatMessage>;
}

function getLlmConfig(): LlmConfig | null {
  const baseUrl = process.env.LLM_BASE_URL?.trim()
    || (process.env.OPENAI_API_KEY ? "https://api.openai.com/v1" : "");
  if (!baseUrl) return null;
  const legacyOpenAi = !process.env.LLM_BASE_URL?.trim();
  const apiKey = legacyOpenAi
    ? process.env.OPENAI_API_KEY || undefined
    : process.env.LLM_API_KEY || undefined;
  const localEndpoint = ["localhost", "127.0.0.1", "::1"].includes(new URL(baseUrl).hostname);
  if (!apiKey && !localEndpoint) return null;
  return {
    provider: process.env.LLM_PROVIDER?.trim()
      || (legacyOpenAi ? "openai" : "custom"),
    baseUrl: baseUrl.replace(/\/+$/, ""),
    apiKey,
    model: process.env.LLM_MODEL
      || process.env.OPENAI_MODEL
      || (legacyOpenAi ? "gpt-4o-mini" : ""),
  };
}

export class OpenAiCompatibleProvider implements LlmProvider {
  readonly name: string;

  constructor(private readonly config: LlmConfig) {
    if (!config.model) throw new Error("LLM_MODEL is required when using LLM_BASE_URL");
    this.name = config.provider;
  }

  async complete(messages: ChatMessage[], tools?: unknown[]): Promise<ChatMessage> {
    const endpoint = this.config.baseUrl.endsWith("/chat/completions")
      ? this.config.baseUrl
      : `${this.config.baseUrl}/chat/completions`;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: this.config.model,
        messages,
        ...(tools ? { tools, tool_choice: "auto" } : {}),
      }),
    });
    if (!response.ok) {
      throw new Error(`${this.name} returned HTTP ${response.status}: ${await response.text()}`);
    }
    const data = (await response.json()) as {
      choices?: Array<{ message?: ChatMessage }>;
    };
    const message = data.choices?.[0]?.message;
    if (!message) throw new Error(`${this.name} returned no assistant message`);
    return message;
  }
}

export function configuredLlmProvider(): LlmProvider | null {
  const config = getLlmConfig();
  return config ? new OpenAiCompatibleProvider(config) : null;
}

export type Proposal = {
  product: Product | null;
  alternatives: Product[];
  explanation: string;
  provider: string;
};

export async function proposePurchase(prompt: string): Promise<Proposal> {
  const llm = configuredLlmProvider();
  if (!llm) {
    const matches = searchCatalog(prompt);
    return {
      product: matches[0] ?? null,
      alternatives: matches.slice(1),
      explanation: matches.length
        ? "Matched your request against the demo catalog. Review the exact item before approving."
        : "No catalog item matched. Try headphones, coffee, lamp, or backpack.",
      provider: "local-catalog",
    };
  }

  const tools = [{
    type: "function",
    function: {
      name: "search_products",
      description: "Search the AgentGuard demo product catalog for items matching the user's request.",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "Short product search query" } },
        required: ["query"],
        additionalProperties: false,
      },
    },
  }];
  const firstMessage = await llm.complete([
    {
      role: "system",
      content: "Help the user shop this small catalog. Use search_products before recommending anything. Never approve, authorize, or purchase an item. The user must explicitly approve the exact item in the application.",
    },
    { role: "user", content: prompt },
  ], tools);
  const toolCall = firstMessage.tool_calls?.find((call) => call.function.name === "search_products");
  if (!toolCall) {
    return {
      product: null,
      alternatives: [],
      explanation: firstMessage.content ?? "The agent did not request a catalog search.",
      provider: llm.name,
    };
  }

  let args: z.infer<typeof toolArguments>;
  try {
    args = toolArguments.parse(JSON.parse(toolCall.function.arguments));
  } catch {
    throw new Error("AI provider returned invalid search_products arguments");
  }
  const matches = searchCatalog(args.query);
  const secondMessage = await llm.complete([
    {
      role: "system",
      content: "Recommend only products present in the tool result. You cannot approve or buy anything; the user must approve the exact transaction.",
    },
    { role: "user", content: prompt },
    { role: "assistant", tool_calls: [toolCall] },
    {
      role: "tool",
      tool_call_id: toolCall.id,
      content: JSON.stringify(matches.map(({ id, name, merchantName, amountMinor, currency }) => ({
        id, name, merchantName, amountMinor, currency,
      }))),
    },
  ]);
  return {
    product: matches[0] ?? null,
    alternatives: matches.slice(1),
    explanation: secondMessage.content ?? "Here are the closest catalog matches.",
    provider: llm.name,
  };
}
