import { Stagehand } from "@browserbasehq/stagehand";
import * as playwrightModule from "@cloudflare/playwright";
import type { BrowserType, Frame } from "@cloudflare/playwright";
import puppeteer from "@cloudflare/puppeteer";
import { AgentLLMClient } from "./agentLLMClient.js";
import { EXTRACT_ELEMENTS_SCRIPT } from "./scripts/extract-elements.js";

const endpointURLString = playwrightModule.endpointURLString;

const TRACKER_REGEX = /google-analytics\.com|googletagmanager\.com|doubleclick\.net|facebook\.net|hotjar\.com|mixpanel\.com|segment\.io/;


async function fillStripeLocators(frames: Frame[], card: string, expiry: string, cvc: string, name: string): Promise<{ cardFilled: boolean, expiryFilled: boolean, cvcFilled: boolean, nameFilled: boolean }> {
  let cardFilled = false;
  let expiryFilled = false;
  let cvcFilled = false;
  let nameFilled = false;

  const cardSelector = STRIPE_CARD_SELECTORS.join(',');
  const expirySelector = STRIPE_EXPIRY_SELECTORS.join(',');
  const cvcSelector = STRIPE_CVC_SELECTORS.join(',');
  const nameSelector = STRIPE_NAME_SELECTORS.join(',');

  for (const frame of frames) {
    try {
      if (!cardFilled) {
        const cardLoc = frame.locator(cardSelector);
        if (await cardLoc.count() > 0) {
          await cardLoc.first().fill(card);
          cardFilled = true;
        }
      }

      if (!expiryFilled) {
        const expiryLoc = frame.locator(expirySelector);
        if (await expiryLoc.count() > 0) {
          await expiryLoc.first().fill(expiry);
          expiryFilled = true;
        }
      }

      if (!cvcFilled) {
        const cvcLoc = frame.locator(cvcSelector);
        if (await cvcLoc.count() > 0) {
          await cvcLoc.first().fill(cvc);
          cvcFilled = true;
        }
      }

      if (!nameFilled) {
        const nameLoc = frame.locator(nameSelector);
        if (await nameLoc.count() > 0) {
          await nameLoc.first().fill(name);
          nameFilled = true;
        }
      }

      if (cardFilled && expiryFilled && cvcFilled && nameFilled) {
        break;
      }
    } catch (frameErr) {
      console.warn("Ignored frame specific error while filling Stripe:", frameErr);
    }
  }

  return { cardFilled, expiryFilled, cvcFilled, nameFilled };
}

function findNewestPage(context: any, currentPage: any): any {
  const pages = context?.pages();
  if (!pages || pages.length === 0) return currentPage;

  // Find the last opened page
  for (let i = pages.length - 1; i >= 0; i--) {
    const p = pages[i];
    if (p) {
      if (p !== currentPage) {
        console.log(`[StagehandBrowserHelper] Switching active page to newer tab: ${p.url()}`);
      }
      return p;
    }
  }

  return currentPage;
}




// Intercept playwright's chromium.connectOverCDP to ensure that when it connects to a remote browser,
// it always creates a browser context if none exists.
let lastCDPError: Error | null = null;
let chromium: BrowserType | undefined = undefined;
try {
  const mod = playwrightModule as { chromium?: BrowserType, default?: { chromium?: BrowserType } };
  chromium = mod.chromium || mod.default?.chromium;
} catch (e) {
  console.warn("Failed to load playwright module:", e instanceof Error ? e.message : String(e));
}

