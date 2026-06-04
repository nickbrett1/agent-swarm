import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ShopperAgent, Env, ShopperState } from './index.js';
import { PuppeteerBrowserHelper } from './browser.js';
import type { Ai } from '@cloudflare/workers-types';
import type { BrowserWorker } from '@cloudflare/puppeteer';

// Mock the 'agents' SDK to avoid complex Durable Object / cloudflare: protocol setup
vi.mock('agents', () => {
  return {
    Agent: class DummyAgent {
      ctx: any = {};
      state: any = {};
      env: any = {};
      constructor(ctx: any, env: any) {
        // The Cloudflare Agents constructor signature might expect ctx instead of raw state
        this.ctx = ctx;
        this.state = ctx; // fallback assuming context maps to state
        this.env = env;
      }
      setState(newState: any) {
        this.state = { ...this.state, ...newState };
      }
    },
    callable: () => {
      return (target: any, propertyKey: string, descriptor: PropertyDescriptor) => {
        return descriptor;
      };
    },
    routeAgentRequest: vi.fn().mockResolvedValue(null)
  };
});

// Mock PuppeteerBrowserHelper
vi.mock('./browser.js', () => {
  const mockHelper = vi.fn().mockImplementation(() => {
    return {
      init: vi.fn().mockResolvedValue(undefined),
      goto: vi.fn().mockResolvedValue(undefined),
      getPageUrl: vi.fn().mockResolvedValue('https://example.com/shop'),
      getInteractiveElements: vi.fn().mockResolvedValue({
        elements: [{ id: 'buy_btn', text: 'Buy Now' }],
        textSummary: 'Product Page - Buy Now'
      }),
      clickElement: vi.fn().mockResolvedValue(true),
      typeElement: vi.fn().mockResolvedValue(true),
      handleStripeIframe: vi.fn().mockResolvedValue(true),
      wait: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    }
  });

  return {
    PuppeteerBrowserHelper: class {
      init: any;
      goto: any;
      getPageUrl: any;
      getInteractiveElements: any;
      clickElement: any;
      typeElement: any;
      handleStripeIframe: any;
      wait: any;
      close: any;
      constructor() {
        const helper = mockHelper();
        this.init = helper.init;
        this.goto = helper.goto;
        this.getPageUrl = helper.getPageUrl;
        this.getInteractiveElements = helper.getInteractiveElements;
        this.clickElement = helper.clickElement;
        this.typeElement = helper.typeElement;
        this.handleStripeIframe = helper.handleStripeIframe;
        this.wait = helper.wait;
        this.close = helper.close;
      }
    }
  };
});

