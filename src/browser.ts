import puppeteer, { Browser, Page, Frame, BrowserWorker } from "@cloudflare/puppeteer";

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
const STRIPE_CARD_SELECTORS = ['input#cardNumber', 'input[name="cardnumber"]', 'input[placeholder*="1234"]', 'input[aria-label*="Card number"]'];
const STRIPE_EXPIRY_SELECTORS = ['input#cardExpiry', 'input[name="exp-date"]', 'input[placeholder*="MM"]', 'input[aria-label*="Expiration"]'];
const STRIPE_CVC_SELECTORS = ['input#cardCvc', 'input[name="cvc"]', 'input[placeholder*="CVC"]', 'input[aria-label*="CVC"]'];
const STRIPE_NAME_SELECTORS = ['input#billingName', 'input[name="name"]', 'input[placeholder*="Name"]'];

export class PuppeteerBrowserHelper {
  private browser: Browser | null = null;
  private page: Page | null = null;
  private elementsMap: Map<string, string> = new Map(); // id -> xpath

  constructor(private browserBinding: BrowserWorker) {}

  private async clearStaleSessions(): Promise<number> {
    console.log("clearStaleSessions check: browserBinding =", !!this.browserBinding, "fetch type =", this.browserBinding ? typeof this.browserBinding.fetch : "undefined");
    if (!this.browserBinding || typeof this.browserBinding.fetch !== 'function') {
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
      let clearedCount = 0;
      for (const s of sessions) {
        const sessionId = s.sessionId || (s as { id?: string }).id;
        if (sessionId) {
          console.log(`Closing stale session: ${sessionId}`);
          const delRes = await this.browserBinding.fetch(`https://fake.host/v1/devtools/browser/${sessionId}`, {
            method: "DELETE",
          });
          const delText = await delRes.text();
          console.log(`Delete response for ${sessionId}: status=${delRes.status}, body=${delText}`);
          clearedCount++;
        } else {
          console.warn("Stale session has no sessionId or id:", JSON.stringify(s));
        }
      }
      return clearedCount;
    } catch (clearErr) {
      console.error("Failed to clear stale sessions:", clearErr);
    }
    return 0;
  }

  async init(): Promise<void> {
    console.log("Initializing browser helper...");

    // 1. Try to reuse an existing session if available
    if (this.browserBinding && typeof this.browserBinding.fetch === 'function') {
      try {
        console.log("Checking for existing active sessions to reuse...");
        const sessions = await puppeteer.sessions(this.browserBinding);
        if (sessions && sessions.length > 0) {
          const sessionId = sessions[0].sessionId || (sessions[0] as { id?: string }).id;
          if (sessionId) {
            console.log(`Attempting to connect to existing session: ${sessionId}`);
            this.browser = await puppeteer.connect(this.browserBinding, sessionId);
            console.log("Successfully connected to existing session.");
          }
        }
      } catch (connectErr) {
        console.warn("Failed to connect to existing session, will clear and launch new:", connectErr instanceof Error ? connectErr.message : String(connectErr));
      }
    }

    // 2. If no browser is connected yet, clean up and launch a new one
    if (!this.browser) {
      console.log("No reusable session connected. Clearing stale sessions and launching new...");
      const cleared = await this.clearStaleSessions();
      if (cleared > 0) {
        console.log("Waiting 10 seconds for sessions to close on Cloudflare...");
        await new Promise((resolve) => setTimeout(resolve, 10000));
      }

      try {
        this.browser = await puppeteer.launch(this.browserBinding, { keep_alive: 10000 });
      } catch (err) {
        console.warn("Failed to launch Puppeteer session initially. Retrying cleanup...", err instanceof Error ? err.message : String(err));

        const retryCleared = await this.clearStaleSessions();
        if (retryCleared > 0) {
          console.log("Waiting 10 seconds for sessions to close on Cloudflare before retry...");
          await new Promise((resolve) => setTimeout(resolve, 10000));
        }

        console.log("Retrying launch after clearing sessions...");
        try {
          this.browser = await puppeteer.launch(this.browserBinding, { keep_alive: 10000 });
        } catch (retryErr) {
          const errMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
          if (errMsg.includes("429") || errMsg.toLowerCase().includes("rate limit") || errMsg.includes("Unable to create new browser")) {
            let limitsInfo;
            try {
              limitsInfo = await puppeteer.limits(this.browserBinding);
            } catch (limitErr) {
              console.warn("Failed to fetch limits after rate limit error:", limitErr);
              throw retryErr;
            }
            throw new Error(`${errMsg} - Cloudflare Limits: Active Sessions=${limitsInfo.activeSessions ? limitsInfo.activeSessions.length : 0}/${limitsInfo.maxConcurrentSessions}, Acquisitions Allowed=${limitsInfo.allowedBrowserAcquisitions}, Time Until Next Acquisition=${limitsInfo.timeUntilNextAllowedBrowserAcquisition}ms`);
          }
          throw retryErr;
        }
      }
    }

    // 3. Set up the page and request interception
    this.page = await this.browser.newPage();
    await this.page.setViewport({ width: 1280, height: 720 });
    this.page.setDefaultTimeout(15000);

    // Block unnecessary requests (images, media, fonts) to save bandwidth and execution time
    try {
      await this.page.setRequestInterception(true);
      this.page.on("request", (req) => {
        const resourceType = req.resourceType();
        if (["image", "media", "font"].includes(resourceType)) {
          req.abort();
        } else {
          req.continue();
        }
      });
    } catch (interceptErr) {
      console.warn("Failed to enable request interception:", interceptErr);
    }
  }

