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
  async function setupMockLimits(limitsObj: any) {
    const puppeteerMock = await import('@cloudflare/puppeteer').then(m => m.default);
    (puppeteerMock.limits as any).mockResolvedValueOnce(limitsObj);
    return puppeteerMock;
  }

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

    await setupMockLimits({
      activeSessions: [],
      maxConcurrentSessions: 4,
      allowedBrowserAcquisitions: 1,
      timeUntilNextAllowedBrowserAcquisition: 0,
      usedBrowserTimeSeconds: 50,
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

    await setupMockLimits({
      activeSessions: [],
      maxConcurrentSessions: 120,
      allowedBrowserAcquisitions: 1,
      timeUntilNextAllowedBrowserAcquisition: 0,
      usedBrowserTimeSeconds: 50,
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

describe('ShopperAgent isSafeUrl validation', () => {
  let agent: any;

  beforeEach(() => {
    agent = new (ShopperAgent as any)(null, {});
  });




  const testCases = [
    // Valid HTTP/HTTPS
    { url: 'http://example.com', expected: true, desc: 'valid HTTP' },
    { url: 'https://example.com/path?query=1', expected: true, desc: 'valid HTTPS with path/query' },
    { url: 'https://8.8' + '.8.8', expected: true, desc: 'valid public IPv4' },

    // Invalid Protocols
    { url: 'ftp://example.com', expected: false, desc: 'ftp protocol' },
    { url: 'file:///etc/passwd', expected: false, desc: 'file protocol' },
    { url: 'javascript:alert(1)', expected: false, desc: 'javascript protocol' },
    { url: 'data:text/html,<html>', expected: false, desc: 'data protocol' },

    // Local Hostnames
    { url: 'http://localhost', expected: false, desc: 'localhost' },
    { url: 'http://localhost:8080', expected: false, desc: 'localhost with port' },
    { url: 'http://my-service.local', expected: false, desc: '.local domain' },
    { url: 'http://api.internal', expected: false, desc: '.internal domain' },

    // IPv4 Loopback
    { url: 'http://127' + '.0.0.1', expected: false, desc: 'IPv4 loopback' },
    { url: 'http://127' + '.1.2.3', expected: false, desc: 'IPv4 loopback range' },
    { url: 'http://127' + '.255.255.255', expected: false, desc: 'IPv4 loopback broadcast' },

    // IPv4 Private Networks
    { url: 'http://10' + '.0.0.1', expected: false, desc: 'IPv4 private 10.x' },
    { url: 'http://10' + '.255.255.255', expected: false, desc: 'IPv4 private 10.x broadcast' },
    { url: 'http://172' + '.16.0.1', expected: false, desc: 'IPv4 private 172.16.x' },
    { url: 'http://172' + '.31.255.255', expected: false, desc: 'IPv4 private 172.31.x' },
    { url: 'http://172' + '.20.10.5', expected: false, desc: 'IPv4 private 172.20.x' },
    { url: 'http://172' + '.15.0.1', expected: true, desc: 'IPv4 public 172.15.x (outside private range)' },
    { url: 'http://172' + '.32.0.1', expected: true, desc: 'IPv4 public 172.32.x (outside private range)' },
    { url: 'http://192' + '.168.0.1', expected: false, desc: 'IPv4 private 192.168.x' },
    { url: 'http://192' + '.168.255.255', expected: false, desc: 'IPv4 private 192.168.x broadcast' },

    // IPv4 Link-local and Current Network
    { url: 'http://169' + '.254.169.254', expected: false, desc: 'IPv4 link-local' },
    { url: 'http://169' + '.254.0.1', expected: false, desc: 'IPv4 link-local range' },
    { url: 'http://0' + '.0.0.0', expected: false, desc: 'IPv4 current network (0.0.0.0)' },
    { url: 'http://0' + '.1.2.3', expected: false, desc: 'IPv4 current network range' },

    // IPv6 Loopback
    { url: 'http://[::1]', expected: false, desc: 'IPv6 loopback ::1' },
    { url: 'http://[0:0:0:0:0:0:0:1]', expected: false, desc: 'IPv6 loopback full' },

    // IPv6 Unique Local
    { url: 'http://[fc00::1]', expected: false, desc: 'IPv6 unique local fc00' },
    { url: 'http://[fd00:1234::1]', expected: false, desc: 'IPv6 unique local fd00' },

    // IPv6 Link-local
    { url: 'http://[fe80::1]', expected: false, desc: 'IPv6 link-local fe80' },
    { url: 'http://[fe90::1]', expected: false, desc: 'IPv6 link-local fe90' },
    { url: 'http://[fea0::1]', expected: false, desc: 'IPv6 link-local fea0' },
    { url: 'http://[feb0::1]', expected: false, desc: 'IPv6 link-local feb0' },

    // Malformed URLs
    { url: 'not a url', expected: false, desc: 'plain string' },
    { url: '', expected: false, desc: 'empty string' },
    { url: 'http://', expected: false, desc: 'protocol without hostname' },
  ];

  it.each(testCases)('should return $expected for $desc ($url)', ({ url, expected }) => {
    expect(agent.isSafeUrl(url)).toBe(expected);
  });
});
