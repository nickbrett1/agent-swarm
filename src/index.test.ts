import { describe, it, expect, vi, beforeEach } from 'vitest';
import workerDefault, { ShopperAgent } from './index.js';

vi.mock('@cloudflare/puppeteer', () => ({
  default: {
    limits: vi.fn().mockResolvedValue({
      activeSessions: [],
      maxConcurrentSessions: 4,
      allowedBrowserAcquisitions: 1,
      timeUntilNextAllowedBrowserAcquisition: 0,
      usedBrowserTimeSeconds: 0,
      browserTimeSecondsLimit: 3600,
    }),
  },
}));

// Mock the agents module so that extending Agent doesn't try to invoke cloudflare native bindings
vi.mock('agents', () => ({
  Agent: class {
    state: any;
    env: any;
    constructor(ctx: any, env: any) {
      this.env = env;
      this.state = {};
    }
    setState(newState: any) {
      this.state = newState;
    }
  },
  routeAgentRequest: vi.fn(),
  callable: () => () => {},
}));

describe('ShopperAgent queryLLM Fallback Logic', () => {
  let mockFetch: any;

  beforeEach(() => {
    vi.restoreAllMocks();
    mockFetch = vi.fn();
    globalThis.fetch = mockFetch;

    // Silence console logs/warns/errors during tests unless debugging
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('should query Gemini API successfully when GOOGLE_API_KEY is present', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        candidates: [{
          content: { parts: [{ text: '{"action":"click","explanation":"Gemini test"}' }] }
        }]
      })
    });

    const env = { GOOGLE_API_KEY: 'test-key' };
    const agent = new (ShopperAgent as any)(null, env);

    const response = await agent.queryLLM('test prompt');

    expect(response.action).toBe('click');
    expect(response.explanation).toBe('Gemini test');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toContain('generativelanguage.googleapis.com');
  });

  it('should query Workers AI fallback correctly when Gemini API fails', async () => {
    mockFetch.mockRejectedValue(new Error('Network error'));

    const mockRun = vi.fn().mockResolvedValue({
      response: '{"action":"finish","explanation":"Workers AI fallback"}'
    });
    const env = {
      GOOGLE_API_KEY: 'test-key',
      AI: { run: mockRun }
    };
    const agent = new (ShopperAgent as any)(null, env);

    vi.useFakeTimers();
    const promise = agent.queryLLM('test prompt');

    // Fast-forward through the 3 retries (2 seconds each)
    await vi.advanceTimersByTimeAsync(8000);

    const response = await promise;
    vi.useRealTimers();

    expect(response.action).toBe('finish');
    expect(response.explanation).toBe('Workers AI fallback');
    // Gemini retries 3 times before failing
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(mockRun).toHaveBeenCalledTimes(1);
    expect(mockRun).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Object),
      { gateway: { id: 'default' } }
    );
  });

  it('should query Workers AI directly when no GOOGLE_API_KEY is present', async () => {
    const mockRun = vi.fn().mockResolvedValue({
      response: '{"action":"wait","explanation":"direct Workers AI"}'
    });
    const env = {
      AI: { run: mockRun }
    };
    const agent = new (ShopperAgent as any)(null, env);

    const response = await agent.queryLLM('test prompt');

    expect(response.action).toBe('wait');
    expect(response.explanation).toBe('direct Workers AI');
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockRun).toHaveBeenCalledTimes(1);
    expect(mockRun).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Object),
      { gateway: { id: 'default' } }
    );
  });

  it('should correctly strip markdown formatting from Workers AI response', async () => {
    const mockRun = vi.fn().mockResolvedValue({
      response: '```json\n{"action":"type","explanation":"markdown stripped"}\n```'
    });
    const env = {
      AI: { run: mockRun }
    };
    const agent = new (ShopperAgent as any)(null, env);

    const response = await agent.queryLLM('test prompt');

    expect(response.action).toBe('type');
    expect(response.explanation).toBe('markdown stripped');
  });

  it('should handle Workers AI parsing errors', async () => {
    const mockRun = vi.fn().mockResolvedValue({
      response: 'invalid json'
    });
    const env = {
      AI: { run: mockRun }
    };
    const agent = new (ShopperAgent as any)(null, env);

    await expect(agent.queryLLM('test prompt')).rejects.toThrow('LLM output parsing error');
  });

  it('should cascade errors if both Gemini API and Workers AI fail', async () => {
    mockFetch.mockRejectedValue(new Error('Gemini network error'));

    const mockRun = vi.fn().mockRejectedValue(new Error('Workers AI execution error'));
    const env = {
      GOOGLE_API_KEY: 'test-key',
      AI: { run: mockRun }
    };
    const agent = new (ShopperAgent as any)(null, env);

    vi.useFakeTimers();
    const promise = expect(agent.queryLLM('test prompt')).rejects.toThrow('Workers AI fallback failed: Workers AI execution error. (Gemini API also failed: Gemini network error)');
    await vi.advanceTimersByTimeAsync(8000);

    await promise;
    vi.useRealTimers();
  });

  it('should throw an error if neither LLM keys nor Workers AI binding are available', async () => {
    const env = {};
    const agent = new (ShopperAgent as any)(null, env);

    await expect(agent.queryLLM('test prompt')).rejects.toThrow('No LLM keys or Workers AI binding available');
  });

  it('should cascade error if Gemini fails and no AI binding is available', async () => {
    mockFetch.mockRejectedValue(new Error('Gemini network error'));

    const env = { GOOGLE_API_KEY: 'test-key' };
    const agent = new (ShopperAgent as any)(null, env);

    vi.useFakeTimers();
    const promise = expect(agent.queryLLM('test prompt')).rejects.toThrow('Gemini network error');
    await vi.advanceTimersByTimeAsync(8000);

    await promise;
    vi.useRealTimers();
  });
});

