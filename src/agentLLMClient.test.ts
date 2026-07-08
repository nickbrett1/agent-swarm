import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AgentLLMClient } from './agentLLMClient.js';
import type { Ai } from "@cloudflare/workers-types";

describe('AgentLLMClient', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const mockOptions = {
    options: {
      messages: [{ role: 'user', content: 'hello' } as const]
    }
  };

  it('should explicitly fallback to Workers AI if callGeminiAPI throws an error', async () => {
    const mockRun = vi.fn().mockResolvedValueOnce({ response: 'workers ai direct response' });
    const mockBinding = { run: mockRun } as unknown as Ai;
    const client = new AgentLLMClient({ apiKey: 'test-api-key', binding: mockBinding });

    vi.spyOn(client as any, 'callGeminiAPI').mockRejectedValueOnce(new Error('Gemini simulated error'));

    const result = await client.createChatCompletion({
      logger: vi.fn(),
      options: { messages: [{ role: 'user', content: 'hello' }] }
    } as any);

    expect(result).toEqual({ data: 'workers ai direct response' });
    expect(mockRun).toHaveBeenCalled();
  });
  it('should fallback to Workers AI if Gemini API call fails and binding is available', async () => {
    (globalThis.fetch as any).mockRejectedValueOnce(new Error('Network error'));

    const mockRun = vi.fn().mockResolvedValueOnce({ response: 'workers ai response' });
    const mockBinding = { run: mockRun } as unknown as Ai;
    const mockLogger = vi.fn();

    const client = new AgentLLMClient({
      apiKey: 'test-api-key',
      binding: mockBinding,
      logger: mockLogger
    });

    const result = await client.createChatCompletion({ logger: vi.fn(), ...mockOptions } as any);

    expect(result).toEqual({ data: 'workers ai response' });
    expect(mockLogger).toHaveBeenCalledWith(
      expect.objectContaining({
        category: 'gemini',
        message: expect.stringContaining('Gemini API call failed: Network error. Falling back to Workers AI if available...')
      })
    );
    expect(mockRun).toHaveBeenCalled();
  });

  it('should throw error if Gemini API call fails and no binding is available', async () => {
    const error = new Error('Network error');
    (globalThis.fetch as any).mockRejectedValueOnce(error);

    const mockLogger = vi.fn();

    const client = new AgentLLMClient({
      apiKey: 'test-api-key',
      logger: mockLogger
    });

    await expect(client.createChatCompletion({ logger: vi.fn(), ...mockOptions } as any)).rejects.toThrow('Network error');

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

    await expect(client.createChatCompletion({ logger: vi.fn(), ...mockOptions } as any)).rejects.toThrow('Gemini API returned status 500: Internal Server Error');
  });

  it('should throw error if Gemini API returns empty response and no binding is available', async () => {
    (globalThis.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValueOnce({})
    });

    const client = new AgentLLMClient({
      apiKey: 'test-api-key'
    });

    await expect(client.createChatCompletion({ logger: vi.fn(), ...mockOptions } as any)).rejects.toThrow('Empty response from Gemini API');
  });

  it('should format error message if geminiErr is a string', async () => {
    (globalThis.fetch as any).mockRejectedValueOnce('String error message');

    const mockRun = vi.fn().mockResolvedValueOnce({ response: 'workers ai response' });
    const mockBinding = { run: mockRun } as unknown as Ai;
    const mockLogger = vi.fn();

    const client = new AgentLLMClient({
      apiKey: 'test-api-key',
      binding: mockBinding,
      logger: mockLogger
    });

    const result = await client.createChatCompletion({ logger: vi.fn(), ...mockOptions } as any);

    expect(result).toEqual({ data: 'workers ai response' });
    expect(mockLogger).toHaveBeenCalledWith(
      expect.objectContaining({
        category: 'gemini',
        message: 'Gemini API call failed: String error message. Falling back to Workers AI if available...'
      })
    );
  });

  it('should successfully return data from Gemini API', async () => {
    (globalThis.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValueOnce({
        candidates: [{
          content: {
            parts: [{ text: 'gemini success response' }]
          }
        }]
      })
    });

    const mockLogger = vi.fn();
    const client = new AgentLLMClient({
      apiKey: 'test-api-key',
      logger: mockLogger
    });

    const result = await client.createChatCompletion({ logger: vi.fn(), ...mockOptions } as any);

    expect(result).toEqual({ data: 'gemini success response' });
    expect(mockLogger).toHaveBeenCalledWith({
      category: 'gemini',
      message: 'Gemini finished thinking!'
    });
  });

  it('should call Workers AI directly if no API key is provided', async () => {
    const mockRun = vi.fn().mockResolvedValueOnce({ response: 'workers ai direct response' });
    const mockBinding = { run: mockRun } as unknown as Ai;

    const client = new AgentLLMClient({
      binding: mockBinding
    });

    const result = await client.createChatCompletion({ logger: vi.fn(), ...mockOptions } as any);

    expect(result).toEqual({ data: 'workers ai direct response' });
    expect(mockRun).toHaveBeenCalled();
  });

  it('should throw error if no API key and no binding are available', async () => {
    const client = new AgentLLMClient({});

    await expect(client.createChatCompletion({ logger: vi.fn(), ...mockOptions } as any)).rejects.toThrow('No API key or Workers AI binding available for LLMClient');
  });

  it('should handle complex message content (objects) in Gemini and Workers AI', async () => {
    (globalThis.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValueOnce({
        candidates: [{
          content: { parts: [{ text: 'response' }] }
        }]
      })
    });

    const client = new AgentLLMClient({ apiKey: 'test-api-key' });
    const complexOptions = {
      options: {
        messages: [
          { role: 'system', content: { some: 'system config' } },
          { role: 'user', content: { some: 'user object' } },
          { role: 'assistant', content: { some: 'assistant object' } }
        ] as any,
      }
    };

    await client.createChatCompletion({ logger: vi.fn(), ...complexOptions } as any);

    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        body: expect.stringContaining('{\\\"some\\\":\\\"system config\\\"}')
      })
    );
  });

  it('should handle complex message content (objects) in Workers AI directly', async () => {
    const mockRun = vi.fn().mockResolvedValueOnce({ response: 'workers ai direct response' });
    const mockBinding = { run: mockRun } as unknown as Ai;

    const client = new AgentLLMClient({ binding: mockBinding });
    const complexOptions = {
      options: {
        messages: [
          { role: 'user', content: { some: 'user object' } }
        ] as any,
      }
    };

    await client.createChatCompletion({ logger: vi.fn(), ...complexOptions } as any);

    expect(mockRun).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        messages: [{ role: 'user', content: '{"some":"user object"}' }]
      })
    );
  });

  it('should fallback to Workers AI if Gemini key missing', async () => {
    const mockAi = {
      run: vi.fn().mockResolvedValue({
        response: '{"action": "test", "explanation": "test"}'
      })
    } as unknown as Ai;

    const client = new AgentLLMClient({ binding: mockAi });

    const result = await client.createChatCompletion({ logger: vi.fn(),
      options: {
        messages: [{ role: 'user', content: 'hello' }]
      }
    });

    expect(mockAi.run).toHaveBeenCalled();
    expect((result as any).data).toBe('{"action": "test", "explanation": "test"}');
  });

  it('should fallback to Workers AI and parse json block if missing schema', async () => {
    const mockAi = {
      run: vi.fn().mockResolvedValue({
        response: "```json\n{\"action\": \"test\", \"explanation\": \"test\"}\n```"
      })
    } as unknown as Ai;

    const client = new AgentLLMClient({ binding: mockAi });

    const result = await client.createChatCompletion({ logger: vi.fn(),
      options: {
        messages: [{ role: 'user', content: 'hello' }]
      }
    });

    expect(mockAi.run).toHaveBeenCalled();
    expect((result as any).data).toBe("```json\n{\"action\": \"test\", \"explanation\": \"test\"}\n```");
  });

  it('should throw if no providers available', async () => {
    const client = new AgentLLMClient({});
    await expect(client.createChatCompletion({ logger: vi.fn(),
      options: {  messages: [] }
    })).rejects.toThrow("No API key or Workers AI binding available for LLMClient");
  });

  it('should use Gemini API if available', async () => {
    const client = new AgentLLMClient({ apiKey: 'test-gemini-key' });

    (globalThis.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        candidates: [{
          content: {
            parts: [{ text: '{"action": "gemini", "explanation": "test"}' }]
          }
        }]
      })
    });

    const result = await client.createChatCompletion({ logger: vi.fn(),
      options: {
        messages: [
            { role: 'system', content: 'sys' },
            { role: 'user', content: 'hello' },
            { role: 'assistant', content: 'hi' }
        ]
      }
    } as any);

    expect(globalThis.fetch).toHaveBeenCalled();
    const url = (globalThis.fetch as any).mock.calls[0][0];
    expect(url).toContain('gemini');
    expect((result as any).data).toContain('{"action": "gemini", "explanation": "test"}');
  });

  it('should handle failed Gemini response', async () => {
    const client = new AgentLLMClient({ apiKey: 'test-gemini-key' });

    (globalThis.fetch as any).mockResolvedValueOnce({
      ok: false,
      text: () => Promise.resolve("Bad Request")
    });

    await expect(client.createChatCompletion({ logger: vi.fn(),
      options: {  messages: [] }
    })).rejects.toThrow("Gemini API returned status undefined: Bad Request");
  });

  it('should handle empty Gemini response candidates', async () => {
    const client = new AgentLLMClient({ apiKey: 'test-gemini-key' });

    (globalThis.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ candidates: [] })
    });

    await expect(client.createChatCompletion({ logger: vi.fn(),
      options: {  messages: [] }
    })).rejects.toThrow("Empty response from Gemini API");
  });

  it('should fallback to Workers AI if Gemini fails and AI is present', async () => {
    const mockAi = {
      run: vi.fn().mockResolvedValue({
        response: '{"action": "fallback"}'
      })
    } as unknown as Ai;

    const client = new AgentLLMClient({ apiKey: 'test-gemini-key', binding: mockAi });

    (globalThis.fetch as any).mockResolvedValueOnce({
      ok: false,
      text: () => Promise.resolve("Bad Request")
    });

    const result = await client.createChatCompletion({ logger: vi.fn(),
      options: {  messages: [] }
    });

    expect(mockAi.run).toHaveBeenCalled();
    expect((result as any).data).toBe('{"action": "fallback"}');
  });
});
