import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("cloudflare:workers", () => ({
  env: {
    MYBROWSER: {
      fetch: vi.fn(),
    },
  },
}));

import { StagehandBrowserHelper } from "./browser.js";
import { Stagehand } from "@browserbasehq/stagehand";
import puppeteer from "@cloudflare/puppeteer";

vi.mock("@cloudflare/puppeteer", () => ({
  default: {
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

vi.mock("@cloudflare/playwright", () => ({
  chromium: { connectOverCDP: vi.fn() },
  endpointURLString: vi.fn().mockReturnValue("wss://dummy-cdp-url"),
}));

describe("connectOverCDP patching", () => {
    let originalConnectOverCDP: any;

    beforeEach(async () => {
        vi.resetModules();
        originalConnectOverCDP = vi.fn().mockResolvedValue({ contexts: () => [{}] });
        vi.doMock("@cloudflare/playwright", () => ({
            chromium: { connectOverCDP: originalConnectOverCDP },
            endpointURLString: vi.fn().mockReturnValue("wss://dummy-cdp-url")
        }));
    });

    afterEach(() => {
        vi.doUnmock("@cloudflare/playwright");
    });

    it("query params are stripped and correct args are passed", async () => {
        const playwright = await import("@cloudflare/playwright");
        await import("./browser.js");

        await playwright.chromium.connectOverCDP("wss://example.com/v1/devtools/browser/ws?foo=bar", { custom: "opts" } as any);

        expect(originalConnectOverCDP).toHaveBeenCalledWith("wss://example.com/v1/devtools/browser/ws", { custom: "opts" });
    });

    it("strips query params from options object", async () => {
        const playwright = await import("@cloudflare/playwright");
        await import("./browser.js");

        await playwright.chromium.connectOverCDP({ endpointURL: "wss://example.com/v1/devtools/browser/ws?foo=bar", wsEndpoint: "wss://example.com/v1/devtools/browser/ws?foo=bar" } as any);

        expect(originalConnectOverCDP).toHaveBeenCalledWith({ endpointURL: "wss://example.com/v1/devtools/browser/ws", wsEndpoint: "wss://example.com/v1/devtools/browser/ws" });
    });

    it("ignores invalid urls", async () => {
        const playwright = await import("@cloudflare/playwright");
        await import("./browser.js");

        await playwright.chromium.connectOverCDP("invalid url");

        expect(originalConnectOverCDP).toHaveBeenCalledWith("invalid url");
    });

    it("ignores invalid urls in object", async () => {
        const playwright = await import("@cloudflare/playwright");
        await import("./browser.js");

        await playwright.chromium.connectOverCDP({endpointURL: "invalid url"} as any);

        expect(originalConnectOverCDP).toHaveBeenCalledWith({endpointURL: "invalid url"});
    });

    it("throws new error if websocket upgrade fails", async () => {
        originalConnectOverCDP.mockRejectedValueOnce(new Error("webSocket upgrade failed"));

        const playwright = await import("@cloudflare/playwright");
        await import("./browser.js");

        await expect(playwright.chromium.connectOverCDP("wss://example.com/ws", {} as any)).rejects.toThrow("WebSocket upgrade failed in Playwright connectOverCDP:");
    });

    it("rethrows general connectOverCDP errors", async () => {
        originalConnectOverCDP.mockRejectedValueOnce(new Error("general error"));

        const playwright = await import("@cloudflare/playwright");
        await import("./browser.js");

        await expect(playwright.chromium.connectOverCDP("wss://example.com/ws", {} as any)).rejects.toThrow("general error");
    });

    it("creates new context if none exists", async () => {
        const mockBrowser = { contexts: () => [], newContext: vi.fn().mockResolvedValue(undefined) };
        originalConnectOverCDP.mockResolvedValueOnce(mockBrowser);

        const playwright = await import("@cloudflare/playwright");
        await import("./browser.js");

        await playwright.chromium.connectOverCDP("wss://example.com/ws", {} as any);
        expect(mockBrowser.newContext).toHaveBeenCalled();
    });
});

const mockPage = {
  goto: vi.fn(),
  url: vi.fn().mockReturnValue("https://example.com"),
  evaluate: vi.fn(),
  locator: vi.fn(),
  frames: vi.fn().mockReturnValue([]),
  act: vi.fn(),
  waitForLoadState: vi.fn(),
};

const mockContext = {
  activePage: vi.fn().mockReturnValue(mockPage),
  pages: vi.fn().mockReturnValue([mockPage]),
};

const mockStagehand = {
  init: vi.fn(),
  close: vi.fn(),
  context: mockContext,
};

vi.mock("@browserbasehq/stagehand", () => {
  return {
    Stagehand: vi.fn().mockImplementation(function () {
      return mockStagehand;
    }),
    LLMClient: class { init() { return Promise.resolve(); } },
  };
});

describe("StagehandBrowserHelper", () => {
  let helper: StagehandBrowserHelper;
  const mockBrowserBinding = {
    fetch: vi.fn().mockResolvedValue({ text: () => Promise.resolve("OK") }),
  } as any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPage.goto.mockReset();
    mockPage.url.mockReturnValue("https://example.com");
    mockPage.evaluate.mockReset();
    mockPage.locator.mockReset();
    mockPage.frames.mockReturnValue([]);
    mockPage.act.mockReset();
    mockPage.waitForLoadState.mockReset();
    mockStagehand.init.mockReset();
    mockStagehand.close.mockReset();

    helper = new StagehandBrowserHelper(mockBrowserBinding, {}, "test-gemini-key");
  });

  it("should initialize Stagehand successfully", async () => {
    await helper.init();

    expect(Stagehand).toHaveBeenCalled();
    expect(mockStagehand.init).toHaveBeenCalled();
  });

  it("should close browser safely", async () => {
    await helper.init();
    await helper.close();

    expect(mockStagehand.close).toHaveBeenCalled();
  });

  it("should ignore close error safely", async () => {
    mockStagehand.close.mockRejectedValueOnce(new Error("Stagehand close error"));
    await helper.init();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await helper.close();

    expect(mockStagehand.close).toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith("Error closing Stagehand:", "Stagehand close error");
    warnSpy.mockRestore();
  });

  it("should navigate to url", async () => {
    await helper.init();
    await helper.goto("https://example.com");

    expect(mockPage.goto).toHaveBeenCalledWith("https://example.com", { waitUntil: "domcontentloaded" });
  });

  it("should get page url", async () => {
    await helper.init();
    const url = await helper.getPageUrl();

    expect(url).toBe("https://example.com");
  });

  it("should return empty url if not initialized", async () => {
    const url = await helper.getPageUrl();
    expect(url).toBe("");
  });

  it("should throw error on goto if not initialized", async () => {
    await expect(helper.goto("https://example.com")).rejects.toThrow("Browser not initialized");
  });

  it("should throw error on getInteractiveElements if not initialized", async () => {
    await expect(helper.getInteractiveElements()).rejects.toThrow("Browser not initialized");
  });

  it("should get interactive elements successfully", async () => {
    mockPage.evaluate.mockResolvedValueOnce([
      { tag: "button", type: "", text: "Submit", placeholder: "", name: "", role: "", xpath: "//button" }
    ]);
    await helper.init();
    const result = await helper.getInteractiveElements();

    expect(result.elements.length).toBe(1);
    expect(result.elements[0].id).toBe("button_0");
    expect(result.elements[0].text).toBe("Submit");
    expect(result.textSummary).toContain("button_0");
  });

  it("should handle transient detached frame errors in getInteractiveElements", async () => {
    let calls = 0;
    mockPage.evaluate.mockImplementation(() => {
      calls++;
      if (calls === 1) {
        throw new Error("Attempted to use detached Frame");
      }
      return [{ tag: "button", type: "", text: "Success", placeholder: "", name: "", role: "", xpath: "//button" }];
    });

    await helper.init();
    const waitSpy = vi.spyOn(helper, "wait").mockResolvedValue();
    const result = await helper.getInteractiveElements();

    expect(result.elements.length).toBe(1);
    expect(result.elements[0].text).toBe("Success");
    expect(calls).toBe(2);
    waitSpy.mockRestore();
  });

  it("should return empty elements if persistent detached frame error occurs in getInteractiveElements", async () => {
    mockPage.evaluate.mockRejectedValue(new Error("Attempted to use detached Frame"));

    await helper.init();
    const waitSpy = vi.spyOn(helper, "wait").mockResolvedValue();
    const result = await helper.getInteractiveElements();

    expect(result.elements).toEqual([]);
    expect(result.textSummary).toContain("transient detached frame state");
    waitSpy.mockRestore();
  });

  it("should handle success page detected during getInteractiveElements error", async () => {
    mockPage.evaluate.mockRejectedValue(new Error("Evaluation failed"));
    mockPage.url.mockReturnValue("https://example.com/success");

    await helper.init();
    const waitSpy = vi.spyOn(helper, "wait").mockResolvedValue();
    const result = await helper.getInteractiveElements();

    expect(result.elements).toEqual([]);
    expect(result.textSummary).toContain("Redirected to success page");
    waitSpy.mockRestore();
  });

  it("should throw error on clickElement if not initialized", async () => {
    await expect(helper.clickElement("button_0")).rejects.toThrow("Browser not initialized");
  });

  it("should return false if click element is not found in map", async () => {
    await helper.init();
    const result = await helper.clickElement("nonexistent");
    expect(result).toBe(false);
  });

  async function setupInteractiveElement(element: any) {
    mockPage.evaluate.mockResolvedValueOnce([element]);
    await helper.init();
    await helper.getInteractiveElements();
  }

  it("should click element successfully using Stagehand act", async () => {
    await setupInteractiveElement({ tag: "button", type: "", text: "Click Me", placeholder: "", name: "", role: "", xpath: "//button" });

    mockPage.act.mockResolvedValueOnce(undefined);
    const success = await helper.clickElement("button_0");

    expect(success).toBe(true);
    expect(mockPage.act).toHaveBeenCalledWith('Click the button with text "Click Me"');
  });

  it("should fallback to Playwright locator click if Stagehand act fails", async () => {
    await setupInteractiveElement({ tag: "button", type: "", text: "Click Me", placeholder: "", name: "", role: "", xpath: "//button" });

    mockPage.act.mockRejectedValueOnce(new Error("Act failed"));
    const mockLocator = {
      click: vi.fn().mockResolvedValue(undefined),
    };
    mockPage.locator.mockReturnValueOnce(mockLocator);

    const success = await helper.clickElement("button_0");

    expect(success).toBe(true);
    expect(mockPage.locator).toHaveBeenCalledWith("xpath=//button");
    expect(mockLocator.click).toHaveBeenCalled();
  });

  it("should fallback to direct evaluate click if Playwright locator click fails", async () => {
    await setupInteractiveElement({ tag: "button", type: "", text: "Click Me", placeholder: "", name: "", role: "", xpath: "//button" });

    mockPage.act.mockRejectedValueOnce(new Error("Act failed"));
    const mockLocator = {
      click: vi.fn().mockRejectedValue(new Error("Locator click failed")),
    };
    mockPage.locator.mockReturnValueOnce(mockLocator);

    // Direct evaluate mock
    mockPage.evaluate.mockResolvedValueOnce(true);

    const success = await helper.clickElement("button_0");

    expect(success).toBe(true);
    expect(mockPage.evaluate).toHaveBeenCalledWith(expect.any(Function), "//button");
  });

  it("should return false if Eval fallback click fails", async () => {
    await setupInteractiveElement({ tag: "button", type: "", text: "Click Me", placeholder: "", name: "", role: "", xpath: "//button" });

    mockPage.act.mockRejectedValueOnce(new Error("Act failed"));
    const mockLocator = {
      click: vi.fn().mockRejectedValue(new Error("Locator click failed")),
    };
    mockPage.locator.mockReturnValueOnce(mockLocator);

    // Direct evaluate mock rejects
    mockPage.evaluate.mockRejectedValueOnce(new Error("Eval fallback failed"));

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const success = await helper.clickElement("button_0");

    expect(success).toBe(false);
    expect(consoleSpy).toHaveBeenCalledWith(
      "Eval fallback click failed for button_0:",
      expect.any(Error)
    );
    expect(mockPage.evaluate).toHaveBeenCalledWith(expect.any(Function), "//button");

    consoleSpy.mockRestore();
  });

  it("should type element successfully using Stagehand act", async () => {
    await setupInteractiveElement({ tag: "input", type: "text", text: "", placeholder: "Enter name", name: "", role: "", xpath: "//input" });

    mockPage.act.mockResolvedValueOnce(undefined);
    const success = await helper.typeElement("input_0", "John Doe");

    expect(success).toBe(true);
    expect(mockPage.act).toHaveBeenCalledWith('Type "John Doe" into the input with placeholder/label "Enter name"');
  });

  it("should fallback to Playwright fill if Stagehand type fails", async () => {
    await setupInteractiveElement({ tag: "input", type: "text", text: "", placeholder: "Enter name", name: "", role: "", xpath: "//input" });

    mockPage.act.mockRejectedValueOnce(new Error("Act failed"));
    const mockLocator = {
      fill: vi.fn().mockResolvedValue(undefined),
    };
    mockPage.locator.mockReturnValueOnce(mockLocator);

    const success = await helper.typeElement("input_0", "John Doe");

    expect(success).toBe(true);
    expect(mockPage.locator).toHaveBeenCalledWith("xpath=//input");
    expect(mockLocator.fill).toHaveBeenCalledWith("John Doe", { timeout: 5000 });
  });

  it("should return false if Playwright fill fallback fails", async () => {
    await setupInteractiveElement({ tag: "input", type: "text", text: "", placeholder: "Enter name", name: "", role: "", xpath: "//input" });

    mockPage.act.mockRejectedValueOnce(new Error("Act failed"));
    const fallbackError = new Error("Locator fill failed");
    const mockLocator = {
      fill: vi.fn().mockRejectedValue(fallbackError),
    };
    mockPage.locator.mockReturnValueOnce(mockLocator);

    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const success = await helper.typeElement("input_0", "John Doe");

    expect(success).toBe(false);
    expect(mockPage.locator).toHaveBeenCalledWith("xpath=//input");
    expect(mockLocator.fill).toHaveBeenCalledWith("John Doe", { timeout: 5000 });
    expect(consoleErrorSpy).toHaveBeenCalledWith("Playwright fallback type failed for input_0:", fallbackError);

    consoleErrorSpy.mockRestore();
  });

  it("should handle Stripe iframe using Stagehand act", async () => {
    // This test logic covers an obsolete scenario where `handleStripeIframe` attempts an initial `act` call directly instead of going through frames first.
    // However, looking at the code in `browser.ts`, the direct `act` call is used as a fallback if `page.frames()` filling fails or if frames are empty.
    // To properly simulate the test as it stands (which doesn't mock frames failure), it actually tries to fill frames, and since no mock is set for frames here, it might just return empty or fail, triggering the fallback.
    await helper.init();

    // Simulate Playwright frames failing (e.g. no frames found) to trigger the fallback act call.
    mockPage.frames.mockReturnValueOnce([]);
    mockPage.act.mockResolvedValueOnce(undefined);

    const success = await helper.handleStripeIframe("4242", "12/28", "123", "John");
    expect(success).toBe(true);
    expect(mockPage.act).toHaveBeenCalledWith({
      action: 'Fill the credit card checkout form with this testing card information: card number <card>, expiry <expiry>, cvc <cvc>, and name <name>. Submit the form if there is a button.',
      variables: {
        card: "4242",
        expiry: "12/28",
        cvc: "123",
        name: "John"
      }
    });
  });

  it("should successfully fill Stripe using Playwright frames", async () => {
    await helper.init();

    const firstMock = { fill: vi.fn().mockResolvedValue(undefined) };
    const mockFrame = {
      locator: vi.fn().mockReturnValue({
        count: vi.fn().mockResolvedValue(1),
        first: vi.fn().mockReturnValue(firstMock),
        fill: vi.fn().mockResolvedValue(undefined),
      }),
    };
    mockPage.frames.mockReturnValue([mockFrame]);

    const success = await helper.handleStripeIframe("4242", "12/28", "123", "John");
    expect(success).toBe(true);
    expect(mockFrame.locator).toHaveBeenCalled();
  });

  it("should return false if both Playwright frames filling and Stagehand act fallback fail", async () => {
    await helper.init();

    // Simulate Playwright frames failing (e.g. no frames found)
    mockPage.frames.mockReturnValueOnce([]);

    // Simulate Stagehand act fallback failing
    mockPage.act.mockRejectedValueOnce(new Error("Fallback Act failed"));

    const success = await helper.handleStripeIframe("4242", "12/28", "123", "John");
    expect(success).toBe(false);
    expect(mockPage.frames).toHaveBeenCalled();
    expect(mockPage.act).toHaveBeenCalledWith({
      action: 'Fill the credit card checkout form with this testing card information: card number <card>, expiry <expiry>, cvc <cvc>, and name <name>. Submit the form if there is a button.',
      variables: {
        card: "4242",
        expiry: "12/28",
        cvc: "123",
        name: "John"
      }
    });
  });

  it("should return true if Playwright frames filling fails but Stagehand act fallback succeeds", async () => {
    await helper.init();

    // Simulate Playwright frames failing (e.g. no frames found)
    mockPage.frames.mockReturnValueOnce([]);

    // Simulate Stagehand act fallback succeeding
    mockPage.act.mockResolvedValueOnce(undefined);

    const success = await helper.handleStripeIframe("4242", "12/28", "123", "John");
    expect(success).toBe(true);
    expect(mockPage.frames).toHaveBeenCalled();
    expect(mockPage.act).toHaveBeenCalledWith({
      action: 'Fill the credit card checkout form with this testing card information: card number <card>, expiry <expiry>, cvc <cvc>, and name <name>. Submit the form if there is a button.',
      variables: {
        card: "4242",
        expiry: "12/28",
        cvc: "123",
        name: "John"
      }
    });
  });

  it("should handle rate limit errors correctly in init", async () => {
    const originalLimits = puppeteer.limits;
    puppeteer.limits = vi.fn().mockResolvedValue({
      activeSessions: [{ id: "1" }],
      maxConcurrentSessions: 2,
      allowedBrowserAcquisitions: 0,
      timeUntilNextAllowedBrowserAcquisition: 5000,
    }) as any;

    mockStagehand.init.mockRejectedValueOnce(new Error("Unable to create new browser: Rate limit exceeded"));

    try {
      await helper.init();
      throw new Error("Should have thrown error");
    } catch (err: any) {
      expect(err.message).toContain("Cloudflare Limits: Active Sessions=1/2");
    } finally {
      puppeteer.limits = originalLimits;
    }
  });

  it("should wait for the specified time", async () => {
    vi.useFakeTimers();
    const waitPromise = helper.wait(1000);
    vi.advanceTimersByTime(1000);
    await expect(waitPromise).resolves.toBeUndefined();
    vi.useRealTimers();
  });
});

describe("StagehandBrowserHelper uncovered methods", () => {
    let mockPage: any;
    let mockContext: any;
    let mockStagehand: any;

    beforeEach(async () => {
        const puppeteer = await import("@cloudflare/puppeteer");
        puppeteer.default.sessions = vi.fn().mockResolvedValue([{ sessionId: "mock-session-id" }]);

        mockPage = {
            route: vi.fn(),
            evaluate: vi.fn(),
            url: vi.fn().mockReturnValue("https://example.com")
        };
        mockContext = {
            activePage: vi.fn().mockReturnValue(mockPage),
            pages: vi.fn().mockReturnValue([mockPage])
        };

        mockStagehand = {
            init: vi.fn().mockResolvedValue(undefined),
            context: mockContext,
            close: vi.fn().mockResolvedValue(undefined),
            page: mockPage,
        };
    });

    it("should handle tryGetExistingSessionUrl correctly", async () => {
        vi.spyOn((await import("./browser.js")).StagehandBrowserHelper.prototype as any, 'wait').mockResolvedValue(undefined);
        const helper = new (await import("./browser.js")).StagehandBrowserHelper({
            fetch: vi.fn().mockResolvedValue({ text: () => Promise.resolve("ok"), status: 200 })
        });
        (helper as any).createStagehand = vi.fn().mockReturnValue(mockStagehand);
        await helper.init();
        expect(mockStagehand.init).toHaveBeenCalled();
    });

    it("should setup blocker to abort trackers", async () => {
        vi.spyOn((await import("./browser.js")).StagehandBrowserHelper.prototype as any, 'wait').mockResolvedValue(undefined);
        const helper = new (await import("./browser.js")).StagehandBrowserHelper({ fetch: vi.fn().mockResolvedValue({ text: () => Promise.resolve("ok"), status: 200 }) });
        (helper as any).createStagehand = vi.fn().mockReturnValue(mockStagehand);
        await helper.init();

        expect(mockPage.route).toHaveBeenCalledWith("**/*", expect.any(Function));

        const routeCallback = mockPage.route.mock.calls[0][1];

        const mockAbort = vi.fn();
        const mockContinue = vi.fn();

        const mockTrackerRoute = {
            request: () => ({ resourceType: () => "script", url: () => "https://google-analytics.com/analytics.js" }),
            abort: mockAbort,
            continue: mockContinue
        };
        routeCallback(mockTrackerRoute);
        expect(mockAbort).toHaveBeenCalled();

        const mockMediaRoute = {
            request: () => ({ resourceType: () => "media", url: () => "https://example.com/video.mp4" }),
            abort: mockAbort,
            continue: mockContinue
        };
        routeCallback(mockMediaRoute);
        expect(mockAbort).toHaveBeenCalledTimes(2);

        const mockValidRoute = {
            request: () => ({ resourceType: () => "document", url: () => "https://example.com/page.html" }),
            abort: mockAbort,
            continue: mockContinue
        };
        routeCallback(mockValidRoute);
        expect(mockContinue).toHaveBeenCalled();
    });

    it("should retry with fresh session on existing session connection error", async () => {
        vi.spyOn((await import("./browser.js")).StagehandBrowserHelper.prototype as any, 'wait').mockResolvedValue(undefined);
        const helper = new (await import("./browser.js")).StagehandBrowserHelper({ fetch: vi.fn().mockResolvedValue({ text: () => Promise.resolve("ok"), status: 200 }) });
        (helper as any).createStagehand = vi.fn().mockReturnValue(mockStagehand);

        // Fails first attempt, succeeds second
        mockStagehand.init
            .mockRejectedValueOnce(new Error("Connection error"))
            .mockResolvedValueOnce(undefined);

        await expect(helper.init()).resolves.toBeUndefined();
        expect(mockStagehand.init).toHaveBeenCalledTimes(2);
    });

    it("should handle error in close()", async () => {
        vi.spyOn((await import("./browser.js")).StagehandBrowserHelper.prototype as any, 'wait').mockResolvedValue(undefined);
        const helper = new (await import("./browser.js")).StagehandBrowserHelper({ fetch: vi.fn().mockResolvedValue({ text: () => Promise.resolve("ok"), status: 200 }) });
        (helper as any).createStagehand = vi.fn().mockReturnValue(mockStagehand);
        await helper.init();
        mockStagehand.close.mockRejectedValueOnce(new Error("Close error"));
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

        await expect(helper.close()).resolves.toBeUndefined();
        expect(warnSpy).toHaveBeenCalledWith("Error closing Stagehand:", "Close error");
        warnSpy.mockRestore();
    });

    it("should process limits information correctly in handleInitError", async () => {
        vi.spyOn((await import("./browser.js")).StagehandBrowserHelper.prototype as any, 'wait').mockResolvedValue(undefined);
        const puppeteer = await import("@cloudflare/puppeteer");
        puppeteer.default.limits = vi.fn().mockResolvedValue({
            activeSessions: [{ id: "mock-session-id" }],
            maxConcurrentSessions: 4,
            allowedBrowserAcquisitions: 1,
            timeUntilNextAllowedBrowserAcquisition: 0
        });

        const helper = new (await import("./browser.js")).StagehandBrowserHelper({ fetch: vi.fn().mockResolvedValue({ text: () => Promise.resolve("ok"), status: 200 }) });
        (helper as any).createStagehand = vi.fn().mockReturnValue(mockStagehand);

        mockStagehand.init.mockRejectedValue(new Error("Unable to create new browser"));

        await expect(helper.init()).rejects.toThrow("Unable to create new browser - Cloudflare Limits: Active Sessions=1/4, Acquisitions Allowed=1, Time Until Next Acquisition=0ms");
    });
});

describe("StagehandBrowserHelper uncovered methods", () => {
    let mockPage: any;
    let mockContext: any;
    let mockStagehand: any;

    beforeEach(async () => {
        const puppeteer = await import("@cloudflare/puppeteer");
        puppeteer.default.sessions = vi.fn().mockResolvedValue([{ sessionId: "mock-session-id" }]);

        mockPage = {
            route: vi.fn(),
            evaluate: vi.fn(),
            url: vi.fn().mockReturnValue("https://example.com")
        };
        mockContext = {
            activePage: vi.fn().mockReturnValue(mockPage),
            pages: vi.fn().mockReturnValue([mockPage])
        };

        mockStagehand = {
            init: vi.fn().mockResolvedValue(undefined),
            context: mockContext,
            close: vi.fn().mockResolvedValue(undefined),
            page: mockPage,
        };
    });

    it("should handle tryGetExistingSessionUrl correctly", async () => {
        const helper = new (await import("./browser.js")).StagehandBrowserHelper({
            fetch: vi.fn().mockResolvedValue({ text: () => Promise.resolve("ok"), status: 200 })
        });
        (helper as any).createStagehand = vi.fn().mockReturnValue(mockStagehand);
        vi.spyOn(helper as any, 'wait').mockResolvedValue(undefined);
        await helper.init();
        expect(mockStagehand.init).toHaveBeenCalled();
    });

    it("should setup blocker to abort trackers", async () => {
        const helper = new (await import("./browser.js")).StagehandBrowserHelper({ fetch: vi.fn().mockResolvedValue({ text: () => Promise.resolve("ok"), status: 200 }) });
        (helper as any).createStagehand = vi.fn().mockReturnValue(mockStagehand);
        vi.spyOn(helper as any, 'wait').mockResolvedValue(undefined);
        await helper.init();

        expect(mockPage.route).toHaveBeenCalledWith("**/*", expect.any(Function));

        const routeCallback = mockPage.route.mock.calls[0][1];

        const mockAbort = vi.fn();
        const mockContinue = vi.fn();

        const mockTrackerRoute = {
            request: () => ({ resourceType: () => "script", url: () => "https://google-analytics.com/analytics.js" }),
            abort: mockAbort,
            continue: mockContinue
        };
        routeCallback(mockTrackerRoute);
        expect(mockAbort).toHaveBeenCalled();

        const mockMediaRoute = {
            request: () => ({ resourceType: () => "media", url: () => "https://example.com/video.mp4" }),
            abort: mockAbort,
            continue: mockContinue
        };
        routeCallback(mockMediaRoute);
        expect(mockAbort).toHaveBeenCalledTimes(2);

        const mockValidRoute = {
            request: () => ({ resourceType: () => "document", url: () => "https://example.com/page.html" }),
            abort: mockAbort,
            continue: mockContinue
        };
        routeCallback(mockValidRoute);
        expect(mockContinue).toHaveBeenCalled();
    });

    it("should retry with fresh session on existing session connection error", async () => {
        const helper = new (await import("./browser.js")).StagehandBrowserHelper({ fetch: vi.fn().mockResolvedValue({ text: () => Promise.resolve("ok"), status: 200 }) });
        (helper as any).createStagehand = vi.fn().mockReturnValue(mockStagehand);
        vi.spyOn(helper as any, 'wait').mockResolvedValue(undefined);

        // Fails first attempt, succeeds second
        mockStagehand.init
            .mockRejectedValueOnce(new Error("Connection error"))
            .mockResolvedValueOnce(undefined);

        await expect(helper.init()).resolves.toBeUndefined();
        expect(mockStagehand.init).toHaveBeenCalledTimes(2);
    });

    it("should handle error in close()", async () => {
        const helper = new (await import("./browser.js")).StagehandBrowserHelper({ fetch: vi.fn().mockResolvedValue({ text: () => Promise.resolve("ok"), status: 200 }) });
        (helper as any).createStagehand = vi.fn().mockReturnValue(mockStagehand);
        vi.spyOn(helper as any, 'wait').mockResolvedValue(undefined);
        await helper.init();
        mockStagehand.close.mockRejectedValueOnce(new Error("Close error"));
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

        await expect(helper.close()).resolves.toBeUndefined();
        expect(warnSpy).toHaveBeenCalledWith("Error closing Stagehand:", "Close error");
        warnSpy.mockRestore();
    });

    it("should process limits information correctly in handleInitError", async () => {
        const puppeteer = await import("@cloudflare/puppeteer");
        puppeteer.default.limits = vi.fn().mockResolvedValue({
            activeSessions: [{ id: "mock-session-id" }],
            maxConcurrentSessions: 4,
            allowedBrowserAcquisitions: 1,
            timeUntilNextAllowedBrowserAcquisition: 0
        });

        const helper = new (await import("./browser.js")).StagehandBrowserHelper({ fetch: vi.fn().mockResolvedValue({ text: () => Promise.resolve("ok"), status: 200 }) });
        (helper as any).createStagehand = vi.fn().mockReturnValue(mockStagehand);
        vi.spyOn(helper as any, 'wait').mockResolvedValue(undefined);

        mockStagehand.init.mockRejectedValue(new Error("Unable to create new browser"));

        await expect(helper.init()).rejects.toThrow("Unable to create new browser - Cloudflare Limits: Active Sessions=1/4, Acquisitions Allowed=1, Time Until Next Acquisition=0ms");
    });
});