  async close(): Promise<void> {
    if (this.browser) {
      try {
        if (typeof this.browser.disconnect === 'function') {
          console.log("Disconnecting from browser session (keeping it alive for reuse)...");
          await this.browser.disconnect();
        } else {
          console.log("Closing browser session...");
          await this.browser.close();
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn("Ignoring error closing/disconnecting browser:", message);
      } finally {
        this.browser = null;
        this.page = null;
      }
    }
  }

  async goto(url: string): Promise<void> {
    if (!this.page) throw new Error("Browser not initialized");
    console.log(`Navigating to ${url}...`);
    await this.page.goto(url, { waitUntil: "domcontentloaded" });
  }

  async getPageUrl(): Promise<string> {
    return this.page ? this.page.url() : "";
  }

  /**
   * Scrapes the page, extracts interactive elements, and creates an element map.
   */
  async getInteractiveElements(): Promise<{ elements: InteractiveElement[]; textSummary: string }> {
    if (!this.page) throw new Error("Browser not initialized");

    let elementsData: ElementData[] = [];
    let attempts = 0;
    const maxAttempts = 3;

    while (attempts < maxAttempts) {
      try {
        // We execute a script in the browser context to find and label interactive elements
        elementsData = await this.page.evaluate(() => {
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
              const pathIndex = hasSiblingWithSameTag ? `[${index + 1}]` : '';
              paths.unshift(tagName + pathIndex);
              current = current.parentNode;
            }
            return paths.length ? '/' + paths.join('/') : '';
          }

          function isVisible(el: HTMLElement): boolean {
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) return false;
            const style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) === 0) return false;
            return true;
          }

          function isDisabled(el: HTMLElement): boolean {
            if ((el as HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement).disabled) return true;
            if (el.getAttribute('aria-disabled') === 'true') return true;
            if (el.classList.contains('disabled')) return true;
            return false;
          }

          function getCleanText(el: HTMLElement): string {
            let text = (el.innerText || el.textContent || '').trim();
            if (!text && el.tagName === 'INPUT') {
              text = (el as HTMLInputElement).value || '';
            }
            if (text.length > 80) {
              text = text.substring(0, 77) + "...";
            }
            return text;
          }

          function extractElementData(el: HTMLElement): ElementData {
            return {
              tag: el.tagName.toLowerCase(),
              type: (el as HTMLInputElement).type || '',
              text: getCleanText(el),
              placeholder: (el as HTMLInputElement).placeholder || el.getAttribute('aria-label') || '',
              name: el.getAttribute('name') || el.getAttribute('id') || '',
              role: el.getAttribute('role') || '',
              xpath: getXPath(el)
            };
          }

          const results: ElementData[] = [];
          const selector = 'button, a, input, select, textarea, [role="button"], [onclick]';
          const nodes = Array.from(document.querySelectorAll(selector));

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
        
        // Wait for page to finish navigating/loading if in progress
        try {
          if (this.page) {
            await this.page.waitForNavigation({ waitUntil: "load", timeout: 2000 });
          }
        } catch {
          // Ignore timeout or other errors during navigation wait, as they are expected
        }

        try {
          const url = await this.getPageUrl();
          if (url && (url.toLowerCase().includes("success") || 
              url.toLowerCase().includes("thank") || 
              url.toLowerCase().includes("complete"))) {
            console.log("Success/thank-you page detected during error. Returning dummy response.");
            return { 
              elements: [], 
              textSummary: `Redirected to success page: ${url}` 
            };
          }
        } catch (urlErr) {
          const urlErrMsg = urlErr instanceof Error ? urlErr.message : String(urlErr);
          console.warn("Failed to get page URL in evaluation catch block:", urlErrMsg);
        }
        
        if (attempts >= maxAttempts) {
          throw err;
        }
        console.log("Waiting 2 seconds for navigation/redirect to settle before retrying...");
        await this.wait(2000);
      }
    }

    this.elementsMap.clear();
    const elements: InteractiveElement[] = [];

    // Assign clean sequential IDs and update our mapping map
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

    // Generate a clean text summary of the page for the LLM to inspect
    let textSummary = `Current Page URL: ${this.page.url()}\nInteractive elements found:\n`;
    if (elements.length === 0) {
      textSummary += "(No interactive elements found. The page might still be loading or has no clickable items.)\n";
    } else {
      textSummary += elements.map((el) => {
        const labelParts: string[] = [];
        if (el.text) labelParts.push(`text: "${el.text}"`);
        if (el.placeholder) labelParts.push(`placeholder/label: "${el.placeholder}"`);
        if (el.name) labelParts.push(`name: "${el.name}"`);
        const details = labelParts.length > 0 ? ` (${labelParts.join(', ')})` : '';
        return `- [${el.id}] <${el.tag}${el.type ? ' type=' + el.type : ''}>${details}`;
      }).join('\n') + '\n';
    }

    return { elements, textSummary };
  }

  /**
   * Helper method to look up an element by ID and fetch its Handle and XPath.
   */
  private async findElement(id: string) {
    if (!this.page) throw new Error("Browser not initialized");
    const xpath = this.elementsMap.get(id);
    if (!xpath) {
      console.warn(`Element ID ${id} not found in map`);
      return null;
    }
    try {
      const elements = await this.page.$$(`xpath/${xpath}`);
      if (elements.length === 0) {
        return {
          element: null,
          xpath
        };
      }
      // Dispose of extra handles we won't use to avoid reference leaks
      for (let i = 1; i < elements.length; i++) {
        try {
          if (elements[i] && typeof elements[i].dispose === 'function') {
            await elements[i].dispose();
          }
        } catch (e) {
          // ignore
        }
      }
      return {
        element: elements[0],
        xpath
      };
    } catch (err) {
      console.warn(`Error querying element ${id} with xpath ${xpath}:`, err instanceof Error ? err.message : String(err));
      return null;
    }
  }

  /**
   * Clicks an element by its interactive ID.
   */
  async clickElement(id: string): Promise<boolean> {
    if (!this.page) throw new Error("Browser not initialized");
    const result = await this.findElement(id);
    if (!result) return false;

    const { element, xpath } = result;

    console.log(`Clicking element: ${id} (XPath: ${xpath})`);

    // Attempt native Puppeteer click first
    if (element) {
      try {
        await element.scrollIntoView();
        await element.click();
        return true;
      } catch (nativeErr) {
        console.warn(`Native click failed for ${id}, attempting fallback...`, nativeErr instanceof Error ? nativeErr.message : String(nativeErr));
        // Proceed to fallback
      } finally {
        if (typeof element.dispose === 'function') {
          await element.dispose();
        }
      }
    }

    // Fallback: evaluate click directly via JS if element is null or native click failed
    try {
      const clicked = await this.page.evaluate((xp) => {
        const res = document.evaluate(xp, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
        const node = res.singleNodeValue as HTMLElement;
        if (node) {
          node.scrollIntoView({ block: 'center' });
          node.click();
          return true;
        }
        return false;
      }, xpath);
      return clicked;
    } catch (err) {
      console.error(`Error in click fallback for element ${id}:`, err);
      return false;
    }
  }

  /**
   * Inputs text into an input field by its interactive ID.
   */
  async typeElement(id: string, text: string): Promise<boolean> {
    if (!this.page) throw new Error("Browser not initialized");
    const result = await this.findElement(id);
    if (!result) return false;

    const { element, xpath } = result;

    console.log(`Typing "${text}" into element: ${id}`);
    try {
      if (element) {
        try {
          await element.scrollIntoView();
          // Clear existing value if possible
          await element.click({ clickCount: 3 });
          await this.page.keyboard.press('Backspace');
          await element.type(text);
          return true;
        } finally {
          if (element && typeof element.dispose === 'function') {
            await element.dispose();
          }
        }
      }
      return false;
    } catch (err) {
      console.error(`Error typing into element ${id}:`, err);
      return false;
    }
  }

  /**
   * Dynamic fallback logic to auto-fill Stripe Checkout iframe.
   * If we detect Stripe checkout forms, this handles filling card, expiry, cvc, and name.
   */
  async handleStripeIframe(card: string, expiry: string, cvc: string, name: string): Promise<boolean> {
    if (!this.page) throw new Error("Browser not initialized");

    console.log("Checking for Stripe Checkout inputs inside frames...");
    try {
      // Get all frames and filter out detached ones
      let frames = this.page.frames();
      frames = frames.filter((f: any) => {
        if (typeof f.isDetached === 'function') return !f.isDetached();
        if ('detached' in f) return !f.detached;
        if ('_detached' in f) return !f._detached;
        return true;
      });
      let cardFilled = false;
      let expiryFilled = false;
      let cvcFilled = false;

      // Helper to fill a field in a frame
      async function fillInFrame(frame: Frame, selectors: string[], value: string): Promise<boolean> {
        for (const selector of selectors) {
          try {
            const handle = await frame.$(selector);
            if (handle) {
              try {
                await handle.scrollIntoView();
                await handle.evaluate((el, val) => {
                  (el as HTMLInputElement).value = val;
                  el.dispatchEvent(new Event('input', { bubbles: true }));
                  el.dispatchEvent(new Event('change', { bubbles: true }));
                }, value);
                return true;
              } finally {
                if (handle && typeof handle.dispose === 'function') {
                  await handle.dispose();
                }
              }
            }
          } catch {
            // Ignore if selector is not found in this frame
          }
        }
        return false;
      }

      // Try main page and then frames concurrently
      await Promise.all(frames.map(async (frame) => {
        if (!cardFilled) {
          const filled = await fillInFrame(frame, STRIPE_CARD_SELECTORS, card);
          if (filled) cardFilled = true;
        }
        if (!expiryFilled) {
          const filled = await fillInFrame(frame, STRIPE_EXPIRY_SELECTORS, expiry);
          if (filled) expiryFilled = true;
        }
        if (!cvcFilled) {
          const filled = await fillInFrame(frame, STRIPE_CVC_SELECTORS, cvc);
          if (filled) cvcFilled = true;
        }
      }));

      // Fill name on card if present in main page or frame concurrently
      let nameFilled = false;
      
      await Promise.all(frames.map(async (frame) => {
        if (!nameFilled) {
          const filled = await fillInFrame(frame, STRIPE_NAME_SELECTORS, name);
          if (filled) nameFilled = true;
        }
      }));

      console.log(`Stripe autofill summary: Card=${cardFilled}, Expiry=${expiryFilled}, CVC=${cvcFilled}, Name=${nameFilled}`);
      return cardFilled && expiryFilled && cvcFilled;
    } catch (err) {
      console.error("Exception during Stripe iframe handling:", err);
      return false;
    }
  }

  /**
   * Helper to wait for 1-2 seconds for dynamic updates
   */
  async wait(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
}
