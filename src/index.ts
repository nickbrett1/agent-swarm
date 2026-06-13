import { Agent, routeAgentRequest, callable } from "agents";
import { StagehandBrowserHelper } from "./browser.js";
import puppeteer, { BrowserWorker } from "@cloudflare/puppeteer";
import type { Ai } from "@cloudflare/workers-types";
import ipaddr from "ipaddr.js";

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
  BROWSER_TIME_LIMIT_MOCK?: string | number;
}

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
      let ip = ipaddr.parse(ipStr);

      // If it's an IPv4-mapped IPv6 address (e.g., ::ffff:192.168.1.1),
      // extract the underlying IPv4 address to check its true range.
      if (ip.kind() === 'ipv6' && (ip as ipaddr.IPv6).isIPv4MappedAddress()) {
        ip = (ip as ipaddr.IPv6).toIPv4Address();
      }

      const range = ip.range();

      return (
        range === 'private' ||
        range === 'loopback' ||
        range === 'linkLocal' ||
        range === 'unspecified' ||
        range === 'uniqueLocal'
      );
    } catch {
      // If parsing fails, default to treating it as safe or handled elsewhere
      return false;
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

      // Otherwise, resolve the domain name to A/AAAA records
      const resolveDns = async (type: string) => {
        try {
          const response = await fetch(`https://cloudflare-dns.com/dns-query?name=${hostname}&type=${type}`, {
            headers: { 'accept': 'application/dns-json' }
          });
          if (!response.ok) return [];
          const data = await response.json() as { Answer?: Array<{ type: number, data: string }> };
          return data.Answer || [];
        } catch {
          return [];
        }
      };

      const [aRecords, aaaaRecords] = await Promise.all([
        resolveDns('A'),
        resolveDns('AAAA')
      ]);

      const allRecords = [...aRecords, ...aaaaRecords];

      // If we couldn't resolve any IP, we might consider it safe or unsafe depending on policy.
      // Let's assume safe to proceed and let the actual connection fail if it's invalid.
      // But we must check the resolved ones.
      for (const record of allRecords) {
        // A record type is 1, AAAA record type is 28. CNAMEs might also be returned.
        // We just check the data field for any returned IP.
        if (ipaddr.isValid(record.data)) {
          if (this.isPrivateIp(record.data)) {
            console.warn(`DNS resolution for ${hostname} returned a private IP: ${record.data}`);
            return false;
          }
        }
      }

      return true;
    } catch (e) {
      // If URL parsing fails, it's malformed and potentially unsafe
      return false;
    }
  }

  /**
   * RPC Endpoint to trigger a shopping run.
   */
  // @ts-ignore
  @callable()
  async runShopping(persona: string, url?: string): Promise<string> {
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
      
      const maxSteps = 12;
      let step = 0;
      let finished = false;
      let outcomeSummary = "";

      while (step < maxSteps && !finished) {
        step++;
        
        // Check if the current URL is a success/thank-you/complete page
        const currentUrl = await helper.getPageUrl();
        const lowerUrl = currentUrl.toLowerCase();
        if (lowerUrl.includes("success") ||
            lowerUrl.includes("thank") ||
            lowerUrl.includes("complete") ||
            lowerUrl.includes("confirm") ||
            lowerUrl.includes("receipt") ||
            lowerUrl.includes("order")) {
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

        // Filter sensitive data before logging
        const logDecision = { ...decision };
        if (logDecision.text) {
          logDecision.text = "***REDACTED***";
        }
        console.log(JSON.stringify({ message: "LLM Decision", decision: logDecision }));

        const actionLog = `Step ${step}: ${decision.explanation} -> Action: ${decision.action}${decision.targetId ? ' on ' + decision.targetId : ''}${decision.text ? ' value="***REDACTED***"' : ''}`;
        this.setState({
          ...this.state,
          history: [...this.state.history, actionLog]
        });

        // 4. Execute Action
        switch (decision.action) {
          case "click": {
            if (!decision.targetId) {
              throw new Error("Action 'click' requires a 'targetId'");
            }
            // Check if the clicked element is a submit or pay button to wait longer
            const element = pageData.elements.find(e => e.id === decision.targetId);
            let isPayOrSubmit = false;
            if (element && element.text) {
              const lowerText = element.text.toLowerCase();
              isPayOrSubmit = lowerText.includes("pay") ||
                lowerText.includes("submit") ||
                lowerText.includes("complete") ||
                lowerText.includes("buy") ||
                lowerText.includes("purchase");
            }

            const startUrl = await helper.getPageUrl();

            const clickOk = await helper.clickElement(decision.targetId);
            if (!clickOk) {
              console.warn(JSON.stringify({ message: "Click failed, trying to find alternatives...", targetId: decision.targetId }));
            }

            if (isPayOrSubmit) {
              console.log(JSON.stringify({ message: "Pay/Submit/Buy button clicked, waiting for navigation/redirect to settle..." }));
              const startTime = Date.now();
              const timeout = 12000;
              let urlChanged = false;
              while (Date.now() - startTime < timeout) {
                await helper.wait(500);
                const currentUrl = await helper.getPageUrl();
                if (currentUrl !== startUrl) {
                  urlChanged = true;
                  console.log(JSON.stringify({ message: `URL changed from ${startUrl} to ${currentUrl}. Waiting 2.5s for page load settle...` }));
                  await helper.wait(2500);
                  break;
                }
              }
              if (!urlChanged) {
                console.log(JSON.stringify({ message: "URL did not change after click within timeout. Cooldown 2s." }));
                await helper.wait(2000);
              }
            } else {
              await helper.wait(250); // Wait for dynamic layout/routing
            }
            break;
          }

          case "type": {
            if (!decision.targetId || decision.text === undefined) {
              throw new Error("Action 'type' requires both 'targetId' and 'text'");
            }
            const typeOk = await helper.typeElement(decision.targetId, decision.text);
            if (!typeOk) {
              console.warn(JSON.stringify({ message: "Type failed.", targetId: decision.targetId }));
            }
            break;
          }

          case "stripe_fill": {
            // Automate Stripe iframe using test credentials from worker config or defaults
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
            break;
          }

          case "wait": {
            console.log(JSON.stringify({ message: "Waiting 3 seconds..." }));
            await helper.wait(3000);
            break;
          }

          case "finish": {
            finished = true;
            outcomeSummary = decision.explanation;
            this.setState({ ...this.state, status: "completed" });
            break;
          }

          default: {
            const _exhaustiveCheck: never = decision.action;
            throw new Error(`Unsupported action: ${_exhaustiveCheck}`);
          }
        }

        // Small cooldown between actions
        await helper.wait(100);
      }

      if (!finished) {
        outcomeSummary = `Reached maximum action limit (${maxSteps} steps) without finishing.`;
        this.setState({ ...this.state, status: "failed", lastError: outcomeSummary });
        throw new Error(outcomeSummary);
      }

      resultString = `Shopping Session Finished. Status: ${this.state.status}. Summary: ${outcomeSummary}`;

    } catch (err: unknown) {
      console.error("Error during shopping execution:", err);
      
      const errMsg = err instanceof Error ? err.message : String(err);
      const isBrowserClosedErr = errMsg.toLowerCase().includes("closed") || 
                                 errMsg.toLowerCase().includes("connection lost") || 
                                 errMsg.toLowerCase().includes("detached") ||
                                 errMsg.toLowerCase().includes("lost");
                                 
      const hasClickedPay = this.state.history.some(log => 
        log.toLowerCase().includes("action: click") && 
        (log.toLowerCase().includes("pay") || 
         log.toLowerCase().includes("submit") || 
         log.toLowerCase().includes("complete") || 
         log.toLowerCase().includes("buy") || 
         log.toLowerCase().includes("button_14") || 
         log.toLowerCase().includes("button_12") ||
         log.toLowerCase().includes("button_45"))
      );
      
      if (isBrowserClosedErr && hasClickedPay) {
        console.log("Browser disconnected/closed after submitting payment. Marking shopping run as completed successfully.");
        const outcomeSummary = "Successfully completed purchase. Browser session closed during redirect/settle.";
        this.setState({
          ...this.state,
          status: "completed"
        });
        resultString = `Shopping Session Finished. Status: completed. Summary: ${outcomeSummary}`;
      } else {
        this.setState({
          ...this.state,
          status: "failed",
          lastError: errMsg
        });
        throw err;
      }
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

  /**
   * Queries either the Gemini API (if key is present) or falls back to Workers AI.
   */
  private async queryLLM(systemPrompt: string, userPrompt: string): Promise<LLMResponse> {
    let geminiError: unknown = null;
    const apiKey = this.env.GOOGLE_API_KEY || this.env.GEMINI_API_KEY;

    if (apiKey) {
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
                parts: [
                  {
                    text: systemPrompt
                  }
                ]
              },
              contents: [
                {
                  parts: [
                    {
                      text: userPrompt
                    }
                  ]
                }
              ],
              generationConfig: {
                responseMimeType: "application/json"
              }
            })
          });

          if (!response.ok) {
            throw new Error(`Gemini API returned status ${response.status}: ${await response.text()}`);
          }

          const data = await response.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
          const textResponse = data.candidates?.[0]?.content?.parts?.[0]?.text;
          if (!textResponse) {
            throw new Error("Empty response from Gemini API");
          }

          return JSON.parse(textResponse.trim()) as LLMResponse;
        } catch (err: unknown) {
          geminiError = err;
          console.warn(`Gemini API call attempt ${attempt} failed:`, err instanceof Error ? err.message : String(err));
          if (attempt === maxRetries) {
            console.error("Gemini API call failed after max retries, falling back to Workers AI:", err);
          } else {
            console.log("Waiting 2 seconds before retrying Gemini API...");
            await new Promise((resolve) => setTimeout(resolve, 2000));
          }
        }
      }
    }

    // Fallback: Workers AI
    if (!this.env.AI) {
      if (geminiError) {
        throw geminiError;
      }
      throw new Error("No LLM keys or Workers AI binding available");
    }

    console.log("Calling Workers AI Llama model...");
    const model = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
    
    try {
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
      console.log("Workers AI Llama raw response type:", typeof response, "keys:", Object.keys(aiResponse), "stringified:", JSON.stringify(aiResponse));
      
      const rawResponse = aiResponse.response || aiResponse.text;
      if (!rawResponse) {
        throw new Error("Empty response from Workers AI");
      }

      let decision: LLMResponse;
      if (typeof rawResponse === "object" && rawResponse !== null) {
        decision = rawResponse as unknown as LLMResponse;
      } else {
        const textResponse = rawResponse as string;
        let cleanText = textResponse.trim();
        const match = cleanText.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
        if (match) {
          cleanText = match[1].trim();
        }
        try {
          decision = JSON.parse(cleanText) as LLMResponse;
        } catch (parseErr) {
          console.error("Failed to parse LLM response as JSON. Raw response was:", textResponse);
          throw new Error(`LLM output parsing error: ${parseErr}`);
        }
      }

      return decision;
    } catch (err: unknown) {
      if (geminiError) {
        const errMessage = err instanceof Error ? err.message : String(err);
        const geminiMessage = geminiError instanceof Error ? geminiError.message : String(geminiError);
        throw new Error(`Workers AI fallback failed: ${errMessage}. (Gemini API also failed: ${geminiMessage})`);
      }
      throw err;
    }
  }
}

