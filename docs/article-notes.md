Notes on topics for any article written about this project:

1. Hosting - needed to consider where agents would run
2. Orchestration - how to trigger multiple agents, and potentially how they interact
3. Model unit costs - the model we choose and its costs are more important
4. Other service costs, eg browsing - when agents act like humans they can incur other costs
5. Couldnt get scraping method to work:

[20:21:07] 1. Fetching pre-signed HMAC token from SvelteKit backend...
[20:21:07] ✅ Token retrieved successfully.
[20:21:07] 2. Connecting to WebSocket swarm at agent-swarm.nick-brett1.workers.dev...
[20:21:07] Session ID: swarm-session-1781396467920
[20:21:11] ✅ WebSocket connection established. Agent ready.
[20:21:11] 3. Invoking RPC runShopping with persona: "Find the Svelte 5 "Runes" Keychain and purchase it"
[20:21:21] Step 1: The Svelte 5 "Runes" Keychain is found on the page, and the corresponding "Buy Now" button should be clicked to add it to the cart and proceed with the purchase. -> Action: click on button_37
[20:21:40] Step 2: The page is on the Stripe checkout, and the credit card information needs to be filled in to proceed with the payment. The 'stripe_fill' action should be used to autofill the credit card details. -> Action: stripe_fill
[20:21:48] Step 3: The credit card information has been autofilled using the 'stripe_fill' action in the previous step. Now, we need to submit the payment by clicking the 'Pay' button. -> Action: click on button_14
[20:22:18] Step 4: The payment has been submitted, and now we are waiting for the payment to be processed. Since the button_14 is now 'Pay Processing', we should wait for the processing to complete. -> Action: wait
[20:22:27] Step 5: The payment is being processed, and the 'Pay' button is now 'Pay Processing'. We should wait for the processing to complete. -> Action: wait
[20:22:36] Step 6: The payment is being processed. The 'Pay' button is now 'Pay Processing'. We should wait for the processing to complete. -> Action: wait
[20:22:45] Step 7: The payment is still being processed, and the 'Pay' button is now 'Pay Processing'. We should wait for the processing to complete. -> Action: wait
[20:22:54] Step 8: The payment is still being processed. The 'Pay' button is now 'Pay Processing'. We should wait for the processing to complete. -> Action: wait
[20:23:03] Step 9: The payment is still being processed, and the 'Pay' button is now 'Pay Processing'. We should wait for the processing to complete. -> Action: wait
[20:23:13] Step 10: The payment is still being processed. The 'Pay' button is now 'Pay Processing'. We should wait for the processing to complete. -> Action: wait
[20:23:23] Step 11: The payment processing is likely taking some time, and the 'Pay' button is still in the 'Pay Processing' state. To ensure the payment is completed, we should wait for the processing to finish. -> Action: wait
[20:23:33] Step 12: The payment processing is still ongoing, and the 'Pay' button is in the 'Pay Processing' state. To ensure the payment is completed, we should wait for the processing to finish. -> Action: wait
[20:23:36] ❌ Error: Reached maximum action limit (12 steps) without finishing.