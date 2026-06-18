import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentLLMClient } from './agentLLMClient.js';
import type { Ai } from "@cloudflare/workers-types";
import { z } from "zod";

describe('AgentLLMClient', () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  const mockOptions = {
    options: {
      messages: [{ role: 'user', content: 'hello' } as const]
    }
  };

  it('should fallback to Workers AI if Gemini API call fails and binding is available', async () => {
    // Simulate Gemini API failure
    (globalThis.fetch as any).mockRejectedValueOnce(new Error('Network error'));

    const mockRun = vi.fn().mockResolvedValueOnce({ response: 'workers ai response' });
    const mockBinding = { run: mockRun } as unknown as Ai;
    const mockLogger = vi.fn();

    const client = new AgentLLMClient({
      apiKey: 'test-api-key',
      binding: mockBinding,
      logger: mockLogger
    });

    const result = await client.createChatCompletion(mockOptions as any);

    expect(result).toEqual({ data: 'workers ai response' });
    expect(mockLogger).toHaveBeenCalledWith({
      category: 'gemini',
      message: 'Thinking using Gemini API...'
    });
    expect(mockLogger).toHaveBeenCalledWith(
      expect.objectContaining({
        category: 'gemini',
        message: expect.stringContaining('Gemini API call failed: Network error. Falling back to Workers AI if available...')
      })
    );
    expect(mockRun).toHaveBeenCalled();
  });

  it('should throw error if Gemini API call fails and no binding is available', async () => {
    // Simulate Gemini API failure
    const error = new Error('Network error');
    (globalThis.fetch as any).mockRejectedValueOnce(error);

    const mockLogger = vi.fn();

    const client = new AgentLLMClient({
      apiKey: 'test-api-key',
      logger: mockLogger
    });

    await expect(client.createChatCompletion(mockOptions as any)).rejects.toThrow('Network error');

    expect(mockLogger).toHaveBeenCalledWith(
      expect.objectContaining({
        category: 'gemini',
        message: expect.stringContaining('Gemini API call failed: Network error. Falling back to Workers AI if available...')
      })
    );
  });

  it('should throw error if Gemini API returns non-ok status and no binding is available', async () => {
    (globalThis.fetch as any).mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: vi.fn().mockResolvedValueOnce('Internal Server Error')
    });

    const client = new AgentLLMClient({
      apiKey: 'test-api-key'
    });

    await expect(client.createChatCompletion(mockOptions as any)).rejects.toThrow('Gemini API returned status 500: Internal Server Error');
  });

  it('should throw error if Gemini API returns empty response and no binding is available', async () => {
    (globalThis.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValueOnce({})
    });

    const client = new AgentLLMClient({
      apiKey: 'test-api-key'
    });

    await expect(client.createChatCompletion(mockOptions as any)).rejects.toThrow('Empty response from Gemini API');
  });

  it('should return successfully from Gemini API', async () => {
    (globalThis.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValueOnce({
        candidates: [
          {
            content: {
              parts: [{ text: 'gemini api response' }]
            }
          }
        ]
      })
    });

    const mockLogger = vi.fn();

    const client = new AgentLLMClient({
      apiKey: 'test-api-key',
      logger: mockLogger
    });

    const result = await client.createChatCompletion(mockOptions as any);

    expect(result).toEqual({ data: 'gemini api response' });
    expect(mockLogger).toHaveBeenCalledWith({
      category: 'gemini',
      message: 'Gemini finished thinking!'
    });
  });

  it('should format string system messages correctly for Gemini API', async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValueOnce({
        candidates: [{ content: { parts: [{ text: 'response' }] } }]
      })
    });
    globalThis.fetch = mockFetch as any;

    const client = new AgentLLMClient({
      apiKey: 'test-api-key'
    });

    await client.createChatCompletion({
      options: {
        messages: [
          { role: 'system', content: 'string system message' },
          { role: 'user', content: { foo: 'bar' } as any },
          { role: 'assistant', content: null as any }
        ]
      },
      logger: vi.fn()
    });

    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        body: expect.stringContaining('"systemInstruction":{"parts":[{"text":"string system message"}]}')
      })
    );
  });

  it('should handle non-string system messages correctly for Gemini API', async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValueOnce({
        candidates: [{ content: { parts: [{ text: 'response' }] } }]
      })
    });
    globalThis.fetch = mockFetch as any;

    const client = new AgentLLMClient({
      apiKey: 'test-api-key'
    });

    await client.createChatCompletion({
      options: {
        messages: [
          { role: 'system', content: { complex: 'system logic' } as any },
          { role: 'user', content: undefined as any }
        ]
      },
      logger: vi.fn()
    });

    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        body: expect.stringContaining('"systemInstruction":{"parts":[{"text":"{\\"complex\\":\\"system logic\\"}"}]}')
      })
    );
    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        body: expect.stringContaining('"parts":[{"text":""}]')
      })
    );
  });

  it('should handle non-Error objects thrown by Gemini fetch', async () => {
    (globalThis.fetch as any).mockRejectedValueOnce('string error');

    const mockRun = vi.fn().mockResolvedValueOnce({ response: 'fallback' });
    const mockBinding = { run: mockRun } as unknown as Ai;
    const mockLogger = vi.fn();

    const client = new AgentLLMClient({
      apiKey: 'test-api-key',
      binding: mockBinding,
      logger: mockLogger
    });

    await client.createChatCompletion(mockOptions as any);

    expect(mockLogger).toHaveBeenCalledWith(
      expect.objectContaining({
        category: 'gemini',
        message: expect.stringContaining('string error')
      })
    );
  });

  it('should format messages correctly for Gemini API including system message, schema, and non-string content', async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValueOnce({
        candidates: [{ content: { parts: [{ text: 'response' }] } }]
      })
    });
    globalThis.fetch = mockFetch as any;

    const client = new AgentLLMClient({
      apiKey: 'test-api-key'
    });

    const z = await import('zod').then(m => m.z);
    await client.createChatCompletion({
      options: {
        response_model: {
          name: 'test_model',
          schema: z.object({ test: z.string() }) as any
        },
        messages: [
          { role: 'system', content: 'system message' },
          { role: 'user', content: 'user message' },
          { role: 'assistant', content: { complex: 'object' } as any }
        ]
      },
      logger: vi.fn()
    });

    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        body: expect.stringContaining('"systemInstruction":{"parts":[{"text":"system message"}]}')
      })
    );
    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        body: expect.stringContaining('"role":"user","parts":[{"text":"user message"}]')
      })
    );
    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        body: expect.stringContaining('"role":"model","parts":[{"text":"{\\"complex\\":\\"object\\"}"}]')
      })
    );
    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        body: expect.stringContaining('"responseMimeType":"application/json"')
      })
    );
  });

  it('should throw error if neither API key nor binding is available', async () => {
    const client = new AgentLLMClient({});

    await expect(client.createChatCompletion(mockOptions as any)).rejects.toThrow('No API key or Workers AI binding available for LLMClient');
  });

  it('should use Workers AI directly if no API key is available but binding is present', async () => {
    const mockRun = vi.fn().mockResolvedValueOnce({ response: 'workers ai direct response' });
    const mockBinding = { run: mockRun } as unknown as Ai;
    const mockLogger = vi.fn();

    const client = new AgentLLMClient({
      binding: mockBinding,
      logger: mockLogger
    });

    const result = await client.createChatCompletion(mockOptions as any);

    expect(result).toEqual({ data: 'workers ai direct response' });
    expect(mockLogger).toHaveBeenCalledWith({
      category: 'workersai',
      message: 'Thinking using Workers AI Llama...'
    });
    expect(mockLogger).toHaveBeenCalledWith({
      category: 'workersai',
      message: 'Workers AI finished thinking!'
    });
    expect(mockRun).toHaveBeenCalled();
  });

  it('should format messages correctly for Workers AI including schema and non-string content', async () => {
    const mockRun = vi.fn().mockResolvedValueOnce({ response: 'workers ai response' });
    const mockBinding = { run: mockRun } as unknown as Ai;
    const mockLogger = vi.fn();

    const client = new AgentLLMClient({
      binding: mockBinding,
      logger: mockLogger
    });

    const z = await import('zod').then(m => m.z);
    const result = await client.createChatCompletion({
      options: {
        response_model: {
          name: 'test_model',
          schema: z.object({ test: z.string() }) as any
        },
        messages: [
          { role: 'user', content: 'user message' },
          { role: 'assistant', content: { complex: 'object' } as any }
        ]
      },
      logger: vi.fn()
    });

    expect(result).toEqual({ data: 'workers ai response' });
    expect(mockRun).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        messages: [
          { role: 'user', content: 'user message' },
          { role: 'assistant', content: '{"complex":"object"}' }
        ],
        response_format: expect.objectContaining({
          type: 'json_schema'
        }),
        temperature: 0
      })
    );
  });
});
