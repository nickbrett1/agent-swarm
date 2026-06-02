import puppeteer, { Browser, Page, Frame } from "@cloudflare/puppeteer";

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

export class PuppeteerBrowserHelper {
  private browser: Browser | null = null;
  private page: Page | null = null;
  private elementsMap: Map<string, string> = new Map(); // id -> xpath

  constructor(private browserBinding: any) {}

  async init(): Promise<void> {
    console.log("Launching Cloudflare Browser Rendering session...");
    this.browser = await puppeteer.launch(this.browserBinding);
    this.page = await this.browser.newPage();
    await this.page.setViewport({ width: 1280, height: 720 });
    // Increase default timeout
    this.page.setDefaultTimeout(15000);
  }

  async close(): Promise<void> {
    if (this.browser) {
      try {
        console.log("Closing browser session...");
        await this.browser.close();
      } catch (err: any) {
        console.warn("Ignoring error closing browser (might already be closed):", err.message);
      } finally {
        this.browser = null;
        this.page = null;
      }
    }
  }

  async goto(url: string): Promise<void> {
    if (!this.page) throw new Error("Browser not initialized");
    console.log(`Navigating to ${url}...`);
    await this.page.goto(url, { waitUntil: "load" });
  }

  async getPageUrl(): Promise<string> {
    return this.page ? this.page.url() : "";
  }

