import { Agent, routeAgentRequest, callable } from "agents";
import { PuppeteerBrowserHelper } from "./browser.js";

export interface Env {
  MYBROWSER: any;
  AI: any;
  GOOGLE_API_KEY?: string;
  SHOP_URL?: string;
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
   * RPC Endpoint to trigger a shopping run.
   */
  @callable()
  async runShopping(persona: string, url?: string): Promise<string> {
    this.setState({
      persona,
      history: [],
      status: "running",
      lastError: undefined
    });

    const targetUrl = url || this.env.SHOP_URL || "https://fintechnick.com/shop";
    const helper = new PuppeteerBrowserHelper(this.env.MYBROWSER);
    
    try {
      await helper.init();
      await helper.goto(targetUrl);
      
      const maxSteps = 10;
      let step = 0;
      let finished = false;
      let outcomeSummary = "";

      while (step < maxSteps && !finished) {
        step++;
        console.log(`--- Step ${step} ---`);
        
        // Check if the current URL is a success/thank-you/complete page
        const currentUrl = await helper.getPageUrl();
        if (currentUrl.toLowerCase().includes("success") || 
            currentUrl.toLowerCase().includes("thank") || 
            currentUrl.toLowerCase().includes("complete")) {
          console.log(`Success page detected: ${currentUrl}. Finishing shopping run.`);
          finished = true;
          outcomeSummary = `Successfully completed purchase. Redirected to: ${currentUrl}`;
          this.setState({ ...this.state, status: "completed" });
          break;
        }

        // 1. Get current page elements
        const pageData = await helper.getInteractiveElements();
        console.log(`Page URL: ${currentUrl}`);
        console.log(`Interactive nodes count: ${pageData.elements.length}`);

        // 2. Build the LLM prompt
        const prompt = this.buildLLMPrompt(persona, pageData.textSummary, this.state.history);

        // 3. Query LLM (Gemini or Workers AI)
        const decision = await this.queryLLM(prompt);
        console.log("LLM Decision:", JSON.stringify(decision, null, 2));

        const actionLog = `Step ${step}: ${decision.explanation} -> Action: ${decision.action}${decision.targetId ? ' on ' + decision.targetId : ''}${decision.text ? ' value="' + decision.text + '"' : ''}`;
        this.setState({
          ...this.state,
          history: [...this.state.history, actionLog]
        });

        // 4. Execute Action
        switch (decision.action) {
          case "click":
            if (!decision.targetId) {
              throw new Error("Action 'click' requires a 'targetId'");
            }
            // Check if the clicked element is a submit or pay button to wait longer
            const element = pageData.elements.find(e => e.id === decision.targetId);
            const isPayOrSubmit = element && (
              element.text.toLowerCase().includes("pay") ||
              element.text.toLowerCase().includes("submit") ||
              element.text.toLowerCase().includes("complete") ||
              element.text.toLowerCase().includes("buy") ||
              element.text.toLowerCase().includes("purchase")
            );

            const clickOk = await helper.clickElement(decision.targetId);
            if (!clickOk) {
              console.warn(`Click on ${decision.targetId} failed, trying to find alternatives...`);
            }

            if (isPayOrSubmit) {
              console.log("Pay/Submit/Buy button clicked, waiting 4 seconds for transaction/navigation to settle...");
              await helper.wait(4000);
            } else {
              await helper.wait(1500); // Wait for dynamic layout/routing
            }
            break;

          case "type":
            if (!decision.targetId || decision.text === undefined) {
              throw new Error("Action 'type' requires both 'targetId' and 'text'");
            }
            const typeOk = await helper.typeElement(decision.targetId, decision.text);
            if (!typeOk) {
              console.warn(`Type into ${decision.targetId} failed.`);
            }
            break;

          case "stripe_fill":
            // Automate Stripe iframe using test credentials from worker config or defaults
            const card = "4242 4242 4242 4242";
            const expiry = "12/28";
            const cvc = "123";
            const name = "Agent Shopper";
            console.log("Filling Stripe checkout details...");
            const stripeOk = await helper.handleStripeIframe(card, expiry, cvc, name);
            if (stripeOk) {
              console.log("Stripe card credentials filled successfully.");
            } else {
              console.warn("Could not find Stripe inputs. Continuing in case fields are on main page...");
            }
            await helper.wait(1000);
            break;

          case "wait":
            console.log("Waiting 3 seconds...");
            await helper.wait(3000);
            break;

          case "finish":
            finished = true;
            outcomeSummary = decision.explanation;
            this.setState({ ...this.state, status: "completed" });
            break;
        }

        // Small cooldown between actions
        await helper.wait(1000);
      }

      if (!finished) {
        outcomeSummary = "Reached maximum action limit (10 steps) without finishing.";
        this.setState({ ...this.state, status: "failed", lastError: outcomeSummary });
      }

      await helper.close();
      return `Shopping Session Finished. Status: ${this.state.status}. Summary: ${outcomeSummary}`;

    } catch (err: any) {
      console.error("Error during shopping execution:", err);
      this.setState({
        ...this.state,
        status: "failed",
        lastError: err.message
      });
      await helper.close();
      return `Shopping Session Failed: ${err.message}`;
    }
  }

