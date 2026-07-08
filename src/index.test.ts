import ipaddr from "ipaddr.js";
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock("cloudflare:workers", () => ({
  env: {
    MYBROWSER: {
      fetch: vi.fn(),
    },
  },
}));

import workerDefault, { ShopperAgent, verifyHmacSignature, handleInfo } from './index';

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

vi.mock('@cloudflare/playwright', () => ({
  endpointURLString: vi.fn().mockReturnValue('wss://dummy-cdp-url'),
}));

vi.mock('@browserbasehq/stagehand', () => ({
  Stagehand: vi.fn().mockImplementation(function() {
    return {
      init: vi.fn(),
      close: vi.fn(),
      page: {
        goto: vi.fn(),
        url: vi.fn().mockReturnValue('https://example.com'),
        evaluate: vi.fn(),
        locator: vi.fn(),
        frames: vi.fn().mockReturnValue([]),
        act: vi.fn(),
      }
    };
  }),
  LLMClient: class { init() { return Promise.resolve(); } },
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

describe('ShopperAgent isSafeUrl Logic', () => {
  let mockFetch: any;

  beforeEach(() => {
    vi.restoreAllMocks();
    mockFetch = vi.fn();
    globalThis.fetch = mockFetch;

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ Answer: [] })
    });
  });

  it('should allow a regular external domain', async () => {
    const env = {};
    const agent = new (ShopperAgent as any)(null, env);
    const isSafe = await agent.isSafeUrl('https://example.com/shop');
    expect(isSafe).toBe(true);
  });

  it('should block local ip addresses directly', async () => {
    const env = {};
    const agent = new (ShopperAgent as any)(null, env);
    expect(await agent.isSafeUrl('https://127.0.0.1/')).toBe(false);
    expect(await agent.isSafeUrl('https://10.0.0.1/')).toBe(false);
    expect(await agent.isSafeUrl('https://192.168.1.1/')).toBe(false);
    expect(await agent.isSafeUrl('https://169.254.169.254/')).toBe(false);
    expect(await agent.isSafeUrl('https://[::1]/')).toBe(false);
  });

  it('should block localhost and .local domains directly', async () => {
    const env = {};
    const agent = new (ShopperAgent as any)(null, env);
    expect(await agent.isSafeUrl('https://localhost:8080/')).toBe(false);
    expect(await agent.isSafeUrl('https://my-service.local/')).toBe(false);
    expect(await agent.isSafeUrl('https://internal-db.internal/')).toBe(false);
  });

  it('should block external domain that resolves to a private IP via DNS', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ Answer: [{ type: 1, data: '127.0.0.1' }] })
    });

    const env = {};
    const agent = new (ShopperAgent as any)(null, env);
    const isSafe = await agent.isSafeUrl('https://localtest.me/admin');
    expect(isSafe).toBe(false);
  });

  it('should allow external IP addresses directly', async () => {
    const env = {};
    const agent = new (ShopperAgent as any)(null, env);
    const isSafe = await agent.isSafeUrl('https://1.1.1.1/shop');
    expect(isSafe).toBe(true);
  });

  it('should gracefully handle and catch URL parsing errors', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const env = {};
    const agent = new (ShopperAgent as any)(null, env);
    const isSafe = await agent.isSafeUrl('not a valid url string');

    expect(isSafe).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(
      "Ignored URL parsing error in isSafeUrl:",
      expect.any(TypeError)
    );
    warnSpy.mockRestore();
  });
});