describe('ShopperAgent', () => {
  let agent: ShopperAgent;
  let mockEnv: Env;
  let mockAi: Ai;

  beforeEach(() => {
    vi.clearAllMocks();

    mockAi = {
      run: vi.fn().mockResolvedValue({
        response: JSON.stringify({
          explanation: "Testing",
          action: "finish"
        })
      })
    } as unknown as Ai;

    mockEnv = {
      MYBROWSER: {} as BrowserWorker,
      AI: mockAi,
      SHOP_URL: 'https://fintechnick.com/shop',
      STRIPE_TEST_CARD: '4242',
      STRIPE_TEST_EXPIRY: '12/24',
      STRIPE_TEST_CVC: '123',
      STRIPE_TEST_NAME: 'Test',
    };

    const mockState: ShopperState = {
      persona: 'A test user',
      history: [],
      status: 'idle'
    };

    agent = new ShopperAgent(mockState, mockEnv);
  });

  it('should initialize with correct default state properties', () => {
    expect(agent.initialState.status).toBe('idle');
    expect(agent.initialState.persona).toContain('cautious tech buyer');
    expect(agent.initialState.history).toEqual([]);
  });

  describe('isSafeUrl', () => {
    it('should block local and private URLs', () => {
      const isSafeUrl = (agent as any).isSafeUrl.bind(agent);

      expect(isSafeUrl('http://localhost:3000')).toBe(false);
      expect(isSafeUrl('http://127.0.0.1')).toBe(false);
      expect(isSafeUrl('http://10.0.0.1')).toBe(false);
      expect(isSafeUrl('http://192.168.1.100')).toBe(false);
      expect(isSafeUrl('http://172.16.0.1')).toBe(false);
      expect(isSafeUrl('http://0.0.0.0')).toBe(false);
      expect(isSafeUrl('http://test.local')).toBe(false);
      expect(isSafeUrl('http://test.internal')).toBe(false);
      expect(isSafeUrl('http://[::1]')).toBe(false);
    });

    it('should allow valid public URLs', () => {
      const isSafeUrl = (agent as any).isSafeUrl.bind(agent);

      expect(isSafeUrl('https://google.com')).toBe(true);
      expect(isSafeUrl('http://example.com/path?query=1')).toBe(true);
      expect(isSafeUrl('https://fintechnick.com/shop')).toBe(true);
    });

    it('should handle malformed URLs safely (block them)', () => {
      const isSafeUrl = (agent as any).isSafeUrl.bind(agent);
      expect(isSafeUrl('not-a-url')).toBe(false);
      expect(isSafeUrl('ftp://example.com')).toBe(false); // Only allows http/https
    });
  });

  describe('runShopping', () => {
    it('should fail immediately if URL is unsafe', async () => {
      const result = await agent.runShopping('Test Persona', 'http://localhost/admin');

      expect(result).toContain('Invalid or unsafe URL');
      expect(agent.state.status).toBe('failed');
    });

    it('should execute shopping flow and reach finish state', async () => {
      // Mock an immediate "finish" action from the LLM
      vi.mocked(mockAi.run).mockResolvedValueOnce({
        response: JSON.stringify({
          explanation: "Found product, finishing",
          action: "finish"
        })
      });

      const result = await agent.runShopping('Test Persona');

      // Not strictly validating the mock class constructor calls here as the implementation handles it.

      expect(mockAi.run).toHaveBeenCalled();
      expect(agent.state.status).toBe('completed');
      expect(result).toContain('Shopping Session Finished');
      expect(result).toContain('Found product, finishing');
    });

    it('should execute click and type actions', async () => {
      // Step 1: Click
      vi.mocked(mockAi.run).mockResolvedValueOnce({
        response: JSON.stringify({
          explanation: "Clicking buy",
          action: "click",
          targetId: "buy_btn"
        })
      });
      // Step 2: Type
      vi.mocked(mockAi.run).mockResolvedValueOnce({
        response: JSON.stringify({
          explanation: "Typing name",
          action: "type",
          targetId: "name_input",
          text: "John Doe"
        })
      });
      // Step 3: Finish
      vi.mocked(mockAi.run).mockResolvedValueOnce({
        response: JSON.stringify({
          explanation: "Done",
          action: "finish"
        })
      });

      const result = await agent.runShopping('Test Persona');


      expect(agent.state.history.length).toBe(3);
      expect(agent.state.history[0]).toContain('Clicking buy');
      expect(agent.state.history[1]).toContain('Typing name');

      expect(agent.state.status).toBe('completed');
    });


    it('should correctly fallback from Gemini to Workers AI on failure', async () => {
      (agent as any).env.GOOGLE_API_KEY = 'fake-key';

      // Mock global fetch to simulate Gemini API failure
      const originalFetch = global.fetch;
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve('Internal Server Error')
      });

      // Mock Workers AI for fallback
      vi.mocked(mockAi.run).mockResolvedValueOnce({
        response: JSON.stringify({
          explanation: "Fallback to Workers AI",
          action: "finish"
        })
      });

      const result = await agent.runShopping('Test Persona');

      expect(global.fetch).toHaveBeenCalledTimes(3); // 3 retries
      expect(mockAi.run).toHaveBeenCalledTimes(1); // Fallback occurred

      expect(agent.state.status).toBe('completed');

      global.fetch = originalFetch; // Restore fetch
    });
  });
});
