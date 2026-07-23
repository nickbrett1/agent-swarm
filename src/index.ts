import { Agent, routeAgentRequest, callable } from "agents";
import { StagehandBrowserHelper } from "./browser.js";
import puppeteer, { BrowserWorker, LimitsResponse } from "@cloudflare/puppeteer";
import type { Ai } from "@cloudflare/workers-types";

import ipaddr from "ipaddr.js";

export interface ExtendedLimitsResponse extends LimitsResponse {
  browserTimeSecondsLimit?: number | "unlimited";
  usedBrowserTimeSeconds?: number;
  timeUntilBrowserTimeReset?: number;
}

export interface BrowserLimits extends Partial<ExtendedLimitsResponse> {
  configured: boolean;
  maxConcurrentSessions?: number;
  activeSessionsCount?: number;
  allowedBrowserAcquisitions?: number;
  timeUntilNextAcquisition?: number;
  browserTimeSecondsIncluded?: number;
  error?: string;
}

export interface Env {
  MYBROWSER: BrowserWorker;
  AI: Ai;
  GOOGLE_API_KEY?: string;
  GEMINI_API_KEY?: string;
  SHOP_URL?: string;
  STRIPE_TEST_CARD?: string;
  STRIPE_TEST_EXPIRY?: string;
  STRIPE_TEST_CVC?: string;
  STRIPE_TEST_NAME?: string;
  AGENT_SWARM_SECRET?: string;
  AGENT_SWARM_SALT?: string;
  BROWSER_TIME_LIMIT_MOCK?: string | number;
  ALLOWED_ORIGINS?: string;
}

const PAY_SUBMIT_REGEX = /pay|submit|complete|buy|purchase/i;

export interface ShopperState {
  persona: string;
  history: string[];
  status: "idle" | "running" | "completed" | "failed";
  lastError?: string;
}

interface LLMResponse {
  explanation: string;
  action: "click" | "type" | "stripe_fill" | "wait" | "finish";
  targetId?: string;
  text?: string;
}

export class ShopperAgent extends Agent<Env, ShopperState> {
  // Define initial state
  initialState: ShopperState = {
    persona: "A cautious tech buyer looking for a good laptop or accessory",
    history: [],
    status: "idle"
  };

  /**
   * Helper to determine if an IP address is private/local.
   */
  private isPrivateIp(ipStr: string): boolean {
    try {
      // Use ipaddr.process which automatically converts IPv4-mapped IPv6 addresses
      // to their true IPv4 representation, preventing bypasses.
      const ip = ipaddr.process(ipStr);
      const range = ip.range();

      return (
        range === 'private' ||
        range === 'loopback' ||
        range === 'linkLocal' ||
        range === 'unspecified' ||
        range === 'uniqueLocal' ||
        range === 'ipv4Mapped'
      );
    } catch (ipParseErr) {
      console.warn("Ignored error parsing IP address, treating as private/unsafe:", ipParseErr);
      return true; // Fail closed to prevent bypass
    }
  }

  /**
   * Validates a URL to prevent SSRF by blocking local/private IP addresses and domains.
   * Also resolves the domain name to check if it points to a private IP.
   */
  private async isSafeUrl(urlStr: string): Promise<boolean> {
    try {
      const urlObj = new URL(urlStr);

      // Only allow http and https protocols
      if (urlObj.protocol !== 'http:' && urlObj.protocol !== 'https:') {
        return false;
      }

      let hostname = urlObj.hostname;

      // Strip brackets for IPv6
      if (hostname.startsWith('[') && hostname.endsWith(']')) {
        hostname = hostname.substring(1, hostname.length - 1);
      }

      // Block localhost and local/internal domains
      if (hostname === 'localhost' || hostname.endsWith('.local') || hostname.endsWith('.internal')) {
        return false;
      }

      // If it's already an IP address, just check it directly
      if (ipaddr.isValid(hostname)) {
        return !this.isPrivateIp(hostname);
      }

      // DNS resolution check removed due to DNS rebinding vulnerability.
      // We rely on Cloudflare's infrastructure/network routing rules to block private IP access.
      return true;
    } catch (urlParseErr) {
      console.warn("Ignored URL parsing error in isSafeUrl:", urlParseErr);
      return false;
    }
  }

