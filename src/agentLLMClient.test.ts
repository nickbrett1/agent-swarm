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

  it('should return successful response from Gemini API', async () => {
    const mockLogger = vi.fn();
    (globalThis.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValueOnce({
        candidates: [{
          content: {
            parts: [{ text: 'gemini response' }]
          }
        }]
      })
    });

    const client = new AgentLLMClient({
      apiKey: 'test-api-key',
      logger: mockLogger
    });

    const result = await client.createChatCompletion(mockOptions as any);

    expect(result).toEqual({ data: 'gemini response' });
    expect(mockLogger).toHaveBeenCalledWith({
      category: 'gemini',
      message: 'Gemini finished thinking!'
    });
  });

  it('should throw error when neither apiKey nor binding is available', async () => {
    const client = new AgentLLMClient({});
    await expect(client.createChatCompletion(mockOptions as any)).rejects.toThrow('No API key or Workers AI binding available for LLMClient');
  });

  it('should call Workers AI directly if no apiKey is provided', async () => {
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

  it('should handle response_model and system message correctly for Gemini API', async () => {
    (globalThis.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValueOnce({
        candidates: [{
          content: {
            parts: [{ text: '{"result":"json"}' }]
          }
        }]
      })
    });

    const client = new AgentLLMClient({
      apiKey: 'test-api-key'
    });

    const complexOptions = {
      options: {
        messages: [
          { role: 'system', content: { instruction: 'system instructions' } },
          { role: 'system', content: 'system message test string' },
          { role: 'user', content: 'user message' },
          { role: 'assistant', content: 'assistant message' },
          { role: 'user', content: { msg: 'user message obj' } },
          { role: 'assistant', content: { msg: 'assistant message obj' } },
          { role: 'user', content: null as any },
          { role: 'user', content: undefined as any },
          { role: 'system', content: undefined as any },
          { role: 'system', content: null as any },
          { role: 'assistant', content: null as any },
          { role: 'assistant', content: undefined as any }
        ],
        response_model: {
          schema: z.object({ result: z.string() })
        }
      }
    };

    await client.createChatCompletion(complexOptions as any);

    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        body: expect.stringContaining('"responseSchema"')
      })
    );
  });

  it('should handle response_model correctly for Workers AI', async () => {
    const mockRun = vi.fn().mockResolvedValueOnce({ response: '{"result":"json"}' });
    const mockBinding = { run: mockRun } as unknown as Ai;

    const client = new AgentLLMClient({
      binding: mockBinding
    });

    const complexOptions = {
      options: {
        messages: [
          { role: 'user', content: { complex: 'message' } }
        ],
        response_model: {
          schema: z.object({ result: z.string() })
        }
      }
    };

    await client.createChatCompletion(complexOptions as any);

    expect(mockRun).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        response_format: expect.objectContaining({
          type: 'json_schema'
        })
      })
    );
  });

  it('should correctly handle non-Error throw from Gemini API fetch', async () => {
    (globalThis.fetch as any).mockRejectedValueOnce('String Error');
    const mockLogger = vi.fn();

    const client = new AgentLLMClient({
      apiKey: 'test-api-key',
      logger: mockLogger
    });

    await expect(client.createChatCompletion(mockOptions as any)).rejects.toEqual('String Error');
    expect(mockLogger).toHaveBeenCalledWith(
      expect.objectContaining({
        category: 'gemini',
        message: expect.stringContaining('Gemini API call failed: String Error. Falling back to Workers AI if available...')
      })
    );
  });
});