if (chromium?.connectOverCDP) {
  const originalConnectOverCDP = chromium.connectOverCDP;
  const patchedConnectOverCDP = async (...args: any[]) => {
    console.log("Patched connectOverCDP invoked");
    if (args.length > 0 && typeof args[0] === 'string') {
      try {
        const urlObj = new URL(args[0]);
        if (urlObj.search && urlObj.pathname.includes("/v1/devtools/browser/")) {
          console.log(`[connectOverCDP] Stripping query parameters from upgrade request: ${urlObj.search}`);
          urlObj.search = "";
          args[0] = urlObj.toString();
        }
      } catch (e) {
        console.warn("Ignored invalid endpointURL string in connectOverCDP wrapper:", e);
      }
    } else if (args.length > 0 && typeof args[0] === 'object' && args[0] !== null) {
      const endpointURL = args[0].endpointURL || args[0].wsEndpoint;
      if (endpointURL && typeof endpointURL === 'string') {
        try {
          const urlObj = new URL(endpointURL);
          if (urlObj.search && urlObj.pathname.includes("/v1/devtools/browser/")) {
            console.log(`[connectOverCDP] Stripping query parameters from upgrade request: ${urlObj.search}`);
            urlObj.search = "";
            if (args[0].endpointURL) args[0].endpointURL = urlObj.toString();
            if (args[0].wsEndpoint) args[0].wsEndpoint = urlObj.toString();
          }
        } catch (e) {
          console.warn("Ignored invalid endpointURL property in connectOverCDP wrapper:", e);
        }
      }
    }

    try {
      // Use spread syntax with call to avoid Vitest vi.fn().apply serialization/stack issues in tests.
      const browser = await originalConnectOverCDP.call(chromium, ...(args as unknown as [any]));
      // Remote/custom CDP connections in Cloudflare Workers do not initialize a default context.
      // We must ensure there is at least one context so that Stagehand doesn't encounter an undefined context.
      if (browser.contexts().length === 0) {
        console.log("No browser contexts found. Creating a new browser context...");
        await browser.newContext();
      }
      return browser;
    } catch (err) {
      if (err instanceof Error && (err.message.includes("accept") || err.message.includes("webSocket"))) {
        const newErr = new Error(`WebSocket upgrade failed in Playwright connectOverCDP: ${err.message}`);
        lastCDPError = newErr;
        throw newErr;
      }
      lastCDPError = err instanceof Error ? err : new Error(String(err));
      throw err;
    }
  };

  chromium.connectOverCDP = patchedConnectOverCDP as typeof chromium.connectOverCDP;
  try {
    const mod = playwrightModule as { default?: { chromium?: BrowserType } };
    const playwrightDefault = mod.default;
    if (playwrightDefault?.chromium) {
      playwrightDefault.chromium.connectOverCDP = patchedConnectOverCDP as typeof chromium.connectOverCDP;
    }
  } catch (e) {
    console.warn("Ignored error patching default connectOverCDP:", e);
  }
}

export interface InteractiveElement {
  id: string;
  tag: string;
  type?: string;
  text: string;
  placeholder?: string;
  name?: string;
  role?: string;
  xpath: string; // Used to locate the element dynamically
}

export interface ElementData {
  tag: string;
  type: string;
  text: string;
  placeholder: string;
  name: string;
  role: string;
  xpath: string;
}

// Selectors for Stripe Checkout inputs inside iframe/page
const STRIPE_CARD_SELECTORS = ["input#cardNumber", 'input[name="cardnumber"]', 'input[placeholder*="1234"]', 'input[aria-label*="Card number"]'];
const STRIPE_EXPIRY_SELECTORS = ["input#cardExpiry", 'input[name="exp-date"]', 'input[placeholder*="MM"]', 'input[aria-label*="Expiration"]'];
const STRIPE_CVC_SELECTORS = ["input#cardCvc", 'input[name="cvc"]', 'input[placeholder*="CVC"]', 'input[aria-label*="CVC"]'];
const STRIPE_NAME_SELECTORS = ["input#billingName", 'input[name="name"]', 'input[placeholder*="Name"]'];


export class StagehandBrowserHelper {
  private stagehand: Stagehand | null = null;
  private elementsMap: Map<string, string> = new Map(); // id -> xpath
  private interactiveElements: InteractiveElement[] = [];

  constructor(
    private readonly browserBinding: any,
    private readonly aiBinding?: any,
    private readonly apiKey?: string
  ) {}

  private async deleteSession(s: any): Promise<number> {
    const sessionId = s.sessionId || (s as { id?: string }).id;
    if (sessionId) {
      console.log(`Closing stale session: ${sessionId}`);
      const delRes = await this.browserBinding.fetch(`https://fake.host/v1/devtools/browser/${sessionId}`, {
        method: "DELETE",
      });
      const delText = await delRes.text();
      console.log(`Delete response for ${sessionId}: status=${delRes.status}, body=${delText}`);
      return 1;
    } else {
      console.warn("Stale session has no sessionId or id:", JSON.stringify(s));
      return 0;
    }
  }

