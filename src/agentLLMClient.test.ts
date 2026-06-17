import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentLLMClient } from './agentLLMClient.js';
import type { Ai } from "@cloudflare/workers-types";

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
});