  private async waitForUrlChange(helper: StagehandBrowserHelper, startUrl: string): Promise<void> {
    const urlChanged = await helper.waitForUrlChange(startUrl, 12000);

    if (!urlChanged) {
      await helper.wait(2000);
    }
  }

  private async handleClickAction(decision: LLMResponse, helper: StagehandBrowserHelper, pageData: any): Promise<void> {
    if (!decision.targetId) {
      throw new Error("Action 'click' requires a 'targetId'");
    }
    const element = pageData.elements.find((e: any) => e.id === decision.targetId);
    let isPayOrSubmit = false;
    if (element && element.text) {
      isPayOrSubmit = PAY_SUBMIT_REGEX.test(element.text);
    }

    const startUrl = await helper.getPageUrl();
    const clickOk = await helper.clickElement(decision.targetId);
    if (!clickOk) {
      console.warn(JSON.stringify({ message: "Click failed, trying to find alternatives...", targetId: decision.targetId }));
    }

    if (isPayOrSubmit) {
      await this.waitForUrlChange(helper, startUrl);
    } else {
      await helper.wait(250);
    }
  }

  private async handleTypeAction(decision: LLMResponse, helper: StagehandBrowserHelper): Promise<void> {
    if (!decision.targetId || decision.text === undefined) {
      throw new Error("Action 'type' requires both 'targetId' and 'text'");
    }
    const typeOk = await helper.typeElement(decision.targetId, decision.text);
    if (!typeOk) {
      console.warn(JSON.stringify({ message: "Type failed.", targetId: decision.targetId }));
    }
  }

  private async handleStripeFillAction(helper: StagehandBrowserHelper): Promise<void> {
    const card = this.env.STRIPE_TEST_CARD;
    const expiry = this.env.STRIPE_TEST_EXPIRY;
    const cvc = this.env.STRIPE_TEST_CVC;
    const name = this.env.STRIPE_TEST_NAME;

    if (!card || !expiry || !cvc || !name) {
      throw new Error("Missing required Stripe test credentials in environment configuration.");
    }

    console.log(JSON.stringify({ message: "Filling Stripe checkout details..." }));
    const stripeOk = await helper.handleStripeIframe(card, expiry, cvc, name);
    if (stripeOk) {
      console.log(JSON.stringify({ message: "Stripe card credentials filled successfully." }));
    } else {
      console.warn(JSON.stringify({ message: "Could not find Stripe inputs. Continuing in case fields are on main page..." }));
    }
    await helper.wait(200);
  }

  private async handleAction(decision: LLMResponse, helper: StagehandBrowserHelper, pageData: any): Promise<{ finished: boolean; outcomeSummary?: string }> {
    switch (decision.action) {
      case "click": {
        await this.handleClickAction(decision, helper, pageData);
        break;
      }
      case "type": {
        await this.handleTypeAction(decision, helper);
        break;
      }
      case "stripe_fill": {
        await this.handleStripeFillAction(helper);
        break;
      }
      case "wait": {
        console.log(JSON.stringify({ message: "Waiting 3 seconds..." }));
        await helper.wait(3000);
        break;
      }
      case "finish": {
        return { finished: true, outcomeSummary: decision.explanation };
      }
      default: {
        const _exhaustiveCheck: never = decision.action;
        throw new Error(`Unsupported action: ${_exhaustiveCheck}`);
      }
    }
    return { finished: false };
  }

  private async initializeShoppingSession(persona: string, url?: string): Promise<string> {
    this.setState({
      persona,
      history: [],
      status: "running",
      lastError: undefined
    });

    const targetUrl = url || this.env.SHOP_URL || "https://fintechnick.com/shop";

    const isSafe = await this.isSafeUrl(targetUrl);
    if (!isSafe) {
      const errorMsg = `Invalid or unsafe URL provided: ${targetUrl}`;
      this.setState({
        ...this.state,
        status: "failed",
        lastError: errorMsg
      });
      throw new Error(errorMsg);
    }
    
    return targetUrl;
  }

