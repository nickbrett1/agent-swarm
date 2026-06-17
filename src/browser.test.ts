import { describe, it, expect, vi, beforeEach } from "vitest";

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
  endpointURLString: vi.fn().mockReturnValue("wss://dummy-cdp-url"),
}));

const mockPage = {
  goto: vi.fn(),
  url: vi.fn().mockReturnValue("https://example.com"),
  evaluate: vi.fn(),
  locator: vi.fn(),
  frames: vi.fn().mockReturnValue([]),
  act: vi.fn(),
  waitForLoadState: vi.fn(),
};

const mockStagehand = {
  init: vi.fn(),
  close: vi.fn(),
  page: mockPage,
};

vi.mock("@browserbasehq/stagehand", () => {
  return {
    Stagehand: vi.fn().mockImplementation(function () {
      return mockStagehand;
    }),
    LLMClient: class {},
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

  describe("clearStaleSessions", () => {
    it("should return 0 if browserBinding.fetch is not a function", async () => {
      const helperWithoutFetch = new StagehandBrowserHelper({} as any, {}, "test-key");
      const result = await (helperWithoutFetch as any).clearStaleSessions();
      expect(result).toBe(0);
    });

    it("should return 0 if there are no active sessions", async () => {
      (puppeteer.sessions as any).mockResolvedValueOnce([]);
      const result = await (helper as any).clearStaleSessions();
      expect(result).toBe(0);
    });

    it("should delete stale sessions and return count", async () => {
      (puppeteer.sessions as any).mockResolvedValueOnce([
        { sessionId: "sess-1" },
        { id: "sess-2" },
      ]);
      const mockFetchText = vi.fn().mockResolvedValue("OK");
      mockBrowserBinding.fetch.mockResolvedValue({
        status: 200,
        text: mockFetchText,
      });

      const result = await (helper as any).clearStaleSessions();

      expect(result).toBe(2);
      expect(mockBrowserBinding.fetch).toHaveBeenCalledWith(
        "https://fake.host/v1/devtools/browser/sess-1",
        { method: "DELETE" }
      );
      expect(mockBrowserBinding.fetch).toHaveBeenCalledWith(
        "https://fake.host/v1/devtools/browser/sess-2",
        { method: "DELETE" }
      );
    });

    it("should handle session missing sessionId or id", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      (puppeteer.sessions as any).mockResolvedValueOnce([
        { someOtherField: "value" },
      ]);

      const result = await (helper as any).clearStaleSessions();

      expect(result).toBe(0);
      expect(warnSpy).toHaveBeenCalledWith(
        "Stale session has no sessionId or id:",
        JSON.stringify({ someOtherField: "value" })
      );

      warnSpy.mockRestore();
    });

    it("should return 0 and log error if clearing sessions throws", async () => {
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const error = new Error("Puppeteer sessions failed");
      (puppeteer.sessions as any).mockRejectedValueOnce(error);

      const result = await (helper as any).clearStaleSessions();

      expect(result).toBe(0);
      expect(errSpy).toHaveBeenCalledWith("Failed to clear stale sessions:", error);

      errSpy.mockRestore();
    });

    it("should handle error when fetching limits", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      (puppeteer.limits as any).mockRejectedValueOnce(new Error("Limits failed"));
      (puppeteer.sessions as any).mockResolvedValueOnce([]);

      const result = await (helper as any).clearStaleSessions();

      expect(result).toBe(0);
      expect(warnSpy).toHaveBeenCalledWith(
        "clearStaleSessions: Failed to fetch limits:",
        "Limits failed"
      );

      warnSpy.mockRestore();
    });
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

  it("should handle Stripe iframe using Stagehand act", async () => {
    await helper.init();
    mockPage.act.mockResolvedValueOnce(undefined);

    const success = await helper.handleStripeIframe("4242", "12/28", "123", "John");
    expect(success).toBe(true);
    expect(mockPage.act).toHaveBeenCalledWith('Fill the credit card number with "4242", expiration date with "12/28", CVC/CVV with "123", and cardholder name with "John"');
  });

  it("should fallback to Playwright frames filling if Stripe act fails", async () => {
    await helper.init();
    mockPage.act.mockRejectedValueOnce(new Error("Act failed"));

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
