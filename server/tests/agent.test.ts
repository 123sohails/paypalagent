import { afterEach, describe, expect, it, vi } from "vitest";
import { configuredLlmProvider, proposePurchase } from "../src/services/agent.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("OpenAI-compatible LLM configuration", () => {
  it("uses the configured compatible endpoint and model", async () => {
    vi.stubEnv("LLM_PROVIDER", "groq");
    vi.stubEnv("LLM_BASE_URL", "https://api.groq.example/openai/v1/");
    vi.stubEnv("LLM_API_KEY", "groq-test-key");
    vi.stubEnv("LLM_MODEL", "test-tool-model");
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("OPENAI_MODEL", "");
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({ choices: [{ message: { role: "assistant", content: "Ready" } }] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = configuredLlmProvider();
    expect(provider?.name).toBe("groq");
    const message = await provider!.complete([{ role: "user", content: "Find headphones" }]);
    expect(message.content).toBe("Ready");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.groq.example/openai/v1/chat/completions");
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer groq-test-key");
    expect(JSON.parse(String(init.body)).model).toBe("test-tool-model");
  });

  it("does not forward a legacy OpenAI secret to a custom endpoint", async () => {
    vi.stubEnv("LLM_PROVIDER", "local-compatible");
    vi.stubEnv("LLM_BASE_URL", "http://localhost:11434/v1");
    vi.stubEnv("LLM_API_KEY", "");
    vi.stubEnv("LLM_MODEL", "local-model");
    vi.stubEnv("OPENAI_API_KEY", "legacy-openai-secret");
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({ choices: [{ message: { role: "assistant", content: "Ready" } }] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = configuredLlmProvider();
    await provider!.complete([{ role: "user", content: "Find a lamp" }]);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(init.headers).has("Authorization")).toBe(false);
  });

  it("does not treat a hosted provider without its own key as configured", () => {
    vi.stubEnv("LLM_PROVIDER", "groq");
    vi.stubEnv("LLM_BASE_URL", "https://api.groq.example/openai/v1");
    vi.stubEnv("LLM_API_KEY", "");
    vi.stubEnv("LLM_MODEL", "tool-model");
    vi.stubEnv("OPENAI_API_KEY", "legacy-openai-secret");
    expect(configuredLlmProvider()).toBeNull();
  });

  it("continues to support the existing OpenAI environment variables", () => {
    vi.stubEnv("LLM_PROVIDER", "");
    vi.stubEnv("LLM_BASE_URL", "");
    vi.stubEnv("LLM_API_KEY", "");
    vi.stubEnv("LLM_MODEL", "");
    vi.stubEnv("OPENAI_API_KEY", "legacy-openai-secret");
    vi.stubEnv("OPENAI_MODEL", "legacy-model");
    expect(configuredLlmProvider()?.name).toBe("openai");
  });

  it("runs a tool call through catalog search before returning a recommendation", async () => {
    vi.stubEnv("LLM_PROVIDER", "test-provider");
    vi.stubEnv("LLM_BASE_URL", "https://llm.example/v1");
    vi.stubEnv("LLM_API_KEY", "test-key");
    vi.stubEnv("LLM_MODEL", "tool-model");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({
        choices: [{
          message: {
            role: "assistant",
            tool_calls: [{
              id: "call-search-1",
              type: "function",
              function: { name: "search_products", arguments: JSON.stringify({ query: "wireless headphones" }) },
            }],
          },
        }],
      }))
      .mockResolvedValueOnce(Response.json({
        choices: [{ message: { role: "assistant", content: "These headphones fit your travel request." } }],
      }));
    vi.stubGlobal("fetch", fetchMock);

    const proposal = await proposePurchase("Find wireless headphones for travel");
    expect(proposal.provider).toBe("test-provider");
    expect(proposal.product?.id).toBe("headphones-001");
    expect(proposal.explanation).toContain("fit your travel request");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondInit = fetchMock.mock.calls[1]?.[1] as RequestInit;
    const secondBody = JSON.parse(String(secondInit.body));
    expect(secondBody.messages.some((message: { role: string; tool_call_id?: string }) =>
      message.role === "tool" && message.tool_call_id === "call-search-1",
    )).toBe(true);
  });
});