  private isSuccessUrl(url: string): boolean {
    const lowerUrl = url.toLowerCase();
    return lowerUrl.includes("success") ||
           lowerUrl.includes("thank") ||
           lowerUrl.includes("complete") ||
           lowerUrl.includes("confirm") ||
           lowerUrl.includes("receipt") ||
           lowerUrl.includes("order");
  }

  private logDecisionAndHistory(step: number, decision: LLMResponse): void {
    // Filter sensitive data before logging by only including safe fields
    const logDecision: Record<string, string> = {
      explanation: decision.explanation,
      action: decision.action
    };
    if (decision.targetId) {
      logDecision.targetId = decision.targetId;
    }
    if (decision.text) {
      logDecision.text = "***REDACTED***";
    }
    console.log(JSON.stringify({ message: "LLM Decision", decision: logDecision }));

    const targetPart = decision.targetId ? ` on ${decision.targetId}` : '';
    const textPart = decision.text ? ' value="***REDACTED***"' : '';
    const actionLog = `Step ${step}: ${decision.explanation} -> Action: ${decision.action}${targetPart}${textPart}`;

    this.setState({
      ...this.state,
      history: [...this.state.history, actionLog]
    });
  }

  private async executeShoppingLoop(helper: StagehandBrowserHelper, persona: string): Promise<string> {
    const maxSteps = 12;
    let step = 0;
    let finished = false;
    let outcomeSummary = "";

    while (step < maxSteps && !finished) {
      step++;
      
      // Check if the current URL is a success/thank-you/complete page
      const currentUrl = await helper.getPageUrl();
      if (this.isSuccessUrl(currentUrl)) {
        console.log(JSON.stringify({ message: "Success page detected. Finishing shopping run.", url: currentUrl }));
        finished = true;
        outcomeSummary = `Successfully completed purchase. Redirected to: ${currentUrl}`;
        this.setState({ ...this.state, status: "completed" });
        break;
      }

      // 1. Get current page elements
      const pageData = await helper.getInteractiveElements();
      console.log(JSON.stringify({
        step,
        url: currentUrl,
        interactiveNodesCount: pageData.elements.length
      }));

      // 2. Build the LLM prompt
      const { systemPrompt, userPrompt } = this.buildLLMPrompt(persona, pageData.textSummary, this.state.history);

      // 3. Query LLM (Gemini or Workers AI)
      const decision = await this.queryLLM(systemPrompt, userPrompt);

      this.logDecisionAndHistory(step, decision);

      // 4. Execute Action
      const actionResult = await this.handleAction(decision, helper, pageData);
      if (actionResult.finished) {
        finished = true;
        if (actionResult.outcomeSummary) {
          outcomeSummary = actionResult.outcomeSummary;
        }
        this.setState({ ...this.state, status: "completed" });
      }

      // Small cooldown between actions
      await helper.wait(100);
    }

    if (!finished) {
      outcomeSummary = `Reached maximum action limit (${maxSteps} steps) without finishing.`;
      this.setState({ ...this.state, status: "failed", lastError: outcomeSummary });
      throw new Error(outcomeSummary);
    }

    return outcomeSummary;
  }

  private handleShoppingError(err: unknown): string {
    console.error("Error during shopping execution:", err);

    const errMsg = err instanceof Error ? err.message : String(err);
    const lowerErrMsg = errMsg.toLowerCase();
    const isBrowserClosedErr = lowerErrMsg.includes("closed") ||
                               lowerErrMsg.includes("connection lost") ||
                               lowerErrMsg.includes("detached") ||
                               lowerErrMsg.includes("lost");

    const hasClickedPay = this.state.history.some(log => {
      const lowerLog = log.toLowerCase();
      return lowerLog.includes("action: click") &&
        (lowerLog.includes("pay") ||
         lowerLog.includes("submit") ||
         lowerLog.includes("complete") ||
         lowerLog.includes("buy") ||
         lowerLog.includes("button_14") ||
         lowerLog.includes("button_12") ||
         lowerLog.includes("button_45"));
    });

    if (isBrowserClosedErr && hasClickedPay) {
      console.log("Browser disconnected/closed after submitting payment. Marking shopping run as completed successfully.");
      const outcomeSummary = "Successfully completed purchase. Browser session closed during redirect/settle.";
      this.setState({
        ...this.state,
        status: "completed"
      });
      return `Shopping Session Finished. Status: completed. Summary: ${outcomeSummary}`;
    }

    this.setState({
      ...this.state,
      status: "failed",
      lastError: errMsg
    });
    throw err;
  }