  private async clearStaleSessions(): Promise<number> {
    console.log("clearStaleSessions check: browserBinding =", !!this.browserBinding, "fetch type =", this.browserBinding ? typeof this.browserBinding.fetch : "undefined");
    if (!this.browserBinding || typeof this.browserBinding.fetch !== "function") {
      return 0;
    }
    try {
      try {
        const limits = await puppeteer.limits(this.browserBinding);
        console.log("clearStaleSessions: Cloudflare limits:", JSON.stringify(limits));
      } catch (limitsErr) {
        console.warn("clearStaleSessions: Failed to fetch limits:", limitsErr instanceof Error ? limitsErr.message : String(limitsErr));
      }

      console.log("clearStaleSessions: Querying active sessions using puppeteer.sessions...");
      const sessions = await puppeteer.sessions(this.browserBinding);
      console.log(`clearStaleSessions: Active sessions response:`, JSON.stringify(sessions));
      if (!sessions || sessions.length === 0) {
        return 0;
      }
      const deletePromises = sessions.map((s) => this.deleteSession(s));
      const results = await Promise.all(deletePromises);
      return results.reduce((acc: number, curr: number) => acc + curr, 0);
    } catch (clearErr) {
      console.error("Failed to clear stale sessions:", clearErr);
    }
    return 0;
  }

  private async tryGetExistingSessionUrl(): Promise<string | null> {
    try {
      const sessions = await puppeteer.sessions(this.browserBinding);
      if (sessions && sessions.length > 0) {
        const sessionId = sessions[0].sessionId || (sessions[0] as { id?: string }).id;
        if (sessionId) {
          console.log(`Attempting to connect to existing session: ${sessionId}`);
          const rawUrl = endpointURLString(this.browserBinding, { sessionId });
          // Manually append browser_session to query parameters so that @cloudflare/playwright's
          // connectOverCDP override correctly routes to connect() instead of launch().
          const parsedUrl = new URL(rawUrl);
          parsedUrl.searchParams.set("browser_session", sessionId);
          return parsedUrl.toString();
        }
      }
    } catch (err) {
      console.warn("Failed to check existing sessions, using default cdpUrl:", err);
    }
    return null;
  }

  private createStagehand(url: string, llmClient: AgentLLMClient): Stagehand {
    return new Stagehand({
      env: "LOCAL",
      localBrowserLaunchOptions: {
        cdpUrl: url,
      },
      llmClient,
      model: {
        modelName: "google/gemini-2.0-flash",
        apiKey: this.apiKey || "dummy-key",
      },
      verbose: 1,
    });
  }

  private async setupBlocker(page: any): Promise<void> {
    if (page && typeof page.route === "function") {
      await page.route("**/*", (route: any) => {
        const request = route.request();
        const resourceType = request.resourceType();
        const url = request.url();

        const isTracker = TRACKER_REGEX.test(url);

        const isHeavyAsset =
          resourceType === "media" ||
          resourceType === "font";

        if (isTracker || isHeavyAsset) {
          route.abort();
        } else {
          route.continue();
        }
      });
    }
  }

  private async handleInitError(err: any): Promise<never> {
    const activeErr = lastCDPError || err;
    const errMsg = activeErr instanceof Error ? activeErr.message : String(activeErr);
    if (errMsg.includes("429") || errMsg.toLowerCase().includes("rate limit") || errMsg.includes("Unable to create new browser")) {
      let limitsInfo;
      try {
        limitsInfo = await puppeteer.limits(this.browserBinding);
      } catch (limitErr) {
        console.warn("Failed to fetch limits after rate limit error:", limitErr);
        throw activeErr;
      }
      throw new Error(`${errMsg} - Cloudflare Limits: Active Sessions=${limitsInfo.activeSessions ? limitsInfo.activeSessions.length : 0}/${limitsInfo.maxConcurrentSessions}, Acquisitions Allowed=${limitsInfo.allowedBrowserAcquisitions}, Time Until Next Acquisition=${limitsInfo.timeUntilNextAllowedBrowserAcquisition}ms`);
    }
    throw activeErr;
  }