describe('ShopperAgent handleShoppingError logic', () => {
  let agent: ShopperAgent;
  let mockCtx: any;
  let mockEnv: any;
  let setStateSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockCtx = {};
    mockEnv = {};
    agent = new ShopperAgent(mockCtx, mockEnv);
    Object.defineProperty(agent, 'state', {
      value: {
        status: "running",
        progress: 50,
        history: [],
        error: undefined
      },
      writable: true
    });

    // Explicitly set the mock function
    agent.setState = vi.fn().mockImplementation((newState: any) => {
        Object.defineProperty(agent, 'state', { value: { ...agent.state, ...newState }, writable: true });
        return Promise.resolve();
    });
  });

  it('handles browser closed/disconnected error after pay/submit click', () => {
    Object.defineProperty(agent, 'state', { value: { ...agent.state, history: ["Action: click on pay button"] }, writable: true });
    const err = new Error("browser disconnected / closed");
    const result = (agent as any).handleShoppingError(err);

    expect(result).toContain("Status: completed");
    expect(result).toContain("Successfully completed purchase.");
    expect(agent.setState).toHaveBeenCalledWith(expect.objectContaining({
      status: "completed"
    }));
  });

  it('handles generic error by setting status to failed and throwing', () => {
    Object.defineProperty(agent, 'state', { value: { ...agent.state, history: ["Action: viewed item"] }, writable: true });
    const err = new Error("some generic error");

    expect(() => {
      (agent as any).handleShoppingError(err);
    }).toThrow("some generic error");

    expect(agent.setState).toHaveBeenCalledWith(expect.objectContaining({
      status: "failed",
      lastError: "some generic error"
    }));
  });
});

describe('ShopperAgent runShopping logic', () => {
  let agent: ShopperAgent;
  let mockCtx: any;
  let mockEnv: any;

  beforeEach(() => {
    mockCtx = {};
    mockEnv = {
        MYBROWSER: {},
        AI: {},
        GOOGLE_API_KEY: "dummy-key"
    };
    agent = new ShopperAgent(mockCtx, mockEnv);
    Object.defineProperty(agent, 'state', {
      value: {
        status: "running",
        progress: 50,
        history: [],
        error: undefined
      },
      writable: true
    });

    agent.setState = vi.fn().mockImplementation((newState: any) => {
        Object.defineProperty(agent, 'state', { value: { ...agent.state, ...newState }, writable: true });
        return Promise.resolve();
    });
  });

  it('handles successful shopping session', async () => {
    vi.spyOn(agent as any, 'initializeShoppingSession').mockResolvedValue("http://target");
    vi.spyOn(agent as any, 'executeShoppingLoop').mockResolvedValue("outcome summary");

    const { StagehandBrowserHelper } = await import("./browser.js");

    const initSpy = vi.spyOn(StagehandBrowserHelper.prototype, 'init').mockResolvedValue(undefined);
    const gotoSpy = vi.spyOn(StagehandBrowserHelper.prototype, 'goto').mockResolvedValue(undefined);
    const closeSpy = vi.spyOn(StagehandBrowserHelper.prototype, 'close').mockResolvedValue(undefined);

    const result = await (agent as any).runShopping("persona", "url");

    expect(result).toContain("Shopping Session Finished. Status: running. Summary: outcome summary");
    expect(initSpy).toHaveBeenCalled();
    expect(gotoSpy).toHaveBeenCalledWith("http://target");
    expect(closeSpy).toHaveBeenCalled();

    initSpy.mockRestore();
    gotoSpy.mockRestore();
    closeSpy.mockRestore();
  });

  it('handles failed shopping session', async () => {
    vi.spyOn(agent as any, 'initializeShoppingSession').mockResolvedValue("http://target");
    vi.spyOn(agent as any, 'executeShoppingLoop').mockRejectedValue(new Error("Shopping failed"));
    const errSpy = vi.spyOn(agent as any, 'handleShoppingError').mockReturnValue("Handled Error");

    const { StagehandBrowserHelper } = await import("./browser.js");

    const initSpy = vi.spyOn(StagehandBrowserHelper.prototype, 'init').mockResolvedValue(undefined);
    const gotoSpy = vi.spyOn(StagehandBrowserHelper.prototype, 'goto').mockResolvedValue(undefined);
    const closeSpy = vi.spyOn(StagehandBrowserHelper.prototype, 'close').mockResolvedValue(undefined);

    const result = await (agent as any).runShopping("persona", "url");

    expect(result).toContain("Handled Error");
    expect(closeSpy).toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledWith(expect.any(Error));

    initSpy.mockRestore();
    gotoSpy.mockRestore();
    closeSpy.mockRestore();
  });
});