  /**
   * Scrapes the page, extracts interactive elements, and creates an element map.
   */
  async getInteractiveElements(): Promise<{ elements: InteractiveElement[]; textSummary: string }> {
    if (!this.page) throw new Error("Browser not initialized");

    let elementsData;
    let attempts = 0;
    const maxAttempts = 2;

    while (attempts < maxAttempts) {
      try {
        // We execute a script in the browser context to find and label interactive elements
        elementsData = await this.page.evaluate(() => {
          const results: Array<{
            tag: string;
            type: string;
            text: string;
            placeholder: string;
            name: string;
            role: string;
            xpath: string;
          }> = [];

          // Helper to generate a simple XPath for an element
          function getXPath(element: Element): string {
            if (element.id) {
              return `//*[@id="${element.id}"]`;
            }
            const paths: string[] = [];
            for (; element && element.nodeType === Node.ELEMENT_NODE; element = element.parentNode as Element) {
              let index = 0;
              let hasSiblingWithSameTag = false;
              for (let sibling = element.previousSibling; sibling; sibling = sibling.previousSibling) {
                if (sibling.nodeType === Node.DOCUMENT_TYPE_NODE) continue;
                if (sibling.nodeName === element.nodeName) {
                  index++;
                  hasSiblingWithSameTag = true;
                }
              }
              for (let sibling = element.nextSibling; sibling; sibling = sibling.nextSibling) {
                if (sibling.nodeName === element.nodeName) {
                  hasSiblingWithSameTag = true;
                  break;
                }
              }
              const tagName = element.nodeName.toLowerCase();
              const pathIndex = hasSiblingWithSameTag ? `[${index + 1}]` : '';
              paths.unshift(tagName + pathIndex);
            }
            return paths.length ? '/' + paths.join('/') : '';
          }

          // Query standard interactive selectors
          const selector = 'button, a, input, select, textarea, [role="button"], [onclick]';
          const nodes = Array.from(document.querySelectorAll(selector));

          nodes.forEach((node) => {
            const el = node as HTMLElement;
            
            // Skip hidden or tiny elements
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) return;
            const style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) === 0) return;

            // Clean up innerText/text context
            let text = (el.innerText || el.textContent || '').trim();
            if (!text && el.tagName === 'INPUT') {
              text = (el as HTMLInputElement).value || '';
            }
            
            // Truncate overly long texts (e.g. nested containers)
            if (text.length > 80) {
              text = text.substring(0, 77) + "...";
            }

            results.push({
              tag: el.tagName.toLowerCase(),
              type: (el as HTMLInputElement).type || '',
              text: text,
              placeholder: (el as HTMLInputElement).placeholder || el.getAttribute('aria-label') || '',
              name: el.getAttribute('name') || el.getAttribute('id') || '',
              role: el.getAttribute('role') || '',
              xpath: getXPath(el)
            });
          });

          return results;
        });
        break; // Success, break out of loop
      } catch (err: any) {
        attempts++;
        console.warn(`Evaluation attempt ${attempts} failed:`, err.message);
        
        // If we are on a success/thank-you page, we don't need to try again, just return dummy data
        const url = await this.getPageUrl();
        if (url.toLowerCase().includes("success") || 
            url.toLowerCase().includes("thank") || 
            url.toLowerCase().includes("complete")) {
          console.log("Success/thank-you page detected during error. Returning dummy response.");
          return { 
            elements: [], 
            textSummary: `Redirected to success page: ${url}` 
          };
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
      elements.forEach((el) => {
        const labelParts: string[] = [];
        if (el.text) labelParts.push(`text: "${el.text}"`);
        if (el.placeholder) labelParts.push(`placeholder/label: "${el.placeholder}"`);
        if (el.name) labelParts.push(`name: "${el.name}"`);
        const details = labelParts.length > 0 ? ` (${labelParts.join(', ')})` : '';
        textSummary += `- [${el.id}] <${el.tag}${el.type ? ' type=' + el.type : ''}>${details}\n`;
      });
    }

    return { elements, textSummary };
  }

  /**
   * Clicks an element by its interactive ID.
   */
  async clickElement(id: string): Promise<boolean> {
    if (!this.page) throw new Error("Browser not initialized");
    const xpath = this.elementsMap.get(id);
    if (!xpath) {
      console.warn(`Element ID ${id} not found in map`);
      return false;
    }

    console.log(`Clicking element: ${id} (XPath: ${xpath})`);
    try {
      // Find element using xpath
      const elements = await this.page.$$(`xpath/${xpath}`);
      if (elements.length > 0) {
        await elements[0].scrollIntoView();
        await elements[0].click();
        return true;
      }
      // Fallback: evaluate click directly via JS
      const clicked = await this.page.evaluate((xp) => {
        const result = document.evaluate(xp, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
        const node = result.singleNodeValue as HTMLElement;
        if (node) {
          node.scrollIntoView({ block: 'center' });
          node.click();
          return true;
        }
        return false;
      }, xpath);
      return clicked;
    } catch (err) {
      console.error(`Error clicking element ${id}:`, err);
      return false;
    }
  }

  /**
   * Inputs text into an input field by its interactive ID.
   */
  async typeElement(id: string, text: string): Promise<boolean> {
    if (!this.page) throw new Error("Browser not initialized");
    const xpath = this.elementsMap.get(id);
    if (!xpath) {
      console.warn(`Element ID ${id} not found in map`);
      return false;
    }

    console.log(`Typing "${text}" into element: ${id}`);
    try {
      const elements = await this.page.$$(`xpath/${xpath}`);
      if (elements.length > 0) {
        await elements[0].scrollIntoView();
        // Clear existing value if possible
        await elements[0].click({ clickCount: 3 });
        await this.page.keyboard.press('Backspace');
        await elements[0].type(text);
        return true;
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
      // Get all frames
      const frames = this.page.frames();
      let cardFilled = false;
      let expiryFilled = false;
      let cvcFilled = false;

      // Selectors for card details inside iframe
      const cardSelectors = ['input#cardNumber', 'input[name="cardnumber"]', 'input[placeholder*="1234"]', 'input[aria-label*="Card number"]'];
      const expirySelectors = ['input#cardExpiry', 'input[name="exp-date"]', 'input[placeholder*="MM"]', 'input[aria-label*="Expiration"]'];
      const cvcSelectors = ['input#cardCvc', 'input[name="cvc"]', 'input[placeholder*="CVC"]', 'input[aria-label*="CVC"]'];

      // Helper to fill a field in a frame
      async function fillInFrame(frame: Frame, selectors: string[], value: string): Promise<boolean> {
        for (const selector of selectors) {
          try {
            const handle = await frame.$(selector);
            if (handle) {
              await handle.scrollIntoView();
              await handle.evaluate((el, val) => {
                (el as HTMLInputElement).value = val;
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
              }, value);
              return true;
            }
          } catch {}
        }
        return false;
      }

      // Try main page and then frames
      for (const frame of frames) {
        if (!cardFilled) cardFilled = await fillInFrame(frame, cardSelectors, card);
        if (!expiryFilled) expiryFilled = await fillInFrame(frame, expirySelectors, expiry);
        if (!cvcFilled) cvcFilled = await fillInFrame(frame, cvcSelectors, cvc);
      }

      // Fill name on card if present in main page or frame
      const nameSelectors = ['input#billingName', 'input[name="name"]', 'input[placeholder*="Name"]'];
      let nameFilled = false;
      for (const frame of frames) {
        if (!nameFilled) nameFilled = await fillInFrame(frame, nameSelectors, name);
      }

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