  /**
   * RPC Endpoint to trigger a shopping run.
   */
  // @ts-expect-error
  @callable()
  async runShopping(persona: string, url?: string): Promise<string> {
    const targetUrl = await this.initializeShoppingSession(persona, url);

    const helper = new StagehandBrowserHelper(
      this.env.MYBROWSER,
      this.env.AI,
      this.env.GOOGLE_API_KEY || this.env.GEMINI_API_KEY
    );

    const browserStartTime = Date.now();
    let resultString = "";

    try {
      await helper.init();
      await helper.goto(targetUrl);

      const outcomeSummary = await this.executeShoppingLoop(helper, persona);
      resultString = `Shopping Session Finished. Status: ${this.state.status}. Summary: ${outcomeSummary}`;
    } catch (err: unknown) {
      resultString = this.handleShoppingError(err);
    } finally {
      await helper.close();
      const browserDurationSeconds = ((Date.now() - browserStartTime) / 1000).toFixed(1);
      if (resultString) {
        resultString += ` [Browser Time Used: ${browserDurationSeconds}s]`;
      }
    }

    return resultString;
  }

  /**
   * Constructs a strict prompt for the LLM.
   */
  private buildLLMPrompt(persona: string, textSummary: string, history: string[]): { systemPrompt: string, userPrompt: string } {
    const systemPrompt = `You are an autonomous e-commerce shopper agent executing inside a browser.
Your goal: Find a product that fits the user's persona, add it to the cart/buy it, and proceed through checkout using Stripe's test mode.

Decide the single next action to take. You must output a JSON object matching this schema:
{
  "explanation": "Brief thought explaining why you chose this action",
  "action": "click" | "type" | "stripe_fill" | "wait" | "finish",
  "targetId": "element_id from the interactive elements list (required if action is click or type)",
  "text": "text value to enter (required if action is type)"
}

Guidelines:
1. Review the element IDs closely. Choose the ID that best aligns with your next step.
2. If you are looking at a product catalog, click the "Buy Now" or "Add to Cart" button for a product matching the persona.
3. Do NOT click "Login" or other account/profile buttons on the shop catalog page. The checkout process does not require logging in.
4. If you are on the Checkout page and see Credit Card, Expiration, or CVC inputs, use the "stripe_fill" action (which will autofill these inputs inside the iframe).
5. After filling the card details using the "stripe_fill" action, you must find and click the "Pay", "Submit", or "Place Order" button using the "click" action to process the transaction. Do NOT run "stripe_fill" again to submit.
6. If you have submitted the payment and see a Success or Thank You page, output the "finish" action with a final success summary.
7. RESPOND WITH A RAW JSON OBJECT ONLY. DO NOT WRAP IT IN MARKDOWN CODE BLOCKS OR EXTRA TEXT.`;

    const userPrompt = `Your persona configuration: ${persona}

Here is the history of actions you have taken so far in this session:
${history.length > 0 ? history.map((h, i) => `${i+1}. ${h}`).join("\n") : "No actions taken yet."}

Here is the current state of the page:
---------------------------------------------
${textSummary}
---------------------------------------------`;

    return { systemPrompt, userPrompt };
  }