describe('ShopperAgent waitForUrlChange logic', () => {
  let agent: ShopperAgent;
  let mockCtx: any;
  let mockEnv: any;

  beforeEach(() => {
    mockCtx = {};
    mockEnv = {};
    agent = new ShopperAgent(mockCtx, mockEnv);
  });

  it('settles quickly if url changes', async () => {
    const mockHelper = {
      wait: vi.fn().mockResolvedValue(undefined),
      getPageUrl: vi.fn()
        .mockResolvedValueOnce("http://start")
        .mockResolvedValueOnce("http://end")
    };

    await (agent as any).waitForUrlChange(mockHelper, "http://start");

    expect(mockHelper.wait).toHaveBeenCalledWith(500); // the loop wait
    expect(mockHelper.wait).toHaveBeenCalledWith(2500); // the settle wait
    expect(mockHelper.wait).not.toHaveBeenCalledWith(2000); // the cooldown wait
  });

  it('waits full loop and cooldown if url does not change', async () => {
    const mockHelper = {
      wait: vi.fn().mockResolvedValue(undefined),
      getPageUrl: vi.fn().mockResolvedValue("http://start")
    };

    const originalDateNow = Date.now;
    let time = 0;
    vi.spyOn(Date, "now").mockImplementation(() => {
      time += 2500; // Fast-forward time more than timeout (12000) over a few loops
      return time;
    });

    await (agent as any).waitForUrlChange(mockHelper, "http://start");

    expect(mockHelper.wait).toHaveBeenCalledWith(500); // inside the loop
    expect(mockHelper.wait).toHaveBeenCalledWith(2000); // the final cooldown wait

    Date.now = originalDateNow;
  });
});

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

describe('handleInfo logic', () => {
  it('should return a valid static JSON response payload', async () => {
    const request = new Request('https://localhost/info', {
      headers: { Origin: 'https://fintechnick.com' }
    });
    const response = handleInfo(request);

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/json');
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://fintechnick.com');

    const data = await response.json() as any;
    expect(data.name).toBe('agent-swarm');
    expect(data.description).toBe('Autonomous browser rendering swarm that runs stateful agent sessions.');
    expect(data.version).toBe('0.1.0');
    expect(data.agents.ShopperAgent.description).toBe('Launches a browser rendering session to browse, search, and purchase products in Stripe test-mode.');
    expect(data.agents.ShopperAgent.methods.runShopping.description).toBe('Triggers a browser automation sequence with the specified shopping persona.');
  });
});