  async init(): Promise<void> {
    console.log("Initializing Stagehand browser helper...");


    // 1. Clean up stale sessions
    const cleared = await this.clearStaleSessions();
    if (cleared > 0) {
      console.log("Waiting for sessions to close on Cloudflare (up to 10 seconds)...");
      let retries = 0;
      while (retries < 20) {
        try {
          const activeSessions = await puppeteer.sessions(this.browserBinding);
          if (!activeSessions || activeSessions.length === 0) {
            console.log("All stale sessions are closed.");
            break;
          }
        } catch (err) {
          console.warn("Error checking active sessions while waiting:", err);
        }
        await this.wait(500);
        retries++;
      }
    }

    // 2. Check for limits and build connection string
    const defaultCdpUrl = endpointURLString(this.browserBinding);
    let cdpUrl = defaultCdpUrl;
    let usingExistingSession = false;

    // Try to connect using existing sessions if available
    const existingUrl = await this.tryGetExistingSessionUrl();
    if (existingUrl) {
      cdpUrl = existingUrl;
      usingExistingSession = true;
    }

    const llmClient = new AgentLLMClient({
      binding: this.aiBinding,
      apiKey: this.apiKey,
      logger: (line) => console.log(`[LLMClient] ${line.category}: ${line.message}`),
    });

    this.stagehand = this.createStagehand(cdpUrl, llmClient);

    try {
      lastCDPError = null;
      await this.stagehand.init();
      await this.setupBlocker(this.getActivePage());
    } catch (err) {
      if (usingExistingSession) {
        console.warn("Failed to connect to existing session, retrying with a fresh session...", err);
        try {
          cdpUrl = defaultCdpUrl;
          lastCDPError = null;
          this.stagehand = this.createStagehand(cdpUrl, llmClient);
          await this.stagehand.init();
          await this.setupBlocker(this.getActivePage());
          return; // Success on retry
        } catch (retryErr) {
          err = retryErr;
        }
      }
      return this.handleInitError(err);
    }
  }

  async close(): Promise<void> {
    if (this.stagehand) {
      try {
        await this.stagehand.close();
      } catch (err) {
        console.warn("Error closing Stagehand:", err instanceof Error ? err.message : String(err));
      } finally {
        this.stagehand = null;
      }
    }
  }

  private getActivePage(): any {
    if (!this.stagehand) throw new Error("Browser not initialized");
    const currentPage = this.stagehand.context.activePage();
    try {
      const context = this.stagehand.context;
      return findNewestPage(context, currentPage);
    } catch (e) {
      console.warn("[StagehandBrowserHelper] Failed to inspect pages in context:", e);
    }
    return currentPage;
  }

  async goto(url: string): Promise<void> {
    if (!this.stagehand) throw new Error("Browser not initialized");
    console.log(`Navigating to ${url}...`);
    await this.getActivePage().goto(url, { waitUntil: "domcontentloaded" });
  }

  async getPageUrl(): Promise<string> {
    if (!this.stagehand) return "";
    try {
      return this.getActivePage().url();
    } catch {
      return "";
    }
  }

  async waitForUrlChange(startUrl: string, timeout: number = 12000): Promise<boolean> {
    if (!this.stagehand) return false;
    const page = this.getActivePage();
    try {
      await page.waitForURL((url: URL) => url.href !== startUrl, { timeout, waitUntil: "load" });
      return true;
    } catch (err) {
      console.warn("Ignored error waiting for URL change:", err);
      return false;
    }
  }