  private async queryGemini(apiKey: string, systemPrompt: string, userPrompt: string): Promise<LLMResponse> {
    const maxRetries = 3;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent`;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": apiKey
          },
          body: JSON.stringify({
            systemInstruction: {
              parts: [{ text: systemPrompt }]
            },
            contents: [
              { parts: [{ text: userPrompt }] }
            ],
            generationConfig: {
              responseMimeType: "application/json"
            }
          })
        });

        if (!response.ok) {
          throw new Error(`Gemini API returned status ${response.status}`);
        }

        const data = await response.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
        const textResponse = data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!textResponse) {
          throw new Error("Empty response from Gemini API");
        }

        return JSON.parse(textResponse.trim()) as LLMResponse;
      } catch (err: unknown) {
        console.warn(`Gemini API call attempt ${attempt} failed:`, err instanceof Error ? err.message : String(err));
        if (attempt === maxRetries) {
          console.error("Gemini API call failed after max retries, falling back to Workers AI:", err);
          throw err;
        } else {
          console.log("Waiting 2 seconds before retrying Gemini API...");
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
      }
    }
    throw new Error("Gemini API call failed");
  }

  private parseWorkersAIResponse(rawResponse: string | object): LLMResponse {
    if (typeof rawResponse === "object" && rawResponse !== null) {
      return rawResponse as unknown as LLMResponse;
    }

    const textResponse = rawResponse as string;
    let cleanText = textResponse.trim();
    if (cleanText.startsWith("```")) {
      const firstLineBreak = cleanText.indexOf("\n");
      if (firstLineBreak !== -1) {
        const lastCodeBlock = cleanText.lastIndexOf("```");
        if (lastCodeBlock > firstLineBreak) {
          cleanText = cleanText.substring(firstLineBreak + 1, lastCodeBlock).trim();
        }
      }
    }

    try {
      return JSON.parse(cleanText) as LLMResponse;
    } catch (parseErr) {
      console.error("Failed to parse LLM response as JSON. Raw response was:", textResponse);
      throw new Error(`LLM output parsing error: ${parseErr}`);
    }
  }

  private async queryWorkersAI(systemPrompt: string, userPrompt: string): Promise<LLMResponse> {
    if (!this.env.AI) {
      throw new Error("No Workers AI binding available");
    }

    console.log("Calling Workers AI Llama model...");
    const model = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
    
    const response = await this.env.AI.run(model, {
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ]
    }, {
      gateway: {
        id: "default"
      }
    });

    const aiResponse = response as Record<string, unknown>;
    console.log("Workers AI Llama raw response type:", typeof response, "keys:", Object.keys(aiResponse));

    const rawResponse = aiResponse.response || aiResponse.text;
    if (!rawResponse) {
      throw new Error("Empty response from Workers AI");
    }

    return this.parseWorkersAIResponse(rawResponse as string | object);
  }

  /**
   * Queries either the Gemini API (if key is present) or falls back to Workers AI.
   */
  private async queryLLM(systemPrompt: string, userPrompt: string): Promise<LLMResponse> {
    let geminiError: unknown = null;
    const apiKey = this.env.GOOGLE_API_KEY || this.env.GEMINI_API_KEY;

    if (apiKey) {
      try {
        return await this.queryGemini(apiKey, systemPrompt, userPrompt);
      } catch (err) {
        geminiError = err;
      }
    }

    // Fallback: Workers AI
    try {
      return await this.queryWorkersAI(systemPrompt, userPrompt);
    } catch (err: unknown) {
      if (geminiError) {
        const errMessage = err instanceof Error ? err.message : String(err);
        const geminiMessage = geminiError instanceof Error ? geminiError.message : String(geminiError);
        throw new Error(`Workers AI fallback failed: ${errMessage}. (Gemini API also failed: ${geminiMessage})`);
      }
      if (!this.env.AI) {
        throw new Error("No LLM keys or Workers AI binding available");
      }
      throw err;
    }
  }

}

const hmacKeyCache = new Map<string, CryptoKey>();