describe('verifyHmacSignature', () => {
  const secret = 'test-secret';

  async function generateTestSignature(expiryStr: string, overrideSecret = secret) {
    const encoder = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      encoder.encode(overrideSecret),
      { name: 'PBKDF2' },
      false,
      ['deriveKey']
    );
    const key = await crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: encoder.encode('agent-swarm-salt'),
        iterations: 100000,
        hash: 'SHA-256'
      },
      keyMaterial,
      { name: 'HMAC', hash: 'SHA-256', length: 256 },
      false,
      ['sign']
    );
    const sigBuffer = await crypto.subtle.sign('HMAC', key, encoder.encode(expiryStr));
    return Array.from(new Uint8Array(sigBuffer))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }

  it('should return true for a valid signature and unexpired token', async () => {
    const expiry = (Date.now() + 100000).toString();
    const signature = await generateTestSignature(expiry);
    const result = await verifyHmacSignature(expiry, signature, secret);
    expect(result).toBe(true);
  });

  it('should return false if token is expired', async () => {
    const expiry = (Date.now() - 100000).toString();
    const signature = await generateTestSignature(expiry);
    const result = await verifyHmacSignature(expiry, signature, secret);
    expect(result).toBe(false);
  });

  it('should return false if expiry is not a valid number', async () => {
    const expiry = 'invalid-expiry';
    const signature = await generateTestSignature(expiry);
    const result = await verifyHmacSignature(expiry, signature, secret);
    expect(result).toBe(false);
  });

  it('should return false for missing expiry or signature', async () => {
    expect(await verifyHmacSignature(null, 'some-sig', secret)).toBe(false);
    expect(await verifyHmacSignature('12345', null, secret)).toBe(false);
    expect(await verifyHmacSignature(null, null, secret)).toBe(false);
  });

  it('should return false for invalid signature format', async () => {
    const expiry = (Date.now() + 100000).toString();
    expect(await verifyHmacSignature(expiry, 'invalid-hex-format', secret)).toBe(false);
  });

  it('should return false if signature does not match', async () => {
    const expiry = (Date.now() + 100000).toString();
    const validSignature = await generateTestSignature(expiry);
    // alter the signature
    const invalidSignature = 'ff' + validSignature.substring(2);
    expect(await verifyHmacSignature(expiry, invalidSignature, secret)).toBe(false);
  });

  it('should return false if signature verification throws an error', async () => {
    // A malformed signature hex length (e.g. odd number of characters)
    // will cause match(/.{1,2}/g) to potentially return an unexpected result,
    // but a non-hex string with even length will map to NaN when parseInt is called.
    // subtle.verify throws an error if the signature length is incorrect for SHA-256 HMAC (which is 32 bytes).
    const expiry = (Date.now() + 100000).toString();
    // A 4-byte signature hex (8 characters) instead of the expected 32-byte (64 characters)
    const shortSignature = 'deadbeef';
    expect(await verifyHmacSignature(expiry, shortSignature, secret)).toBe(false);
  });
});

async function setupMockLimits(limitsObj: any) {
  const puppeteerMock = await import('@cloudflare/puppeteer').then(m => m.default);
  (puppeteerMock.limits as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(limitsObj);
  return puppeteerMock;
}

async function testLimitsFetch(env: any, mockLimitsSetup?: () => Promise<any>) {
  const req = new Request('https://localhost/limits');
  if (mockLimitsSetup) {
    await mockLimitsSetup();
  }
  const res = await workerDefault.fetch(req, env);
  expect(res.status).toBe(200);
  return res.json() as any;
}

describe('Worker Default Export', () => {
  it('should return info on /info', async () => {
    const req = new Request('https://localhost/info');
    const env = {};
    const res = await workerDefault.fetch(req, env as any);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.name).toBe('agent-swarm');
    expect(data.agents.ShopperAgent).toBeDefined();
    expect(data.limits).toBeUndefined();
  });

  it('should return 204 on OPTIONS preflight with allowed origin', async () => {
    const req = new Request('https://localhost/info', {
      method: 'OPTIONS',
      headers: { 'Origin': 'https://fintechnick.com' }
    });
    const env = {};
    const res = await workerDefault.fetch(req, env as any);
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://fintechnick.com');
  });

  it('should return 204 on OPTIONS preflight with unallowed origin returning empty string', async () => {
    const req = new Request('https://localhost/info', {
      method: 'OPTIONS',
      headers: { 'Origin': 'https://evil.com' }
    });
    const env = {};
    const res = await workerDefault.fetch(req, env as any);
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('');
  });

  it('should return limits on /limits', async () => {
    const data = await testLimitsFetch({
      AI: {},
      GOOGLE_API_KEY: 'test-api-key',
    });
    expect(data.browser.configured).toBe(false);
    expect(data.primary_llm.configured).toBe(true);
    expect(data.secondary_llm.configured).toBe(true);
  });

  it('should query browser limits on /limits when MYBROWSER is present', async () => {
    const mockBrowserWorker = {};
    const env = {
      MYBROWSER: mockBrowserWorker,
    };
    
    // Dynamically mock/import to get mock limits
    const puppeteerMock = await import('@cloudflare/puppeteer').then(m => m.default);
    
    const data = await testLimitsFetch(env);
    expect(data.browser.configured).toBe(true);
    expect(data.browser.maxConcurrentSessions).toBe(4);
    expect(data.browser.usedBrowserTimeSeconds).toBe(0);
    expect(data.browser.browserTimeSecondsLimit).toBe(3600);
    expect(puppeteerMock.limits).toHaveBeenCalledWith(mockBrowserWorker);
  });

  it.each([
    { tier: 'free tier', sessions: 4, expectedLimit: 600 },
    { tier: 'paid tier', sessions: 120, expectedLimit: 'unlimited' }
  ])('should fallback to $expectedLimit for $tier when browserTimeSecondsLimit is undefined', async ({ sessions, expectedLimit }) => {
    const mockBrowserWorker = {};
    const env = {
      MYBROWSER: mockBrowserWorker,
    };

    const data = await testLimitsFetch(env, () => setupMockLimits({
      activeSessions: [],
      maxConcurrentSessions: sessions,
      allowedBrowserAcquisitions: 1,
      timeUntilNextAllowedBrowserAcquisition: 0,
      usedBrowserTimeSeconds: 50,
    }));

    expect(data.browser.configured).toBe(true);
    expect(data.browser.usedBrowserTimeSeconds).toBe(50);
    expect(data.browser.browserTimeSecondsLimit).toBe(expectedLimit);
  });

  it('should return timeUntilBrowserTimeReset when limits are exceeded', async () => {
    const mockBrowserWorker = {};
    const env = {
      MYBROWSER: mockBrowserWorker,
    };

    const data = await testLimitsFetch(env, () => setupMockLimits({
      activeSessions: [],
      maxConcurrentSessions: 4,
      allowedBrowserAcquisitions: 1,
      timeUntilNextAllowedBrowserAcquisition: 0,
      usedBrowserTimeSeconds: 650,
      browserTimeSecondsLimit: 600,
      timeUntilBrowserTimeReset: 300,
    }));

    expect(data.browser.configured).toBe(true);
    expect(data.browser.usedBrowserTimeSeconds).toBe(650);
    expect(data.browser.timeUntilBrowserTimeReset).toBe(300);
  });

  it('should use BROWSER_TIME_LIMIT_MOCK when defined in env', async () => {
    const mockBrowserWorker = {};
    const env = {
      MYBROWSER: mockBrowserWorker,
      BROWSER_TIME_LIMIT_MOCK: 600,
    };

    const data = await testLimitsFetch(env);
    expect(data.browser.configured).toBe(true);
    expect(data.browser.browserTimeSecondsLimit).toBe(600);
  });
});

