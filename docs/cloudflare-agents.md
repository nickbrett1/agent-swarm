# Project Overview: Autonomous Shopping Agents (Cloudflare Edition)

## Objective
Build a system of autonomous LLM-driven agents running natively on Cloudflare. These agents navigate target shops, dynamically evaluate products, and complete purchases using Stripe's test mode. 

By replacing heavy, hardcoded browser selectors and localized orchestration, we aim to establish a generic web-browsing agent that can run on any website with minimal configuration and near-zero infrastructure cost.

---

## Architecture & Tech Stack

*   **Language:** TypeScript
*   **Orchestration & State:** Cloudflare Agents SDK (built on Durable Objects with SQLite storage)
*   **LLM Model & Tools:** Cloudflare Workers AI (or Gemini API)
*   **Browser Automation:** Cloudflare Browser Rendering (via `@cloudflare/puppeteer`)
*   **Deployment:** Cloudflare Workers Edge Network

---

## Generic Browser Automation Approach

Rather than maintaining custom scraping selectors for every website:
1.  **DOM Compilation:** The agent extracts visual text and interactive elements (inputs, buttons, select fields) from the page.
2.  **Element Mapping:** Elements are mapped to simple alphanumeric IDs (e.g., `btn_3`, `txt_0`).
3.  **LLM Reasoning Loop:** The agent feeds the mapped elements and the shopper's goals to the LLM.
4.  **Targeted Action:** The LLM responds with a JSON payload defining the next target ID and input action, which the Puppeteer layer executes.

---

## Implementation Phases

### Phase 1: Planning and Architecture Setup
*   Define the architecture design docs (Completed).
*   Create Wrangler configuration bindings for the Browser Rendering and Durable Object namespace.

### Phase 2: Crawler & DOM Extraction
*   Write Puppeteer scripts to launch Cloudflare browser sessions.
*   Implement a parser to clean the raw HTML into a simplified list of interactive nodes.

### Phase 3: Agent Core Loop
*   Implement the `ShopperAgent` class extending Cloudflare's `Agent` SDK.
*   Implement the LLM decision loop using structural tool calling to output next action payloads.

### Phase 4: Checkout & Payment Handling
*   Handle Stripe iframes dynamically by detecting secure payment inputs and injecting test credentials.
*   Verify successful transaction redirects and store outcomes in SQLite.

### Phase 5: Production Deployment & Scheduling
*   Deploy to Cloudflare via `wrangler deploy`.
*   Establish recurring schedules using the Agents SDK's alarm system to run periodic checkout tests.