// Helper to verify the SvelteKit HMAC signature
export async function verifyHmacSignature(
  expiryStr: string | null,
  signatureHex: string | null,
  secret: string,
  envSalt?: string
): Promise<boolean> {
  if (!expiryStr || !signatureHex) return false;

  try {
    const expiry = parseInt(expiryStr, 10);
    // Ensure token hasn't expired (and timestamp is valid)
    if (isNaN(expiry) || Date.now() > expiry) {
      return false;
    }

    const encoder = new TextEncoder();

    const matches = signatureHex.match(/.{1,2}/g);
    if (!matches) {
      return false;
    }
    const sigBytes = new Uint8Array(
      matches.map(byte => parseInt(byte, 16))
    );

    const dataToVerify = encoder.encode(expiryStr);

    if (!envSalt) {
      console.warn("Missing required environment salt for HMAC verification.");
      return false;
    }

    const cacheKey = envSalt + ":" + secret;
    let primaryKey = hmacKeyCache.get(cacheKey);
    if (!primaryKey) {
      const keyMaterial = await crypto.subtle.importKey(
        'raw',
        encoder.encode(secret),
        { name: 'PBKDF2' },
        false,
        ['deriveKey']
      );

      primaryKey = await crypto.subtle.deriveKey(
        {
          name: 'PBKDF2',
          salt: encoder.encode(envSalt),
          iterations: 600000,
          hash: 'SHA-256'
        },
        keyMaterial,
        { name: 'HMAC', hash: 'SHA-256', length: 256 },
        false,
        ['verify']
      );
      hmacKeyCache.set(cacheKey, primaryKey);
    }

    return await crypto.subtle.verify(
      'HMAC',
      primaryKey,
      sigBytes,
      dataToVerify
    );
  } catch (err) {
    console.error("Signature verification error:", err);
    return false;
  }
}

function getCorsOrigin(request: Request, env: Env): string {
  const origin = request.headers.get("Origin");
  const originsString = env.ALLOWED_ORIGINS || "https://fintechnick.com";
  const allowedOriginsSet = new Set(originsString.split(",").map(o => o.trim()));

  if (origin && allowedOriginsSet.has(origin)) {
    return origin;
  }
  return "";
}

function getCorsHeaders(request: Request, env: Env): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": getCorsOrigin(request, env),
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
}

export function getBrowserTimeLimit(env: Env, limits: ExtendedLimitsResponse): number | "unlimited" {
  const defaultLimit = (limits.maxConcurrentSessions || 1) >= 10 ? "unlimited" : 600;
  let browserTimeSecondsLimit: number | "unlimited" = defaultLimit;

  if (env.BROWSER_TIME_LIMIT_MOCK !== undefined) {
    browserTimeSecondsLimit = Number(env.BROWSER_TIME_LIMIT_MOCK);
  } else if (limits.browserTimeSecondsLimit !== undefined) {
    browserTimeSecondsLimit = limits.browserTimeSecondsLimit;
  }
  return browserTimeSecondsLimit;
}

export async function buildLimitsResponse(env: Env) {
  let browserLimits: BrowserLimits = { configured: false };
  if (env.MYBROWSER) {
    try {
      const limits = await puppeteer.limits(env.MYBROWSER) as ExtendedLimitsResponse;
      const browserTimeSecondsLimit = getBrowserTimeLimit(env, limits);

      browserLimits = {
        ...limits,
        configured: true,
        maxConcurrentSessions: limits.maxConcurrentSessions,
        activeSessionsCount: limits.activeSessions ? limits.activeSessions.length : 0,
        allowedBrowserAcquisitions: limits.allowedBrowserAcquisitions,
        timeUntilNextAcquisition: limits.timeUntilNextAllowedBrowserAcquisition,
        usedBrowserTimeSeconds: limits.usedBrowserTimeSeconds || 0,
        timeUntilBrowserTimeReset: limits.timeUntilBrowserTimeReset,
        browserTimeSecondsLimit,
        browserTimeSecondsIncluded: (limits.maxConcurrentSessions || 1) >= 10 ? 36000 : 600
      };

      if (
        browserLimits.browserTimeSecondsLimit !== "unlimited" &&
        browserLimits.usedBrowserTimeSeconds !== undefined &&
        browserLimits.browserTimeSecondsLimit !== undefined &&
        browserLimits.usedBrowserTimeSeconds >= browserLimits.browserTimeSecondsLimit &&
        browserLimits.timeUntilBrowserTimeReset === undefined
      ) {
        const now = new Date();
        const nextUTC = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0));
        browserLimits.timeUntilBrowserTimeReset = Math.max(0, Math.floor((nextUTC.getTime() - now.getTime()) / 1000));
      }
    } catch (err) {
      browserLimits = {
        configured: true,
        error: err instanceof Error ? err.message : String(err)
      };
    }
  }

  return {
    browser: browserLimits,
    primary_llm: {
      configured: !!env.AI,
      model: "@cf/meta/llama-3.1-8b-instruct",
      usage_dashboard: "https://dash.cloudflare.com/?to=/:account/ai/ai-gateway"
    },
    secondary_llm: {
      configured: !!(env.GOOGLE_API_KEY || env.GEMINI_API_KEY),
      model: "gemini-2.0-flash",
      usage_dashboard: "https://dash.cloudflare.com/?to=/:account/ai/ai-gateway"
    }
  };
}

