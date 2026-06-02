import { AgentClient } from "agents/client";

async function main() {
  // Use localhost:8787 (default port for wrangler dev)
  const host = "localhost:8787";
  const agentClass = "ShopperAgent";
  const instanceId = `test-run-${Date.now()}`;

  console.log(`Initializing client connection to agent class "${agentClass}"...`);
  console.log(`Target Instance ID: ${instanceId}`);
  console.log(`Connecting via host: ${host}`);

  const client = new AgentClient({
    agent: agentClass,
    name: instanceId,
    host: host,
    onStateUpdate: (state) => {
      console.log(`\n[State Event] Status changed to: "${state.status}"`);
      if (state.history && state.history.length > 0) {
        console.log(`[Last Action Log]: ${state.history[state.history.length - 1]}`);
      }
    }
  });

  const testPersona = "A tech shopper looking to buy a sticker or low-cost product under $20";
  console.log(`\nInvoking runShopping RPC with persona: "${testPersona}"...`);

  try {
    // Wait for the websocket identity and connection to be ready
    await client.ready;
    
    // Pass the arguments as an array: [testPersona]
    const result = await client.call("runShopping", [testPersona]);
    console.log("\n========================================================");
    console.log("Agent Run Result:");
    console.log(result);
    console.log("========================================================");
  } catch (err) {
    console.error("\nFailed to execute agent run:", err);
  }

  // Force exit to close remaining WebSocket connections
  process.exit(0);
}

main().catch(console.error);