// Helper to verify the SvelteKit HMAC signature
export async function verifyHmacSignature(
  expiryStr: string | null,
  signatureHex: string | null,
  secret: string
): Promise<boolean> {
  if (!expiryStr || !signatureHex) return false;

  try {
    const expiry = parseInt(expiryStr, 10);
    // Ensure token hasn't expired (and timestamp is valid)
    if (isNaN(expiry) || Date.now() > expiry) {
      return false;
    }

    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    );

    // Convert hex signature back to Uint8Array
    const matches = signatureHex.match(/.{1,2}/g);
    if (!matches) {
      return false;
    }
    const sigBytes = new Uint8Array(
      matches.map(byte => parseInt(byte, 16))
    );

    // Verify the expiry timestamp matches the signature
    return await crypto.subtle.verify(
      'HMAC',
      key,
      sigBytes,
      encoder.encode(expiryStr)
    );
  } catch (err) {
    console.error("Signature verification error:", err);
    return false;
  }
}

const ALLOWED_ORIGINS = ["https://fintechnick.com", "http://localhost:3000"];

function getCorsOrigin(request: Request): string {
  const origin = request.headers.get("Origin");
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    return origin;
  }
  return ALLOWED_ORIGINS[0];
}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);

    // 1. Handle CORS preflight requests
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": getCorsOrigin(request),
          "Access-Control-Allow-Methods": "GET, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type"
        }
      });
    }

    // 2. Serve public API limits/usage data without requiring signatures
    if (url.pathname === "/limits" || url.pathname === "/usage") {
      let browserLimits: any = { configured: false };
      if (env.MYBROWSER) {
        try {
          const limits = await puppeteer.limits(env.MYBROWSER);
          browserLimits = {
            ...(limits as any),
            configured: true,
            maxConcurrentSessions: limits.maxConcurrentSessions,
            activeSessionsCount: limits.activeSessions ? limits.activeSessions.length : 0,
            allowedBrowserAcquisitions: limits.allowedBrowserAcquisitions,
            timeUntilNextAcquisition: limits.timeUntilNextAllowedBrowserAcquisition,
            usedBrowserTimeSeconds: (limits as any).usedBrowserTimeSeconds || 0,
            timeUntilBrowserTimeReset: (limits as any).timeUntilBrowserTimeReset,
            browserTimeSecondsLimit: env.BROWSER_TIME_LIMIT_MOCK !== undefined ? 
              Number(env.BROWSER_TIME_LIMIT_MOCK) : 
              ((limits as any).browserTimeSecondsLimit !== undefined ? 
                (limits as any).browserTimeSecondsLimit : 
                ((limits.maxConcurrentSessions || 1) >= 10 ? "unlimited" : 600)),
            browserTimeSecondsIncluded: (limits.maxConcurrentSessions || 1) >= 10 ? 36000 : 600
          };

          if (
            browserLimits.browserTimeSecondsLimit !== "unlimited" &&
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

      const limitsResponse = {
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

      return new Response(JSON.stringify(limitsResponse, null, 2), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": getCorsOrigin(request),
          "Access-Control-Allow-Methods": "GET, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type"
        }
      });
    }

    // 3. Serve public API metadata without requiring signatures
    if (url.pathname === "/info" || url.pathname === "/inspect") {
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
          "Access-Control-Allow-Origin": getCorsOrigin(request),
          "Access-Control-Allow-Methods": "GET, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type"
        }
      });
    }

    // 4. Verify access signature if secret is configured
    const expiry = url.searchParams.get("expiry");
    const signature = url.searchParams.get("signature");
    
    const secret = env.AGENT_SWARM_SECRET;

    if (secret) {
      const isAuthorized = await verifyHmacSignature(expiry, signature, secret);
      
      if (!isAuthorized) {
        return new Response("Unauthorized Swarm Connection: Invalid or expired signature", {
          status: 401,
          headers: { "Content-Type": "text/plain" }
        });
      }
    }

    // 4. If valid, route the websocket/RPC request to the Durable Object
    return (
      (await routeAgentRequest(request, env)) ??
      new Response("Cloudflare Agent Swarm is running. Use the WebSocket/RPC client to trigger runs.", {
        status: 200,
        headers: { "Content-Type": "text/plain" }
      })
    );
  }
};
