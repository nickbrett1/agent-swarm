import { Stagehand } from "@browserbasehq/stagehand";
import * as playwrightModule from "@cloudflare/playwright";
import puppeteer from "@cloudflare/puppeteer";
import { env as workersEnv } from "cloudflare:workers";
import { AgentLLMClient } from "./agentLLMClient.js";

const endpointURLString = playwrightModule.endpointURLString;

// Intercept playwright's chromium.connectOverCDP to ensure that when it connects to a remote browser,
// it always creates a browser context if none exists.
let lastCDPError: Error | null = null;
let chromium: any = undefined;
try {
  chromium = (playwrightModule as any).chromium || (playwrightModule as any).default?.chromium;
} catch (e) {
  // Ignored in tests where @cloudflare/playwright is mocked without chromium
}

if (chromium && chromium.connectOverCDP) {
  const originalConnectOverCDP = chromium.connectOverCDP;
  const patchedConnectOverCDP = async (endpointURLOrOptions: any, options?: any) => {
    console.log("Patched connectOverCDP invoked");
    try {
      const browser = await originalConnectOverCDP.call(chromium, endpointURLOrOptions, options);
      // Remote/custom CDP connections in Cloudflare Workers do not initialize a default context.
      // We must ensure there is at least one context so that Stagehand doesn't encounter an undefined context.
      if (browser.contexts().length === 0) {
        console.log("No browser contexts found. Creating a new browser context...");
        await browser.newContext();
      }
      return browser;
    } catch (err) {
      lastCDPError = err instanceof Error ? err : new Error(String(err));
      throw err;
    }
  };

  chromium.connectOverCDP = patchedConnectOverCDP;
  try {
    const playwrightDefault = (playwrightModule as any).default;
    if (playwrightDefault && playwrightDefault.chromium) {
      playwrightDefault.chromium.connectOverCDP = patchedConnectOverCDP;
    }
  } catch (e) {
    // Ignored
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
    private browserBinding: any,
    private aiBinding?: any,
    private apiKey?: string
  ) {}

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
      const deletePromises = sessions.map(async (s) => {
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
      });
      const results = await Promise.all(deletePromises);
      return results.reduce((acc: number, curr: number) => acc + curr, 0);
    } catch (clearErr) {
      console.error("Failed to clear stale sessions:", clearErr);
    }
    return 0;
  }

  async init(): Promise<void> {
    console.log("Initializing Stagehand browser helper...");

    // Patch global env.MYBROWSER to intercept and handle WebSocket upgrade failures gracefully
    try {
      const wEnv = workersEnv as any;
      console.log("workersEnv status:", !!wEnv, "MYBROWSER:", wEnv ? !!wEnv.MYBROWSER : "no env", "keys:", wEnv ? Object.keys(wEnv) : []);
      if (wEnv && wEnv.MYBROWSER) {
        const browser = wEnv.MYBROWSER;
        const originalFetch = browser.fetch;
        if (originalFetch && !originalFetch.__isPatched) {
          console.log("Attempting to patch browser.fetch directly...");
          const patchedFetch = Object.assign(
            async function(request: any, init?: any) {
              let urlStr = "";
              if (typeof request === "string") {
                urlStr = request;
              } else if (request && typeof request === "object") {
                if (typeof request.toString === "function") {
                  urlStr = request.toString();
                } else {
                  urlStr = request.url || "";
                }
              }
              let method = "GET";
              if (init && init.method) {
                method = init.method;
              } else if (request && typeof request === "object" && "method" in request) {
                method = request.method || "GET";
              }

              // Strip query parameters for v1/devtools/browser/ upgrade requests as the API returns a 400 validation error
              if (urlStr.includes("/v1/devtools/browser/") && method.toUpperCase() !== "DELETE") {
                try {
                  const urlObj = new URL(urlStr);
                  if (urlObj.search !== "") {
                    console.log(`[MYBROWSER.fetch] Stripping query parameters from upgrade request: ${urlObj.search}`);
                    urlObj.search = "";
                    if (typeof request === "string") {
                      request = urlObj.toString();
                    } else if (request instanceof URL) {
                      request = urlObj;
                    } else {
                      request = urlObj;
                    }
                    urlStr = urlObj.toString();
                  }
                } catch (e) {
                  console.error("[MYBROWSER.fetch] Failed to strip query parameters:", e);
                }
              }

              console.log(`[MYBROWSER.fetch] request: ${urlStr} [${method}]`);
              try {
                const response = await originalFetch.call(browser, request, init);
                if (urlStr.includes("/v1/devtools/browser/") && method.toUpperCase() !== "DELETE" && !response.webSocket) {
                  const status = response.status;
                  const text = await response.text().catch(() => "");
                  console.error(`[MYBROWSER.fetch] WebSocket upgrade failed. Status: ${status}, Body: ${text}`);
                  throw new Error(`WebSocket upgrade failed: status ${status}, message: ${text}`);
                }
                return response;
              } catch (err) {
                console.error("[MYBROWSER.fetch] Error during fetch:", err);
                throw err;
              }
            },
            { __isPatched: true }
          );
          browser.fetch = patchedFetch;
          console.log("browser.fetch patched directly successfully!");
        }
      }
    } catch (e) {
      console.error("Error patching workersEnv.MYBROWSER:", e);
    }

    // 1. Clean up stale sessions
    const cleared = await this.clearStaleSessions();
    if (cleared > 0) {
      console.log("Waiting 10 seconds for sessions to close on Cloudflare...");
      await new Promise((resolve) => setTimeout(resolve, 10000));
    }

    // 2. Check for limits and build connection string
    const defaultCdpUrl = endpointURLString(this.browserBinding);
    let cdpUrl = defaultCdpUrl;
    let usingExistingSession = false;

    // Try to connect using existing sessions if available
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
          cdpUrl = parsedUrl.toString();
          usingExistingSession = true;
        }
      }
    } catch (err) {
      console.warn("Failed to check existing sessions, using default cdpUrl:", err);
    }

    const llmClient = new AgentLLMClient({
      binding: this.aiBinding,
      apiKey: this.apiKey,
      logger: (line) => console.log(`[LLMClient] ${line.category}: ${line.message}`),
    });

    const createStagehand = (url: string) => {
      return new Stagehand({
        env: "LOCAL",
        localBrowserLaunchOptions: {
          cdpUrl: url,
        },
        llmClient,
        modelName: "google/gemini-2.0-flash",
        modelClientOptions: {
          apiKey: this.apiKey || "dummy-key",
        },
        verbose: 1,
      });
    };

    const setupBlocker = async (page: any) => {
      if (page && typeof page.route === "function") {
        await page.route("**/*", (route: any) => {
          const request = route.request();
          const resourceType = request.resourceType();
          const url = request.url();

          const isTracker = 
            url.includes("google-analytics.com") ||
            url.includes("googletagmanager.com") ||
            url.includes("doubleclick.net") ||
            url.includes("facebook.net") ||
            url.includes("hotjar.com") ||
            url.includes("mixpanel.com") ||
            url.includes("segment.io");

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
    };

    this.stagehand = createStagehand(cdpUrl);

    try {
      lastCDPError = null;
      await this.stagehand.init();
      await setupBlocker(this.getActivePage());
    } catch (err) {
      if (usingExistingSession) {
        console.warn("Failed to connect to existing session, retrying with a fresh session...", err);
        try {
          cdpUrl = defaultCdpUrl;
          usingExistingSession = false;
          lastCDPError = null;
          this.stagehand = createStagehand(cdpUrl);
          await this.stagehand.init();
          await setupBlocker(this.getActivePage());
          return; // Success on retry
        } catch (retryErr) {
          err = retryErr;
        }
      }

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
    const currentPage = this.stagehand.page;
    try {
      const context = this.stagehand.context;
      if (context) {
        const pages = context.pages();
        if (pages && pages.length > 0) {
          // Find the last opened page that is not closed
          for (let i = pages.length - 1; i >= 0; i--) {
            const p = pages[i];
            if (p && !p.isClosed()) {
              if (p !== currentPage) {
                console.log(`[StagehandBrowserHelper] Switching active page to newer tab: ${p.url()}`);
              }
              return p;
            }
          }
        }
      }
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

  /**
   * Scrapes the page, extracts interactive elements, and creates an element map.
   */
  async getInteractiveElements(): Promise<{ elements: InteractiveElement[]; textSummary: string }> {
    if (!this.stagehand) throw new Error("Browser not initialized");

    const page = this.getActivePage();
    let elementsData: ElementData[] = [];
    let attempts = 0;
    const maxAttempts = 3;

    while (attempts < maxAttempts) {
      try {
        elementsData = await page.evaluate(() => {
          function getXPath(element: Element): string {
            if (element.id) {
              return `//*[@id="${element.id}"]`;
            }
            const paths: string[] = [];
            let current: Node | null = element;
            while (current && current.nodeType === Node.ELEMENT_NODE) {
              let index = 0;
              let hasSiblingWithSameTag = false;
              
              let prevSibling = current.previousSibling;
              while (prevSibling) {
                if (prevSibling.nodeType !== Node.DOCUMENT_TYPE_NODE && prevSibling.nodeName === current.nodeName) {
                  index++;
                  hasSiblingWithSameTag = true;
                }
                prevSibling = prevSibling.previousSibling;
              }
              
              let nextSibling = current.nextSibling;
              while (nextSibling) {
                if (nextSibling.nodeName === current.nodeName) {
                  hasSiblingWithSameTag = true;
                  break;
                }
                nextSibling = nextSibling.nextSibling;
              }
              
              const tagName = current.nodeName.toLowerCase();
              const pathIndex = hasSiblingWithSameTag ? `[${index + 1}]` : "";
              paths.unshift(tagName + pathIndex);
              current = current.parentNode;
            }
            return paths.length ? "/" + paths.join("/") : "";
          }

          function isVisible(el: HTMLElement): boolean {
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) return false;
            const style = window.getComputedStyle(el);
            if (style.display === "none" || style.visibility === "hidden" || parseFloat(style.opacity) === 0) return false;
            return true;
          }

          // @ts-ignore
          function isDisabled(el: HTMLElement): boolean {
            if ((el as HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement).disabled) return true;
            if (el.getAttribute("aria-disabled") === "true") return true;
            if (el.classList.contains("disabled")) return true;
            return false;
          }

          function getCleanText(el: HTMLElement): string {
            let text = (el.innerText || el.textContent || "").trim();
            if (!text && el.tagName === "INPUT") {
              text = (el as HTMLInputElement).value || "";
            }
            if (text.length > 80) {
              text = text.substring(0, 77) + "...";
            }
            return text;
          }

          function extractElementData(el: HTMLElement): ElementData {
            return {
              tag: el.tagName.toLowerCase(),
              type: (el as HTMLInputElement).type || "",
              text: getCleanText(el),
              placeholder: (el as HTMLInputElement).placeholder || el.getAttribute("aria-label") || "",
              name: el.getAttribute("name") || el.getAttribute("id") || "",
              role: el.getAttribute("role") || "",
              xpath: getXPath(el)
            };
          }

          const results: ElementData[] = [];
          const selector = 'button, a, input, select, textarea, [role="button"], [onclick]';
          const nodes = document.querySelectorAll(selector);

          nodes.forEach((node) => {
            const el = node as HTMLElement;
            if (!isVisible(el) || isDisabled(el)) return;
            results.push(extractElementData(el));
          });

          return results;
        });
        break; // Success, break out of loop
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
        } catch {
          // Ignore
        }

        try {
          await page.frames();
        } catch (e) {
          // Ignore
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
                elements: [], 
                textSummary: `Redirected to success page: ${url}`
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
              elements: [],
              textSummary: `Warning: Browser is in a transient detached frame state. Waiting for recovery...`
            };
          }
          throw err;
        }
        console.log("Waiting 2 seconds for navigation/redirect to settle before retrying...");
        await this.wait(2000);
      }
    }

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
    let textSummary = `Current Page URL: ${page.url()}\nInteractive elements found:\n`;
    if (elements.length === 0) {
      textSummary += "(No interactive elements found. The page might still be loading or has no clickable items.)\n";
    } else {
      textSummary += elements.map((el) => {
        const labelParts: string[] = [];
        if (el.text) labelParts.push(`text: "${el.text}"`);
        if (el.placeholder) labelParts.push(`placeholder/label: "${el.placeholder}"`);
        if (el.name) labelParts.push(`name: "${el.name}"`);
        const details = labelParts.length > 0 ? ` (${labelParts.join(", ")})` : "";
        return `- [${el.id}] <${el.tag}${el.type ? " type=" + el.type : ""}>${details}`;
      }).join("\n") + "\n";
    }

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
      for (const frame of frames) {
        try {
          for (const sel of STRIPE_CARD_SELECTORS) {
            const loc = frame.locator(sel);
            if (await loc.count() > 0) {
              await loc.fill(card);
              cardFilled = true;
              break;
            }
          }
          for (const sel of STRIPE_EXPIRY_SELECTORS) {
            const loc = frame.locator(sel);
            if (await loc.count() > 0) {
              await loc.fill(expiry);
              expiryFilled = true;
              break;
            }
          }
          for (const sel of STRIPE_CVC_SELECTORS) {
            const loc = frame.locator(sel);
            if (await loc.count() > 0) {
              await loc.fill(cvc);
              cvcFilled = true;
              break;
            }
          }
          for (const sel of STRIPE_NAME_SELECTORS) {
            const loc = frame.locator(sel);
            if (await loc.count() > 0) {
              await loc.fill(name);
              nameFilled = true;
              break;
            }
          }
        } catch (e) {
          // Ignore frame specific errors
        }
      }
    } catch (err) {
      console.warn("Playwright direct Stripe fill encountered an error:", err);
    }

    console.log(`Stripe Playwright fill summary: Card=${cardFilled}, Expiry=${expiryFilled}, CVC=${cvcFilled}, Name=${nameFilled}`);

    if (cardFilled && expiryFilled && cvcFilled) {
      console.log("Stripe details successfully filled via Playwright.");
      return true;
    }

    console.log("Playwright direct fill was incomplete. Falling back to Stagehand act...");
    try {
      const instruction = `Fill the credit card number with "${card}", expiration date with "${expiry}", CVC/CVV with "${cvc}", and cardholder name with "${name}"`;
      await page.act(instruction);
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
