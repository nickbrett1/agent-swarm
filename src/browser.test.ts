import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PuppeteerBrowserHelper } from './browser.js';
import puppeteer from '@cloudflare/puppeteer';

vi.mock('@cloudflare/puppeteer', () => ({
  default: {
    launch: vi.fn(),
    connect: vi.fn(),
    sessions: vi.fn().mockResolvedValue([]),
    limits: vi.fn().mockResolvedValue({
      activeSessions: [],
      maxConcurrentSessions: 4,
      allowedBrowserAcquisitions: 1,
      timeUntilNextAllowedBrowserAcquisition: 0,
      usedBrowserTimeSeconds: 0,
    }),
  },
}));

describe('PuppeteerBrowserHelper', () => {
  let helper: PuppeteerBrowserHelper;
  const mockBrowserBinding = {} as any;

  beforeEach(() => {
    vi.clearAllMocks();
    // @ts-ignore - Mocking BrowserWorker is complex and this mock is enough for the tests
    helper = new PuppeteerBrowserHelper(mockBrowserBinding);
  });

  it('should initialize browser and page successfully', async () => {
    const mockPage = {
      setViewport: vi.fn(),
      setDefaultTimeout: vi.fn(),
    };
    const mockBrowser = {
      newPage: vi.fn().mockResolvedValue(mockPage),
    };
    (puppeteer.launch as any).mockResolvedValue(mockBrowser);

    await helper.init();

    expect(puppeteer.launch).toHaveBeenCalledWith(mockBrowserBinding, { keep_alive: 10000 });
    expect(mockBrowser.newPage).toHaveBeenCalled();
    expect(mockPage.setViewport).toHaveBeenCalledWith({ width: 1280, height: 720 });
    expect(mockPage.setDefaultTimeout).toHaveBeenCalledWith(15000);
  });

  it('should close browser safely', async () => {
    const mockClose = vi.fn();
    const mockBrowser = {
      newPage: vi.fn().mockResolvedValue({
        setViewport: vi.fn(),
        setDefaultTimeout: vi.fn(),
      }),
      close: mockClose,
    };
    (puppeteer.launch as any).mockResolvedValue(mockBrowser);

    await helper.init();
    await helper.close();

    expect(mockClose).toHaveBeenCalled();
  });

  it('should ignore close if already closed or errors', async () => {
    const mockClose = vi.fn().mockRejectedValue(new Error('Already closed'));
    const mockBrowser = {
      newPage: vi.fn().mockResolvedValue({
        setViewport: vi.fn(),
        setDefaultTimeout: vi.fn(),
      }),
      close: mockClose,
    };
    (puppeteer.launch as any).mockResolvedValue(mockBrowser);

    await helper.init();
    await helper.close();
    expect(mockClose).toHaveBeenCalled();
  });

  it('should ignore close if a string error is thrown', async () => {
    const mockClose = vi.fn().mockRejectedValue('String error');
    const mockBrowser = {
      newPage: vi.fn().mockResolvedValue({
        setViewport: vi.fn(),
        setDefaultTimeout: vi.fn(),
      }),
      close: mockClose,
    };
    (puppeteer.launch as any).mockResolvedValue(mockBrowser);

    await helper.init();
    const warnSpy = vi.spyOn(console, 'warn');
    await helper.close();
    expect(mockClose).toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith("Ignoring error closing/disconnecting browser:", "String error");
    warnSpy.mockRestore();
  });

  it('should throw error on goto if not initialized', async () => {
    await expect(helper.goto('http://example.com')).rejects.toThrow('Browser not initialized');
  });

  it('should navigate to url', async () => {
    const mockGoto = vi.fn();
    const mockPage = {
      setViewport: vi.fn(),
      setDefaultTimeout: vi.fn(),
      goto: mockGoto,
    };
    const mockBrowser = {
      newPage: vi.fn().mockResolvedValue(mockPage),
    };
    (puppeteer.launch as any).mockResolvedValue(mockBrowser);

    await helper.init();
    await helper.goto('http://example.com');

    expect(mockGoto).toHaveBeenCalledWith('http://example.com', { waitUntil: 'domcontentloaded' });
  });

  it('should get page url', async () => {
    const mockUrl = vi.fn().mockReturnValue('http://example.com');
    const mockPage = {
      setViewport: vi.fn(),
      setDefaultTimeout: vi.fn(),
      url: mockUrl,
    };
    const mockBrowser = {
      newPage: vi.fn().mockResolvedValue(mockPage),
    };
    (puppeteer.launch as any).mockResolvedValue(mockBrowser);

    await helper.init();
    const url = await helper.getPageUrl();

    expect(url).toBe('http://example.com');
  });

  it('should return empty url if page not initialized', async () => {
    const url = await helper.getPageUrl();
    expect(url).toBe('');
  });

  it('should get interactive elements successfully', async () => {
    const mockEvaluate = vi.fn().mockResolvedValue([
      { tag: 'button', type: '', text: 'Submit', placeholder: '', name: '', role: '', xpath: '//button' }
    ]);
    const mockUrl = vi.fn().mockReturnValue('http://example.com');
    const mockPage = {
      setViewport: vi.fn(),
      setDefaultTimeout: vi.fn(),
      evaluate: mockEvaluate,
      url: mockUrl,
    };
    const mockBrowser = {
      newPage: vi.fn().mockResolvedValue(mockPage),
    };
    (puppeteer.launch as any).mockResolvedValue(mockBrowser);

    await helper.init();
    const result = await helper.getInteractiveElements();

    expect(result.elements.length).toBe(1);
    expect(result.elements[0].id).toBe('button_0');
    expect(result.elements[0].text).toBe('Submit');
    expect(result.textSummary).toContain('button_0');
  });

  it('should throw error on getInteractiveElements if not initialized', async () => {
    await expect(helper.getInteractiveElements()).rejects.toThrow('Browser not initialized');
  });

  it('should handle errors in getInteractiveElements and retry', async () => {
    let callCount = 0;
    const mockEvaluate = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount < 3) {
        throw new Error('Timeout');
      }
      return [{ tag: 'button', type: '', text: 'Retry Success', placeholder: '', name: '', role: '', xpath: '//button' }];
    });

    const mockUrl = vi.fn().mockReturnValue('http://example.com');
    const mockPage = {
      setViewport: vi.fn(),
      setDefaultTimeout: vi.fn(),
      evaluate: mockEvaluate,
      url: mockUrl,
      waitForNavigation: vi.fn().mockResolvedValue(undefined),
    };
    const mockBrowser = {
      newPage: vi.fn().mockResolvedValue(mockPage),
    };
    (puppeteer.launch as any).mockResolvedValue(mockBrowser);

    await helper.init();

    // We mock wait to resolve immediately
    const waitSpy = vi.spyOn(helper, 'wait').mockResolvedValue(undefined);

    const result = await helper.getInteractiveElements();

    expect(mockEvaluate).toHaveBeenCalledTimes(3);
    expect(result.elements.length).toBe(1);
    expect(result.elements[0].text).toBe('Retry Success');

    waitSpy.mockRestore();
  });

  it('should handle success page detected during getInteractiveElements error', async () => {
    const mockEvaluate = vi.fn().mockRejectedValue(new Error('Evaluation failed'));
    const mockUrl = vi.fn().mockReturnValue('http://example.com/success');
    const mockPage = {
      setViewport: vi.fn(),
      setDefaultTimeout: vi.fn(),
      evaluate: mockEvaluate,
      url: mockUrl,
      waitForNavigation: vi.fn().mockResolvedValue(undefined),
    };
    const mockBrowser = {
      newPage: vi.fn().mockResolvedValue(mockPage),
    };
    (puppeteer.launch as any).mockResolvedValue(mockBrowser);

    await helper.init();
    const result = await helper.getInteractiveElements();

    expect(result.elements).toEqual([]);
    expect(result.textSummary).toContain('Redirected to success page');
  });

  it('should throw error on clickElement if not initialized', async () => {
    await expect(helper.clickElement('some_id')).rejects.toThrow('Browser not initialized');
  });

  it('should return false if clickElement ID not found', async () => {
    const mockPage = {
      setViewport: vi.fn(),
      setDefaultTimeout: vi.fn(),
    };
    const mockBrowser = {
      newPage: vi.fn().mockResolvedValue(mockPage),
    };
    (puppeteer.launch as any).mockResolvedValue(mockBrowser);
    await helper.init();
    const result = await helper.clickElement('nonexistent_id');
    expect(result).toBe(false);
  });

  it('should click element successfully using xpath query', async () => {
    const mockEvaluate = vi.fn().mockResolvedValue([
      { tag: 'button', type: '', text: 'Submit', placeholder: '', name: '', role: '', xpath: '//button' }
    ]);
    const mockUrl = vi.fn().mockReturnValue('http://example.com');
    const mockClick = vi.fn();
    const mockScrollIntoView = vi.fn();
    const mockPage = {
      setViewport: vi.fn(),
      setDefaultTimeout: vi.fn(),
      evaluate: mockEvaluate,
      url: mockUrl,
      $$: vi.fn().mockResolvedValue([{ scrollIntoView: mockScrollIntoView, click: mockClick }])
    };
    const mockBrowser = {
      newPage: vi.fn().mockResolvedValue(mockPage),
    };
    (puppeteer.launch as any).mockResolvedValue(mockBrowser);

    await helper.init();
    await helper.getInteractiveElements(); // Populate elementsMap
    const result = await helper.clickElement('button_0');

    expect(mockPage.$$).toHaveBeenCalledWith('xpath///button');
    expect(mockScrollIntoView).toHaveBeenCalled();
    expect(mockClick).toHaveBeenCalled();
    expect(result).toBe(true);
  });

  it('should type element successfully', async () => {
    const mockEvaluate = vi.fn().mockResolvedValue([
      { tag: 'input', type: 'text', text: '', placeholder: '', name: '', role: '', xpath: '//input' }
    ]);
    const mockUrl = vi.fn().mockReturnValue('http://example.com');
    const mockType = vi.fn();
    const mockClick = vi.fn();
    const mockScrollIntoView = vi.fn();
    const mockPress = vi.fn();
    const mockPage = {
      setViewport: vi.fn(),
      setDefaultTimeout: vi.fn(),
      evaluate: mockEvaluate,
      url: mockUrl,
      $$: vi.fn().mockResolvedValue([{ scrollIntoView: mockScrollIntoView, click: mockClick, type: mockType }]),
      keyboard: { press: mockPress }
    };
    const mockBrowser = {
      newPage: vi.fn().mockResolvedValue(mockPage),
    };
    (puppeteer.launch as any).mockResolvedValue(mockBrowser);

    await helper.init();
    await helper.getInteractiveElements(); // Populate elementsMap
    const result = await helper.typeElement('input_0', 'test value');

    expect(mockPage.$$).toHaveBeenCalledWith('xpath///input');
    expect(mockScrollIntoView).toHaveBeenCalled();
    expect(mockClick).toHaveBeenCalledWith({ clickCount: 3 });
    expect(mockPress).toHaveBeenCalledWith('Backspace');
    expect(mockType).toHaveBeenCalledWith('test value');
    expect(result).toBe(true);
  });

  it('should return false on typeElement if ID not found', async () => {
    const mockPage = {
      setViewport: vi.fn(),
      setDefaultTimeout: vi.fn(),
    };
    const mockBrowser = {
      newPage: vi.fn().mockResolvedValue(mockPage),
    };
    (puppeteer.launch as any).mockResolvedValue(mockBrowser);
    await helper.init();
    const result = await helper.typeElement('nonexistent_id', 'text');
    expect(result).toBe(false);
  });

  it('should handle errors in typeElement and return false', async () => {
    const mockEvaluate = vi.fn().mockResolvedValue([
      { tag: 'input', type: 'text', text: '', placeholder: '', name: '', role: '', xpath: '//input' }
    ]);
    const mockUrl = vi.fn().mockReturnValue('http://example.com');
    const mockType = vi.fn().mockRejectedValue(new Error('Typing failed'));
    const mockClick = vi.fn();
    const mockScrollIntoView = vi.fn();
    const mockPress = vi.fn();
    const mockPage = {
      setViewport: vi.fn(),
      setDefaultTimeout: vi.fn(),
      evaluate: mockEvaluate,
      url: mockUrl,
      $$: vi.fn().mockResolvedValue([{ scrollIntoView: mockScrollIntoView, click: mockClick, type: mockType }]),
      keyboard: { press: mockPress }
    };
    const mockBrowser = {
      newPage: vi.fn().mockResolvedValue(mockPage),
    };
    (puppeteer.launch as any).mockResolvedValue(mockBrowser);

    await helper.init();
    await helper.getInteractiveElements(); // Populate elementsMap

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await helper.typeElement('input_0', 'test value');

    expect(result).toBe(false);
    expect(consoleSpy).toHaveBeenCalledWith('Error typing into element input_0:', expect.any(Error));
    consoleSpy.mockRestore();
  });

  it('should throw error on typeElement if not initialized', async () => {
    await expect(helper.typeElement('some_id', 'test')).rejects.toThrow('Browser not initialized');
  });

  it('should wait correctly', async () => {
    const start = Date.now();
    await helper.wait(100);
    const end = Date.now();
    expect(end - start).toBeGreaterThanOrEqual(99);
  });

  it('should handle stripe iframe when fields found', async () => {
    const mockFrame = {
      $: vi.fn().mockImplementation((selector: string) => {
        if (selector === 'input#cardNumber' || selector === 'input#cardExpiry' || selector === 'input#cardCvc' || selector === 'input#billingName') {
           return Promise.resolve({
             scrollIntoView: vi.fn(),
             evaluate: vi.fn().mockImplementation((fn, value) => {
               // Simulate the evaluate block execution
               const mockElement = {
                 value: '',
                 dispatchEvent: vi.fn()
               };
               // The evaluate function is passed dynamically, we call it to ensure it executes
               fn(mockElement, value);
             })
           });
        }
        return Promise.resolve(null);
      })
    };
    const mockPage = {
      setViewport: vi.fn(),
      setDefaultTimeout: vi.fn(),
      frames: vi.fn().mockReturnValue([mockFrame]),
    };
    const mockBrowser = {
      newPage: vi.fn().mockResolvedValue(mockPage),
    };
    (puppeteer.launch as any).mockResolvedValue(mockBrowser);

    await helper.init();
    const result = await helper.handleStripeIframe('4242', '12/28', '123', 'Test User');
    expect(result).toBe(true);
  });

  it('should return false handle stripe iframe when fields not found', async () => {
    const mockFrame = {
      $: vi.fn().mockResolvedValue(null)
    };
    const mockPage = {
      setViewport: vi.fn(),
      setDefaultTimeout: vi.fn(),
      frames: vi.fn().mockReturnValue([mockFrame]),
    };
    const mockBrowser = {
      newPage: vi.fn().mockResolvedValue(mockPage),
    };
    (puppeteer.launch as any).mockResolvedValue(mockBrowser);

    await helper.init();
    const result = await helper.handleStripeIframe('4242', '12/28', '123', 'Test User');
    expect(result).toBe(false);
  });

  it('should throw error on handleStripeIframe if not initialized', async () => {
    await expect(helper.handleStripeIframe('4242', '12/28', '123', 'Test')).rejects.toThrow('Browser not initialized');
  });

  it('should handle evaluation click fallback when node is null', async () => {
    const mockUrl = vi.fn().mockReturnValue('http://example.com');

    // Mock global objects for the page.evaluate fallback function
    const originalDocument = global.document;
    const originalXPathResult = global.XPathResult;

    global.document = {
      evaluate: vi.fn().mockReturnValue({
        singleNodeValue: null
      })
    } as any;

    global.XPathResult = {
      FIRST_ORDERED_NODE_TYPE: 9
    } as any;

    // Mock $$ returning empty array to trigger fallback
    const mockPage = {
      setViewport: vi.fn(),
      setDefaultTimeout: vi.fn(),
      evaluate: vi.fn().mockImplementation((fn, ...args) => {
         if (args.length === 0) {
            // GetInteractiveElements eval
            return [{ tag: 'button', type: '', text: 'Submit', placeholder: '', name: '', role: '', xpath: '//button' }];
         } else {
            // click fallback eval - execute the actual fallback function
            return fn(...args);
         }
      }),
      url: mockUrl,
      $$: vi.fn().mockResolvedValue([])
    };
    const mockBrowser = {
      newPage: vi.fn().mockResolvedValue(mockPage),
    };
    (puppeteer.launch as any).mockResolvedValue(mockBrowser);

    await helper.init();
    await helper.getInteractiveElements(); // Populate elementsMap
    const result = await helper.clickElement('button_0');

    expect(mockPage.evaluate).toHaveBeenCalledTimes(2); // once for elements, once for fallback click
    expect(result).toBe(false);
    expect(global.document.evaluate).toHaveBeenCalledWith('//button', global.document, null, 9, null);

    // Cleanup globals
    global.document = originalDocument;
    global.XPathResult = originalXPathResult;
  });

  it('should handle exception during stripe iframe handling', async () => {
    const mockPage = {
      setViewport: vi.fn(),
      setDefaultTimeout: vi.fn(),
      frames: vi.fn().mockImplementation(() => {
        throw new Error('Frames error');
      }),
    };
    const mockBrowser = {
      newPage: vi.fn().mockResolvedValue(mockPage),
    };
    (puppeteer.launch as any).mockResolvedValue(mockBrowser);

    await helper.init();
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await helper.handleStripeIframe('4242', '12/28', '123', 'Test User');

    expect(result).toBe(false);
    expect(consoleSpy).toHaveBeenCalledWith('Exception during Stripe iframe handling:', expect.any(Error));
    consoleSpy.mockRestore();
  });

  it('should handle evaluation click fallback', async () => {
    const mockUrl = vi.fn().mockReturnValue('http://example.com');

    // Mock global objects for the page.evaluate fallback function
    const originalDocument = global.document;
    const originalXPathResult = global.XPathResult;

    const mockScrollIntoView = vi.fn();
    const mockClick = vi.fn();

    global.document = {
      evaluate: vi.fn().mockReturnValue({
        singleNodeValue: {
          scrollIntoView: mockScrollIntoView,
          click: mockClick
        }
      })
    } as any;

    global.XPathResult = {
      FIRST_ORDERED_NODE_TYPE: 9
    } as any;

    // Mock $$ returning empty array to trigger fallback
    const mockPage = {
      setViewport: vi.fn(),
      setDefaultTimeout: vi.fn(),
      evaluate: vi.fn().mockImplementation((fn, ...args) => {
         if (args.length === 0) {
            // GetInteractiveElements eval
            return [{ tag: 'button', type: '', text: 'Submit', placeholder: '', name: '', role: '', xpath: '//button' }];
         } else {
            // click fallback eval - execute the actual fallback function
            return fn(...args);
         }
      }),
      url: mockUrl,
      $$: vi.fn().mockResolvedValue([])
    };
    const mockBrowser = {
      newPage: vi.fn().mockResolvedValue(mockPage),
    };
    (puppeteer.launch as any).mockResolvedValue(mockBrowser);

    await helper.init();
    await helper.getInteractiveElements(); // Populate elementsMap
    const result = await helper.clickElement('button_0');

    expect(mockPage.evaluate).toHaveBeenCalledTimes(2); // once for elements, once for fallback click
    expect(result).toBe(true);
    expect(global.document.evaluate).toHaveBeenCalledWith('//button', global.document, null, 9, null);
    expect(mockScrollIntoView).toHaveBeenCalledWith({ block: 'center' });
    expect(mockClick).toHaveBeenCalled();

    // Cleanup globals
    global.document = originalDocument;
    global.XPathResult = originalXPathResult;
  });

});