describe('Worker Default Export', () => {
  it('should return info on /info', async () => {
    const req = new Request('http://localhost/info');
    const env = {};
    const res = await workerDefault.fetch(req, env as any);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.name).toBe('agent-swarm');
    expect(data.agents.ShopperAgent).toBeDefined();
    expect(data.limits).toBeUndefined();
  });

  it('should return 204 on OPTIONS preflight', async () => {
    const req = new Request('http://localhost/info', { method: 'OPTIONS' });
    const env = {};
    const res = await workerDefault.fetch(req, env as any);
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });

  it('should return limits on /limits', async () => {
    const req = new Request('http://localhost/limits');
    const env = {
      AI: {},
      GOOGLE_API_KEY: 'test-api-key',
    };
    const res = await workerDefault.fetch(req, env as any);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.browser.configured).toBe(false);
    expect(data.primary_llm.configured).toBe(true);
    expect(data.secondary_llm.configured).toBe(true);
  });

  it('should query browser limits on /limits when MYBROWSER is present', async () => {
    const req = new Request('http://localhost/limits');
    const mockBrowserWorker = {};
    const env = {
      MYBROWSER: mockBrowserWorker,
    };
    
    // Dynamically mock/import to get mock limits
    const puppeteerMock = await import('@cloudflare/puppeteer').then(m => m.default);
    
    const res = await workerDefault.fetch(req, env as any);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.browser.configured).toBe(true);
    expect(data.browser.maxConcurrentSessions).toBe(4);
    expect(data.browser.usedBrowserTimeSeconds).toBe(0);
    expect(data.browser.browserTimeSecondsLimit).toBe(3600);
    expect(puppeteerMock.limits).toHaveBeenCalledWith(mockBrowserWorker);
  });

  it('should fallback to 600 for free tier when browserTimeSecondsLimit is undefined', async () => {
    const req = new Request('http://localhost/limits');
    const mockBrowserWorker = {};
    const env = {
      MYBROWSER: mockBrowserWorker,
    };

    const puppeteerMock = await import('@cloudflare/puppeteer').then(m => m.default);
    (puppeteerMock.limits as any).mockResolvedValueOnce({
      activeSessions: [],
      maxConcurrentSessions: 4,
      allowedBrowserAcquisitions: 1,
      timeUntilNextAllowedBrowserAcquisition: 0,
      usedBrowserTimeSeconds: 50,
      // browserTimeSecondsLimit is omitted
    });

    const res = await workerDefault.fetch(req, env as any);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.browser.configured).toBe(true);
    expect(data.browser.usedBrowserTimeSeconds).toBe(50);
    expect(data.browser.browserTimeSecondsLimit).toBe(600);
  });

  it('should fallback to unlimited for paid tier when browserTimeSecondsLimit is undefined', async () => {
    const req = new Request('http://localhost/limits');
    const mockBrowserWorker = {};
    const env = {
      MYBROWSER: mockBrowserWorker,
    };

    const puppeteerMock = await import('@cloudflare/puppeteer').then(m => m.default);
    (puppeteerMock.limits as any).mockResolvedValueOnce({
      activeSessions: [],
      maxConcurrentSessions: 120,
      allowedBrowserAcquisitions: 1,
      timeUntilNextAllowedBrowserAcquisition: 0,
      usedBrowserTimeSeconds: 50,
      // browserTimeSecondsLimit is omitted
    });

    const res = await workerDefault.fetch(req, env as any);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.browser.configured).toBe(true);
    expect(data.browser.usedBrowserTimeSeconds).toBe(50);
    expect(data.browser.browserTimeSecondsLimit).toBe('unlimited');
  });

  it('should use BROWSER_TIME_LIMIT_MOCK when defined in env', async () => {
    const req = new Request('http://localhost/limits');
    const mockBrowserWorker = {};
    const env = {
      MYBROWSER: mockBrowserWorker,
      BROWSER_TIME_LIMIT_MOCK: 600,
    };

    const res = await workerDefault.fetch(req, env as any);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.browser.configured).toBe(true);
    expect(data.browser.browserTimeSecondsLimit).toBe(600);
  });
});
