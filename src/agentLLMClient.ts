import {
  CreateChatCompletionOptions,
  LLMClient,
  LogLine,
} from "@browserbasehq/stagehand";
import zodToJsonSchema from "zod-to-json-schema";
import type { Ai } from "@cloudflare/workers-types";

const modelId = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

export class AgentLLMClient extends LLMClient {
  public type = "agent-llm" as any;
  private readonly binding?: Ai;
  private readonly apiKey?: string;
  private readonly logger?: (line: LogLine) => void;

  constructor(config: { binding?: Ai; apiKey?: string; logger?: (line: LogLine) => void }) {
    super(modelId);
    this.binding = config.binding;
    this.apiKey = config.apiKey;
    this.logger = config.logger;
  }

  private async callGeminiApi<T>(options: any, schema: any): Promise<T> {
    this.logger?.({ category: "gemini", message: "Thinking using Gemini API..." });
    
    const systemMessage = options.messages.find((m: any) => m.role === "system");
    const systemInstruction = systemMessage ? {
      parts: [{ text: typeof systemMessage.content === "string" ? systemMessage.content : JSON.stringify(systemMessage.content) }]
    } : undefined;

    const contents = options.messages
      .filter((m: any) => m.role !== "system")
      .map((m: any) => ({
        role: m.role === "assistant" ? "model" : m.role,
        parts: [{ text: typeof m.content === "string" ? m.content : JSON.stringify(m.content) || "" }]
      }));

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": this.apiKey!
      },
      body: JSON.stringify({
        systemInstruction,
        contents,
        generationConfig: {
          responseMimeType: schema ? "application/json" : undefined,
          responseSchema: schema ? zodToJsonSchema(schema) : undefined,
          temperature: 0,
        }
      })
    });

    if (!response.ok) {
      throw new Error(`Gemini API returned status ${response.status}: ${await response.text()}`);
    }

    const data: any = await response.json();
    const textResponse = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!textResponse) {
      throw new Error("Empty response from Gemini API");
    }

    this.logger?.({ category: "gemini", message: "Gemini finished thinking!" });
    return {
      data: textResponse,
    } as T;
  }

  private async callWorkersAi<T>(options: any, schema: any): Promise<T> {
    if (!this.binding) {
      throw new Error("No API key or Workers AI binding available for LLMClient");
    }

    this.logger?.({ category: "workersai", message: "Thinking using Workers AI Llama..." });
    
    const formattedMessages = options.messages.map((m: any) => ({
      role: m.role,
      content: typeof m.content === "string" ? m.content : JSON.stringify(m.content)
    }));

    const result = await this.binding.run(this.modelName as any, {
      messages: formattedMessages,
      response_format: schema ? {
        type: "json_schema",
        json_schema: zodToJsonSchema(schema as any),
      } : undefined,
      temperature: 0,
    }) as any;

    this.logger?.({ category: "workersai", message: "Workers AI finished thinking!" });
    return {
      data: result.response,
    } as T;
  }

  async createChatCompletion<T>({ options }: CreateChatCompletionOptions): Promise<T> {
    const schema = options.response_model?.schema;

    if (this.apiKey) {
      try {
        return await this.callGeminiApi<T>(options, schema);
      } catch (geminiErr) {
        this.logger?.({ category: "gemini", message: `Gemini API call failed: ${geminiErr instanceof Error ? geminiErr.message : String(geminiErr)}. Falling back to Workers AI if available...` });
        if (!this.binding) {
          throw geminiErr;
        }
      }
    }

    return this.callWorkersAi<T>(options, schema);
  }
}