  /**
   * Constructs a strict prompt for the LLM.
   */
  private buildLLMPrompt(persona: string, textSummary: string, history: string[]): string {
    return `
You are an autonomous e-commerce shopper agent executing inside a browser.
Your persona configuration: ${persona}

Your goal: Find a product that fits your persona, add it to the cart/buy it, and proceed through checkout using Stripe's test mode.

Here is the history of actions you have taken so far in this session:
${history.length > 0 ? history.map((h, i) => `${i+1}. ${h}`).join("\n") : "No actions taken yet."}

Here is the current state of the page:
---------------------------------------------
${textSummary}
---------------------------------------------

Decide the single next action to take. You must output a JSON object matching this schema:
{
  "explanation": "Brief thought explaining why you chose this action",
  "action": "click" | "type" | "stripe_fill" | "wait" | "finish",
  "targetId": "element_id from the interactive elements list (required if action is click or type)",
  "text": "text value to enter (required if action is type)"
}

Guidelines:
1. Review the element IDs closely. Choose the ID that best aligns with your next step.
2. If you are looking at a product catalog, click the "Buy Now" or "Add to Cart" button for a product matching your persona.
3. If you are on the Checkout page and see Credit Card, Expiration, or CVC inputs, use the "stripe_fill" action (which will autofill these inputs inside the iframe).
4. If you have submitted the payment and see a Success or Thank You page, output the "finish" action with a final success summary.
5. RESPOND WITH A RAW JSON OBJECT ONLY. DO NOT WRAP IT IN MARKDOWN CODE BLOCKS OR EXTRA TEXT.
`;
  }

  /**
   * Queries either the Gemini API (if key is present) or falls back to Workers AI.
   */
  private async queryLLM(prompt: string): Promise<LLMResponse> {
    let geminiError: any = null;

    if (this.env.GOOGLE_API_KEY) {
      const maxRetries = 3;
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${this.env.GOOGLE_API_KEY}`;
          const response = await fetch(url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              contents: [
                {
                  parts: [
                    {
                      text: prompt
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

          const data: any = await response.json();
          const textResponse = data.candidates?.[0]?.content?.parts?.[0]?.text;
          if (!textResponse) {
            throw new Error("Empty response from Gemini API");
          }

          return JSON.parse(textResponse.trim()) as LLMResponse;
        } catch (err: any) {
          geminiError = err;
          console.warn(`Gemini API call attempt ${attempt} failed:`, err.message || err);
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
    const model = "@cf/meta/llama-3-8b-instruct";
    
    try {
      const response = await this.env.AI.run(model, {
        messages: [
          { role: "system", content: "You are a helpful web assistant. You MUST respond with strict raw JSON matching the requested schema. No markdown formatting." },
          { role: "user", content: prompt }
        ]
      });

      const textResponse = response.response || response.text;
      if (!textResponse) {
        throw new Error("Empty response from Workers AI");
      }

      // Clean markdown blocks if LLM ignored instructions
      let cleanText = textResponse.trim();
      if (cleanText.startsWith("```json")) {
        cleanText = cleanText.substring(7, cleanText.length - 3).trim();
      } else if (cleanText.startsWith("```")) {
        cleanText = cleanText.substring(3, cleanText.length - 3).trim();
      }

      try {
        return JSON.parse(cleanText) as LLMResponse;
      } catch (parseErr) {
        console.error("Failed to parse LLM response as JSON. Raw response was:", textResponse);
        throw new Error(`LLM output parsing error: ${parseErr}`);
      }
    } catch (err: any) {
      if (geminiError) {
        throw new Error(`Workers AI fallback failed: ${err.message || err}. (Gemini API also failed: ${geminiError.message || geminiError})`);
      }
      throw err;
    }
  }
}

export default {
  async fetch(request: Request, env: Env) {
    // Route RPC and WebSocket connection requests to appropriate Durable Object agents
    return (
      (await routeAgentRequest(request, env)) ??
      new Response("Cloudflare Agent Swarm is running. Use the WebSocket/RPC client to trigger runs.", {
        status: 200,
        headers: { "Content-Type": "text/plain" }
      })
    );
  }
};