  private async extractElementsWithRetry(page: playwrightModule.Page): Promise<{
    success: boolean;
    data?: ElementData[];
    fallbackResponse?: { elements: InteractiveElement[]; textSummary: string };
  }> {
    let elementsData: ElementData[] = [];
    let attempts = 0;
    const maxAttempts = 3;

    while (attempts < maxAttempts) {
      try {
        elementsData = await page.evaluate(EXTRACT_ELEMENTS_SCRIPT);
        return { success: true, data: elementsData };
      } catch (err) {
        attempts++;
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`Evaluation attempt ${attempts} failed:`, message);
        
        const isClosedError = message.toLowerCase().includes("closed") || 
                              message.toLowerCase().includes("connection lost") || 
                              message.toLowerCase().includes("lost");
        if (isClosedError) {
          throw err;
        }
        
        try {
          await page.waitForLoadState("load", { timeout: 2000 });
        } catch (waitErr) {
          console.warn("Ignored error waiting for load state:", waitErr);
        }

        try {
          await page.frames();
        } catch (framesErr) {
          console.warn("Ignored error getting frames:", framesErr);
        }

        try {
          const url = await this.getPageUrl();
          if (url) {
            const lowerUrl = url.toLowerCase();
            if (lowerUrl.includes("success") ||
                lowerUrl.includes("thank") ||
                lowerUrl.includes("complete") ||
                lowerUrl.includes("confirm") ||
                lowerUrl.includes("receipt") ||
                lowerUrl.includes("order")) {
              console.log("Success/thank-you/order page detected during error. Returning dummy response.");
              return {
                success: false,
                fallbackResponse: {
                  elements: [],
                  textSummary: `Redirected to success page: ${url}`
                }
              };
            }
          }
        } catch (urlErr) {
          const urlErrMsg = urlErr instanceof Error ? urlErr.message : String(urlErr);
          console.warn("Failed to get page URL in evaluation catch block:", urlErrMsg);
        }

        if (attempts >= maxAttempts) {
          const isDetachedFrameError = message.toLowerCase().includes("detached") || 
                                       message.toLowerCase().includes("destroyed") || 
                                       message.toLowerCase().includes("context");
          if (isDetachedFrameError) {
            console.error(`Persistent detached frame error after ${maxAttempts} attempts. Returning empty elements to allow settle/cooldown.`);
            return {
              success: false,
              fallbackResponse: {
                elements: [],
                textSummary: `Warning: Browser is in a transient detached frame state. Waiting for recovery...`
              }
            };
          }
          throw err;
        }
        console.log("Waiting 2 seconds for navigation/redirect to settle before retrying...");
        await this.wait(2000);
      }
    }
    return { success: true, data: elementsData };
  }

  /**
   * Scrapes the page, extracts interactive elements, and creates an element map.
   */
  async getInteractiveElements(): Promise<{ elements: InteractiveElement[]; textSummary: string }> {
    if (!this.stagehand) throw new Error("Browser not initialized");

    const page = this.getActivePage();

    const result = await this.extractElementsWithRetry(page);
    if (!result.success && result.fallbackResponse) {
      return result.fallbackResponse;
    }
    const elementsData = result.data || [];

    this.elementsMap.clear();
    const elements: InteractiveElement[] = [];

    elementsData.forEach((el, index) => {
      const id = `${el.tag}_${index}`;
      this.elementsMap.set(id, el.xpath);
      elements.push({
        id,
        tag: el.tag,
        type: el.type,
        text: el.text,
        placeholder: el.placeholder,
        name: el.name,
        role: el.role,
        xpath: el.xpath
      });
    });

    this.interactiveElements = elements;

    // Generate a clean text summary of the page for the LLM to inspect
    const summaryParts: string[] = [`Current Page URL: ${page.url()}\nInteractive elements found:`];
    if (elements.length === 0) {
      summaryParts.push("(No interactive elements found. The page might still be loading or has no clickable items.)");
    } else {
      for (let i = 0; i < elements.length; i++) {
        const el = elements[i];
        let details = "";
        if (el.text) details += `text: "${el.text}"`;
        if (el.placeholder) details += (details ? ", " : "") + `placeholder/label: "${el.placeholder}"`;
        if (el.name) details += (details ? ", " : "") + `name: "${el.name}"`;

        summaryParts.push(`- [${el.id}] <${el.tag}${el.type ? " type=" + el.type : ""}>${details ? ` (${details})` : ""}`);
      }
    }
    const textSummary = summaryParts.join("\n") + "\n";

    return { elements, textSummary };
  }

  private getElementDescription(el: InteractiveElement): string {
    let description = `the ${el.tag}`;
    if (el.text) {
      description += ` with text "${el.text}"`;
    } else if (el.placeholder) {
      description += ` with placeholder/label "${el.placeholder}"`;
    } else if (el.name) {
      description += ` with name "${el.name}"`;
    } else if (el.role) {
      description += ` with role "${el.role}"`;
    } else {
      description += ` located at xpath "${el.xpath}"`;
    }
    return description;
  }

  /**
   * Clicks an element by its interactive ID.
   */
  async clickElement(id: string): Promise<boolean> {
    if (!this.stagehand) throw new Error("Browser not initialized");
    const page = this.getActivePage();
    const el = this.interactiveElements.find(e => e.id === id);
    if (!el) {
      console.warn(`Element ID ${id} not found in map`);
      return false;
    }

    console.log(`Clicking element: ${id} (XPath: ${el.xpath})`);
    try {
      const instruction = `Click ${this.getElementDescription(el)}`;
      await page.act(instruction);
      return true;
    } catch (err) {
      console.warn(`Stagehand act click failed for ${id}, attempting Playwright fallback...`, err);
      try {
        await page.locator(`xpath=${el.xpath}`).click({ timeout: 5000 });
        return true;
      } catch (fallbackErr) {
        console.error(`Playwright fallback click failed for ${id}:`, fallbackErr);
        try {
          const clicked = await page.evaluate((xp: string) => {
            const res = document.evaluate(xp, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
            const node = res.singleNodeValue as HTMLElement;
            if (node) {
              node.scrollIntoView({ block: "center" });
              node.click();
              return true;
            }
            return false;
          }, el.xpath);
          return clicked;
        } catch (evalErr) {
          console.error(`Eval fallback click failed for ${id}:`, evalErr);
          return false;
        }
      }
    }
  }

  /**
   * Inputs text into an input field by its interactive ID.
   */
  async typeElement(id: string, text: string): Promise<boolean> {
    if (!this.stagehand) throw new Error("Browser not initialized");
    const page = this.getActivePage();
    const el = this.interactiveElements.find(e => e.id === id);
    if (!el) {
      console.warn(`Element ID ${id} not found in map`);
      return false;
    }

    console.log(`Typing "${text}" into element: ${id}`);
    try {
      const instruction = `Type "${text}" into ${this.getElementDescription(el)}`;
      await page.act(instruction);
      return true;
    } catch (err) {
      console.warn(`Stagehand act type failed for ${id}, attempting Playwright fallback...`, err);
      try {
        const locator = page.locator(`xpath=${el.xpath}`);
        await locator.fill(text, { timeout: 5000 });
        return true;
      } catch (fallbackErr) {
        console.error(`Playwright fallback type failed for ${id}:`, fallbackErr);
        return false;
      }
    }
  }

  /**
   * Dynamic fallback logic to auto-fill Stripe Checkout iframe.
   */
  async handleStripeIframe(card: string, expiry: string, cvc: string, name: string): Promise<boolean> {
    if (!this.stagehand) throw new Error("Browser not initialized");
    const page = this.getActivePage();

    console.log("Filling Stripe Checkout inputs using Playwright locator...");
    let cardFilled = false;
    let expiryFilled = false;
    let cvcFilled = false;
    let nameFilled = false;

    try {
      const frames = page.frames();
      const result = await fillStripeLocators(frames, card, expiry, cvc, name);
      cardFilled = result.cardFilled;
      expiryFilled = result.expiryFilled;
      cvcFilled = result.cvcFilled;
      nameFilled = result.nameFilled;
    } catch (err) {
      console.warn("Playwright direct Stripe fill encountered an error:", err);
    }

    console.log(`Stripe Playwright fill summary: Card=${cardFilled}, Expiry=${expiryFilled}, CVC=${cvcFilled}, Name=${nameFilled}`);

    if (cardFilled && expiryFilled && cvcFilled) {
      console.log("Stripe details successfully filled via Playwright.");
      return true;
    }

    console.log("Fallback to Stagehand act for Stripe...");
    try {
      await page.act({
        action: `Fill the credit card checkout form with this testing card information: card number <card>, expiry <expiry>, cvc <cvc>, and name <name>. Submit the form if there is a button.`,
        variables: {
          card,
          expiry,
          cvc,
          name
        }
      });
      return true;
    } catch (err) {
      console.error("Stagehand fallback act for Stripe failed:", err);
      return false;
    }
  }

  async wait(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
}