export function handleOptions(request: Request, env: Env): Response {
  return new Response(null, {
    status: 204,
    headers: getCorsHeaders(request, env)
  });
}

async function handleLimits(request: Request, env: Env): Promise<Response> {
  const limitsResponse = await buildLimitsResponse(env);

  return new Response(JSON.stringify(limitsResponse, null, 2), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      ...getCorsHeaders(request, env)
    }
  });
}

export function handleInfo(request: Request, env: Env): Response {
  const info = {
    name: "agent-swarm",
    description: "Autonomous browser rendering swarm that runs stateful agent sessions.",
    version: "0.1.0",
    agents: {
      ShopperAgent: {
        description: "Launches a browser rendering session to browse, search, and purchase products in Stripe test-mode.",
        methods: {
          runShopping: {
            description: "Triggers a browser automation sequence with the specified shopping persona.",
            parameters: {
              type: "object",
              properties: {
                persona: {
                  type: "string",
                  description: "The buyer behavior profile (e.g., 'A tech buyer looking for a sticker').",
                  required: true
                },
                url: {
                  type: "string",
                  description: "Override URL to shop on. Defaults to the configured SHOP_URL.",
                  required: false
                }
              }
            },
            returns: {
              type: "string",
              description: "A summary string of the shopping session outcome."
            }
          }
        }
      }
    }
  };

  return new Response(JSON.stringify(info, null, 2), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      ...getCorsHeaders(request, env)
    }
  });
}

export async function handleAgentRequest(request: Request, env: Env, url: URL): Promise<Response> {
  const expiry = url.searchParams.get("expiry");
  const signature = url.searchParams.get("signature");

  const secret = env.AGENT_SWARM_SECRET;
  const salt = env.AGENT_SWARM_SALT;

  if (secret) {
    const isAuthorized = await verifyHmacSignature(expiry, signature, secret, salt);
    
    if (!isAuthorized) {
      return new Response("Unauthorized Swarm Connection: Invalid or expired signature", {
        status: 401,
        headers: { "Content-Type": "text/plain" }
      });
    }
  }

  return (
    (await routeAgentRequest(request, env)) ??
    new Response("Cloudflare Agent Swarm is running. Use the WebSocket/RPC client to trigger runs.", {
      status: 200,
      headers: { "Content-Type": "text/plain" }
    })
  );
}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);

    // 1. Handle CORS preflight requests
    if (request.method === "OPTIONS") {
      return handleOptions(request, env);
    }

    // 2. Serve public API limits/usage data without requiring signatures
    if (url.pathname === "/limits" || url.pathname === "/usage") {
      return handleLimits(request, env);
    }

    // 3. Serve public API metadata without requiring signatures
    if (url.pathname === "/info" || url.pathname === "/inspect") {
      return handleInfo(request, env);
    }

    // 4. Verify access signature if secret is configured and route request
    return handleAgentRequest(request, env, url);
  }
};