describe('ShopperAgent isSafeUrl validation', () => {
  let agent: any;

  beforeEach(() => {
    agent = new (ShopperAgent as any)(null, {});
  });




  it('should handle IP parsing errors gracefully and return false in isPrivateIp (treating as non-private/safe if otherwise valid)', async () => {
    vi.spyOn(ipaddr, 'parse').mockImplementationOnce(() => {
      throw new Error('mock parse error');
    });
    // This will hit ipaddr.isValid(hostname) inside isSafeUrl (which returns true for 1.1.1.1),
    // then call isPrivateIp, which will throw, catch the error, and return false.
    // Since it returns false for "is it private?", isSafeUrl will return !false -> true.
    expect(await agent.isSafeUrl('https://1.1.1.1')).toBe(true);
  });

  const testCases = [
    // Valid HTTP/HTTPS
    { url: 'http' + '://example.com', expected: true, desc: 'valid HTTP' },
    { url: 'https://example.com/path?query=1', expected: true, desc: 'valid HTTPS with path/query' },
    { url: 'https://8.8' + '.8.8', expected: true, desc: 'valid public IPv4' },

    // Invalid Protocols
    { url: 'ftp://example.com', expected: false, desc: 'ftp protocol' },
    { url: 'file:///etc/passwd', expected: false, desc: 'file protocol' },
    { url: 'javascript:alert(1)', expected: false, desc: 'javascript protocol' },
    { url: 'data:text/html,<html>', expected: false, desc: 'data protocol' },

    // Local Hostnames
    { url: 'https://localhost', expected: false, desc: 'localhost' },
    { url: 'https://localhost:8080', expected: false, desc: 'localhost with port' },
    { url: 'https://my-service.local', expected: false, desc: '.local domain' },
    { url: 'https://api.internal', expected: false, desc: '.internal domain' },

    // IPv4 Loopback
    { url: 'https://127' + '.0.0.1', expected: false, desc: 'IPv4 loopback' },
    { url: 'https://127' + '.1.2.3', expected: false, desc: 'IPv4 loopback range' },
    { url: 'https://127' + '.255.255.255', expected: false, desc: 'IPv4 loopback broadcast' },

    // IPv4 Private Networks
    { url: 'https://10' + '.0.0.1', expected: false, desc: 'IPv4 private 10.x' },
    { url: 'https://10' + '.255.255.255', expected: false, desc: 'IPv4 private 10.x broadcast' },
    { url: 'https://172' + '.16.0.1', expected: false, desc: 'IPv4 private 172.16.x' },
    { url: 'https://172' + '.31.255.255', expected: false, desc: 'IPv4 private 172.31.x' },
    { url: 'https://172' + '.20.10.5', expected: false, desc: 'IPv4 private 172.20.x' },
    { url: 'https://172' + '.15.0.1', expected: true, desc: 'IPv4 public 172.15.x (outside private range)' },
    { url: 'https://172' + '.32.0.1', expected: true, desc: 'IPv4 public 172.32.x (outside private range)' },
    { url: 'https://192' + '.168.0.1', expected: false, desc: 'IPv4 private 192.168.x' },
    { url: 'https://192' + '.168.255.255', expected: false, desc: 'IPv4 private 192.168.x broadcast' },

    // IPv4 Link-local and Current Network
    { url: 'https://169' + '.254.169.254', expected: false, desc: 'IPv4 link-local' },
    { url: 'https://169' + '.254.0.1', expected: false, desc: 'IPv4 link-local range' },
    { url: 'https://0' + '.0.0.0', expected: false, desc: 'IPv4 current network (0.0.0.0)' },
    { url: 'https://0' + '.1.2.3', expected: false, desc: 'IPv4 current network range' },

    // IPv6 Loopback
    { url: 'https://[::1]', expected: false, desc: 'IPv6 loopback ::1' },
    { url: 'https://[0:0:0:0:0:0:0:1]', expected: false, desc: 'IPv6 loopback full' },

    // IPv6 Unique Local
    { url: 'https://[fc00::1]', expected: false, desc: 'IPv6 unique local fc00' },
    { url: 'https://[fd00:1234::1]', expected: false, desc: 'IPv6 unique local fd00' },

    // IPv6 Link-local
    { url: 'https://[fe80::1]', expected: false, desc: 'IPv6 link-local fe80' },
    { url: 'https://[fe90::1]', expected: false, desc: 'IPv6 link-local fe90' },
    { url: 'https://[fea0::1]', expected: false, desc: 'IPv6 link-local fea0' },
    { url: 'https://[feb0::1]', expected: false, desc: 'IPv6 link-local feb0' },

    // Malformed URLs
    { url: 'not a url', expected: false, desc: 'plain string' },
    { url: '', expected: false, desc: 'empty string' },
    { url: 'http' + '://', expected: false, desc: 'protocol without hostname' },
  ];

  it.each(testCases)('should return $expected for $desc ($url)', async ({ url, expected }) => {
    expect(await agent.isSafeUrl(url)).toBe(expected);
  });
});


