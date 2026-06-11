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

function setupMockBrowser(pageOverrides: any = {}, browserOverrides: any = {}) {
  const mockPage = {
    setViewport: vi.fn(),
    setDefaultTimeout: vi.fn(),
    setRequestInterception: vi.fn().mockResolvedValue(true),
    on: vi.fn(),
    url: vi.fn().mockReturnValue('http://example.com'),
    '$$': vi.fn().mockResolvedValue([]),
    evaluate: vi.fn(),
    ...pageOverrides,
  };
  const mockBrowser = {
    newPage: vi.fn().mockResolvedValue(mockPage),
    ...browserOverrides,
  };
  (puppeteer.launch as any).mockResolvedValue(mockBrowser);
  return { mockBrowser, mockPage };
}

  let helper: PuppeteerBrowserHelper;
  const mockBrowserBinding = {} as any;

  beforeEach(() => {
    vi.clearAllMocks();
    // @ts-ignore - Mocking BrowserWorker is complex and this mock is enough for the tests
    helper = new PuppeteerBrowserHelper(mockBrowserBinding);
  });

  it('should initialize browser and page successfully', async () => {
    const { mockBrowser, mockPage } = setupMockBrowser();

    await helper.init();

    expect(puppeteer.launch).toHaveBeenCalledWith(mockBrowserBinding, { keep_alive: 10000 });
    expect(mockBrowser.newPage).toHaveBeenCalled();
    expect(mockPage.setViewport).toHaveBeenCalledWith({ width: 1280, height: 720 });
    expect(mockPage.setDefaultTimeout).toHaveBeenCalledWith(15000);
  });

  it('should close browser safely', async () => {
    const mockClose = vi.fn();
    setupMockBrowser({}, { close: mockClose });

    await helper.init();
    await helper.close();

    expect(mockClose).toHaveBeenCalled();
  });

  it('should ignore close if already closed or errors', async () => {
    const mockClose = vi.fn().mockRejectedValue(new Error('Already closed'));
    setupMockBrowser({}, { close: mockClose });

    await helper.init();
    await helper.close();
    expect(mockClose).toHaveBeenCalled();
  });

  it('should expose limits on initial launch rate limit error', async () => {
    setupMockBrowser();
    const rateLimitError = new Error('Unable to create new browser: code: 429: message: Rate limit exceeded');
    (puppeteer.launch as any).mockRejectedValue(rateLimitError);

    const mockLimits = {
      activeSessions: [{ id: '1' }, { id: '2' }],
      maxConcurrentSessions: 2,
      allowedBrowserAcquisitions: 0,
      timeUntilNextAllowedBrowserAcquisition: 5000,
    };

    const originalLimits = puppeteer.limits;
    puppeteer.limits = vi.fn().mockResolvedValue(mockLimits) as any;

    try {
      await helper.init();
      throw new Error('Should have thrown an error');
    } catch (err: any) {
      expect(err.message).toContain('Cloudflare Limits: Active Sessions=2/2, Acquisitions Allowed=0, Time Until Next Acquisition=5000ms');
    } finally {
      puppeteer.limits = originalLimits;
    }
  });

  it('should expose limits on retry launch rate limit error', async () => {
    setupMockBrowser();
    const initialError = new Error('Some other launch error');
    const rateLimitError = new Error('Unable to create new browser: code: 429: message: Rate limit exceeded');
    (puppeteer.launch as any)
      .mockRejectedValueOnce(initialError)
      .mockRejectedValue(rateLimitError);

    const mockLimits = {
      activeSessions: [{ id: '1' }],
      maxConcurrentSessions: 2,
      allowedBrowserAcquisitions: 0,
      timeUntilNextAllowedBrowserAcquisition: 3000,
    };

    const originalLimits = puppeteer.limits;
    puppeteer.limits = vi.fn().mockResolvedValue(mockLimits) as any;

    try {
      await helper.init();
      throw new Error('Should have thrown an error');
    } catch (err: any) {
      expect(err.message).toContain('Cloudflare Limits: Active Sessions=1/2, Acquisitions Allowed=0, Time Until Next Acquisition=3000ms');
    } finally {
      puppeteer.limits = originalLimits;
    }
  });

  it('should ignore close if a string error is thrown', async () => {
    const mockClose = vi.fn().mockRejectedValue('String error');
    setupMockBrowser({}, { close: mockClose });

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
    setupMockBrowser({ goto: mockGoto });

    await helper.init();
    await helper.goto('http://example.com');

    expect(mockGoto).toHaveBeenCalledWith('http://example.com', { waitUntil: 'domcontentloaded' });
  });

  it('should get page url', async () => {
    const mockUrl = vi.fn().mockReturnValue('http://example.com');
    setupMockBrowser({ url: mockUrl });

    await helper.init();
    const url = await helper.getPageUrl();

    expect(url).toBe('http://example.com');
  });

  it('should return empty url if page not initialized', async () => {
    const url = await helper.getPageUrl();
    expect(url).toBe('');
  });

  it('should handle edge case where this.page is falsy', async () => {
    const customHelper = new PuppeteerBrowserHelper({} as any);
    // initializing PuppeteerBrowserHelper without a page object
    const url = await customHelper.getPageUrl();
    expect(url).toBe('');
  });

  it('should bubble up error if page.url() throws an exception', async () => {
    const mockUrl = vi.fn().mockImplementation(() => {
      throw new Error('Page disconnected');
    });
    setupMockBrowser({ url: mockUrl });

    await helper.init();
    await expect(helper.getPageUrl()).rejects.toThrow('Page disconnected');
  });

  it('should return url when page is about:blank', async () => {
    const mockUrl = vi.fn().mockReturnValue('about:blank');
    setupMockBrowser({ url: mockUrl });

    await helper.init();
    const url = await helper.getPageUrl();
    expect(url).toBe('about:blank');
  });

  it('should get interactive elements successfully', async () => {
    const mockEvaluate = vi.fn().mockResolvedValue([
      { tag: 'button', type: '', text: 'Submit', placeholder: '', name: '', role: '', xpath: '//button' }
    ]);
    const mockUrl = vi.fn().mockReturnValue('http://example.com');
    setupMockBrowser({ evaluate: mockEvaluate, url: mockUrl });

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
    setupMockBrowser({ evaluate: mockEvaluate, url: mockUrl, waitForNavigation: vi.fn().mockResolvedValue(undefined) });

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
    setupMockBrowser({ evaluate: mockEvaluate, url: mockUrl, waitForNavigation: vi.fn().mockResolvedValue(undefined) });

    await helper.init();
    const result = await helper.getInteractiveElements();

    expect(result.elements).toEqual([]);
    expect(result.textSummary).toContain('Redirected to success page');
  });

  it('should throw error on clickElement if not initialized', async () => {
    await expect(helper.clickElement('some_id')).rejects.toThrow('Browser not initialized');
  });

  it('should return false if element ID not found for click or type', async () => {
    setupMockBrowser();
    await helper.init();

    const clickResult = await helper.clickElement('nonexistent_id');
    expect(clickResult).toBe(false);

    const typeResult = await helper.typeElement('nonexistent_id', 'text');
    expect(typeResult).toBe(false);
  });

  describe('findElement', () => {
    it('should throw error if browser is not initialized', async () => {
      await expect((helper as any).findElement('some_id')).rejects.toThrow('Browser not initialized');
    });

    it('should return null and warn if ID is not found in elementsMap', async () => {
      setupMockBrowser();
      await helper.init();
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const result = await (helper as any).findElement('missing_id');

      expect(result).toBeNull();
      expect(consoleSpy).toHaveBeenCalledWith('Element ID missing_id not found in map');
      consoleSpy.mockRestore();
    });

    it('should return element: null if page.$$ returns no elements', async () => {
      const { mockPage } = setupMockBrowser();
      mockPage.$$ = vi.fn().mockResolvedValue([]);
      await helper.init();
      (helper as any).elementsMap.set('test_id', '//button');

      const result = await (helper as any).findElement('test_id');

      expect(result).toEqual({ element: null, xpath: '//button' });
      expect(mockPage.$$).toHaveBeenCalledWith('xpath///button');
    });

    it('should return first element and dispose of the rest safely', async () => {
      const element1 = { id: 1, dispose: vi.fn() };
      const element2 = { id: 2, dispose: vi.fn().mockRejectedValue(new Error('Dispose error')) };
      const element3 = { id: 3 }; // no dispose method
      const element4 = { id: 4, dispose: vi.fn() };

      const { mockPage } = setupMockBrowser();
      mockPage.$$ = vi.fn().mockResolvedValue([element1, element2, element3, element4]);
      await helper.init();
      (helper as any).elementsMap.set('test_id', '//div');

      const result = await (helper as any).findElement('test_id');

      expect(result).toEqual({ element: element1, xpath: '//div' });
      expect(element2.dispose).toHaveBeenCalled();
      expect(element4.dispose).toHaveBeenCalled();
      // element1 is the one returned, it should NOT be disposed
      expect(element1.dispose).not.toHaveBeenCalled();
    });

    it('should catch errors during page.$$ and return null', async () => {
      const { mockPage } = setupMockBrowser();
      mockPage.$$ = vi.fn().mockRejectedValue(new Error('Query failed'));
      await helper.init();
      (helper as any).elementsMap.set('test_id', '//span');

      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const result = await (helper as any).findElement('test_id');

      expect(result).toBeNull();
      expect(consoleSpy).toHaveBeenCalledWith('Error querying element test_id with xpath //span:', 'Query failed');
      consoleSpy.mockRestore();
    });
  });

  function setupInteractionMock(typeFn: any = vi.fn(), tag = 'input') {
    const mockEvaluate = vi.fn().mockResolvedValue([{ tag, type: 'text', text: '', placeholder: '', name: '', role: '', xpath: `//${tag}` }]);
    const mockClick = vi.fn();
    const mockScrollIntoView = vi.fn();
    const mockPress = vi.fn();
    const { mockPage } = setupMockBrowser({ evaluate: mockEvaluate, url: vi.fn().mockReturnValue('http://example.com'), '$$': vi.fn().mockResolvedValue([{ scrollIntoView: mockScrollIntoView, click: mockClick, type: typeFn }]), keyboard: { press: mockPress } });
    return { mockPage, mockClick, mockScrollIntoView, mockPress, typeFn };
  }

  it('should click element successfully using xpath query', async () => {
    const { mockPage, mockScrollIntoView, mockClick } = setupInteractionMock(vi.fn(), 'button');
    await helper.init();
    await helper.getInteractiveElements();
    expect(await helper.clickElement('button_0')).toBe(true);
    expect(mockPage.$$).toHaveBeenCalledWith('xpath///button');
    expect(mockScrollIntoView).toHaveBeenCalled();
    expect(mockClick).toHaveBeenCalled();
  });

  it('should type element successfully', async () => {
    const { mockPage, mockScrollIntoView, mockClick, mockPress, typeFn } = setupInteractionMock();
    await helper.init();
    await helper.getInteractiveElements();
    expect(await helper.typeElement('input_0', 'test value')).toBe(true);
    expect(mockPage.$$).toHaveBeenCalledWith('xpath///input');
    expect(mockScrollIntoView).toHaveBeenCalled();
    expect(mockClick).toHaveBeenCalledWith({ clickCount: 3 });
    expect(mockPress).toHaveBeenCalledWith('Backspace');
    expect(typeFn).toHaveBeenCalledWith('test value');
  });

  it('should handle errors in typeElement and return false', async () => {
    setupInteractionMock(vi.fn().mockRejectedValue(new Error('Typing failed')));
    await helper.init();
    await helper.getInteractiveElements();
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await helper.typeElement('input_0', 'test value')).toBe(false);
    expect(consoleSpy).toHaveBeenCalledWith('Error typing into element input_0:', expect.any(Error));
    consoleSpy.mockRestore();
  });

  it('should throw error on typeElement if not initialized', async () => {
    await expect(helper.typeElement('some_id', 'test')).rejects.toThrow('Browser not initialized');
  });

  it('should handle detached frame error in both click and type elements', async () => {
    const mockEvaluate = vi.fn().mockResolvedValue([
      { tag: 'button', type: '', text: 'Submit', placeholder: '', name: '', role: '', xpath: '//button' },
      { tag: 'input', type: 'text', text: '', placeholder: '', name: '', role: '', xpath: '//input' }
    ]);
    setupMockBrowser({ evaluate: mockEvaluate, '$$': vi.fn().mockRejectedValue(new Error("Attempted to use detached Frame 'some_frame_id'")) });

    await helper.init();
    await helper.getInteractiveElements();

    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(await helper.clickElement('button_0')).toBe(false);
    expect(await helper.typeElement('input_1', 'test value')).toBe(false);

    expect(consoleSpy.mock.calls.some(call => call[0] && String(call[0]).includes('Error querying element'))).toBe(true);
    consoleSpy.mockRestore();
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
        if (
          selector.includes('input#cardNumber') ||
          selector.includes('input#cardExpiry') ||
          selector.includes('input#cardCvc') ||
          selector.includes('input#billingName')
        ) {
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
    setupMockBrowser({ frames: vi.fn().mockReturnValue([mockFrame]) });

    await helper.init();
    const result = await helper.handleStripeIframe('4242', '12/28', '123', 'Test User');
    expect(result).toBe(true);
  });

  it('should return false handle stripe iframe when fields not found', async () => {
    const mockFrame = {
      $: vi.fn().mockResolvedValue(null)
    };
    setupMockBrowser({ frames: vi.fn().mockReturnValue([mockFrame]) });

    await helper.init();
    const result = await helper.handleStripeIframe('4242', '12/28', '123', 'Test User');
    expect(result).toBe(false);
  });

  it('should throw error on handleStripeIframe if not initialized', async () => {
    await expect(helper.handleStripeIframe('4242', '12/28', '123', 'Test')).rejects.toThrow('Browser not initialized');
  });


  function setupFallbackMock(nodeValue: any) {
    const originalDocument = global.document;
    const originalXPathResult = global.XPathResult;
    global.document = { evaluate: vi.fn().mockReturnValue({ singleNodeValue: nodeValue }) } as any;
    global.XPathResult = { FIRST_ORDERED_NODE_TYPE: 9 } as any;

    const { mockPage } = setupMockBrowser({ evaluate: vi.fn().mockImplementation((fn, ...args) => { if (args.length === 0) { return [{ tag: 'button', type: '', text: 'Submit', placeholder: '', name: '', role: '', xpath: '//button' }]; } else { return fn(...args); } }), '$$': vi.fn().mockResolvedValue([]) });
    return { mockPage, cleanup: () => { global.document = originalDocument; global.XPathResult = originalXPathResult; } };
  }

  it('should handle evaluation click fallback when node is null', async () => {
    const { mockPage, cleanup } = setupFallbackMock(null);
    await helper.init();
    await helper.getInteractiveElements();
    expect(await helper.clickElement('button_0')).toBe(false);
    expect(mockPage.evaluate).toHaveBeenCalledTimes(2);
    expect(global.document.evaluate).toHaveBeenCalledWith('//button', global.document, null, 9, null);
    cleanup();
  });

  it('should handle evaluation click fallback', async () => {
    const mockScrollIntoView = vi.fn();
    const mockClick = vi.fn();
    const { mockPage, cleanup } = setupFallbackMock({ scrollIntoView: mockScrollIntoView, click: mockClick });

    await helper.init();
    await helper.getInteractiveElements();
    expect(await helper.clickElement('button_0')).toBe(true);
    expect(mockPage.evaluate).toHaveBeenCalledTimes(2);
    expect(global.document.evaluate).toHaveBeenCalledWith('//button', global.document, null, 9, null);
    expect(mockScrollIntoView).toHaveBeenCalledWith({ block: 'center' });
    expect(mockClick).toHaveBeenCalled();
    cleanup();
  });

  it('should handle exception during stripe iframe handling', async () => {
    setupMockBrowser({ frames: vi.fn().mockImplementation(() => { throw new Error('Frames error'); }) });

    await helper.init();
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await helper.handleStripeIframe('4242', '12/28', '123', 'Test User');

    expect(result).toBe(false);
    expect(consoleSpy).toHaveBeenCalledWith('Exception during Stripe iframe handling:', expect.any(Error));
    consoleSpy.mockRestore();
  });

});