describe("ShopperAgent - Full execution flow", () => {
    let agent: any;
    let helper: any;

    beforeEach(async () => {
        const { ShopperAgent } = await import("./index.js");
        agent = new ShopperAgent({} as any, {} as any);
        agent.env = { STRIPE_TEST_CARD: "123", STRIPE_TEST_EXPIRY: "12/34", STRIPE_TEST_CVC: "123", STRIPE_TEST_NAME: "Bob" } as any;
        (agent as any).state = { history: [], status: "running" };

        helper = {
            getPageUrl: vi.fn().mockResolvedValue("https://example.com"),
            getInteractiveElements: vi.fn().mockResolvedValue({ textSummary: "sum", elements: [{ id: "button_0", tag: "button", text: "Click me", type: "", placeholder: "", name: "", role: "", xpath: "//button" }, { id: "input_0", tag: "input", text: "text", type: "text", placeholder: "text", name: "", role: "", xpath: "//input" }] }),
            clickElement: vi.fn().mockResolvedValue(true),
            typeElement: vi.fn().mockResolvedValue(true),
            wait: vi.fn(),
            handleStripeIframe: vi.fn().mockResolvedValue(true)
        };
    });

    it("should process finish action correctly", async () => {
        (agent as any).buildLLMPrompt = vi.fn().mockReturnValue({ systemPrompt: "sys", userPrompt: "user" });
        (agent as any).queryLLM = vi.fn().mockResolvedValue({ action: "finish", explanation: "done" });
        await (agent as any).executeShoppingLoop(helper, "buyer");
        expect((agent as any).state.status).toBe("completed");
    });

    it("should process error action correctly", async () => {
        (agent as any).buildLLMPrompt = vi.fn().mockReturnValue({ systemPrompt: "sys", userPrompt: "user" });
        (agent as any).queryLLM = vi.fn().mockResolvedValue({ action: "error", explanation: "failed" });
        await expect((agent as any).executeShoppingLoop(helper, "buyer")).rejects.toThrow("Unsupported action: error");
    });

    it("should process click action correctly", async () => {
        (agent as any).buildLLMPrompt = vi.fn().mockReturnValue({ systemPrompt: "sys", userPrompt: "user" });
        (agent as any).queryLLM = vi.fn().mockResolvedValueOnce({ action: "click", explanation: "click it", targetId: "button_0" })
            .mockResolvedValueOnce({ action: "finish", explanation: "done" });
        await (agent as any).executeShoppingLoop(helper, "buyer");
        expect(helper.clickElement).toHaveBeenCalledWith("button_0");
    });

    it("should process type action correctly", async () => {
        (agent as any).buildLLMPrompt = vi.fn().mockReturnValue({ systemPrompt: "sys", userPrompt: "user" });
        (agent as any).queryLLM = vi.fn().mockResolvedValueOnce({ action: "type", explanation: "type it", targetId: "input_0", text: "hello" })
            .mockResolvedValueOnce({ action: "finish", explanation: "done" });
        await (agent as any).executeShoppingLoop(helper, "buyer");
        expect(helper.typeElement).toHaveBeenCalledWith("input_0", "hello");
    });

    it("should process stripe_fill action correctly", async () => {
        (agent as any).buildLLMPrompt = vi.fn().mockReturnValue({ systemPrompt: "sys", userPrompt: "user" });
        (agent as any).queryLLM = vi.fn().mockResolvedValueOnce({ action: "stripe_fill", explanation: "stripe" })
            .mockResolvedValueOnce({ action: "finish", explanation: "done" });
        await (agent as any).executeShoppingLoop(helper, "buyer");
        expect(helper.handleStripeIframe).toHaveBeenCalledWith("123", "12/34", "123", "Bob");
    });

    it("should fail gracefully on invalid action", async () => {
        (agent as any).buildLLMPrompt = vi.fn().mockReturnValue({ systemPrompt: "sys", userPrompt: "user" });
        (agent as any).queryLLM = vi.fn().mockResolvedValueOnce({ action: "unknown", explanation: "unknown" });
        await expect((agent as any).executeShoppingLoop(helper, "buyer")).rejects.toThrow("Unsupported action: unknown");
    });

    it("should cap max loop iterations", async () => {
        (agent as any).buildLLMPrompt = vi.fn().mockReturnValue({ systemPrompt: "sys", userPrompt: "user" });
        (agent as any).queryLLM = vi.fn().mockResolvedValue({ action: "click", explanation: "click it", targetId: "button_0" });
        try {
            await (agent as any).executeShoppingLoop(helper, "buyer");
        } catch {}
        expect((agent as any).state.status).toBe("failed");
    });
});
