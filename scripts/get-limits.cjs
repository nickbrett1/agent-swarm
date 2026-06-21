#!/usr/bin/env node
// scripts/get-limits.js

const http = require('node:http');

// Get port from command line arguments or default to 8787
const args = process.argv.slice(2);
let port = 8787;
const portArgIndex = args.indexOf('--port');
if (portArgIndex !== -1 && args[portArgIndex + 1]) {
  port = Number.parseInt(args[portArgIndex + 1], 10);
}

const url = `http://localhost:${port}/limits`;

console.log(`Connecting to local server at ${url}...`);

const request = http.get(url, (res) => {
  let data = '';

  res.on('data', (chunk) => {
    data += chunk;
  });

  res.on('end', () => {
    if (res.statusCode !== 200) {
      console.error(`\n❌ Request failed with status code ${res.statusCode}`);
      process.exit(1);
    }

    try {
      const parsed = JSON.parse(data);
      printLimits(parsed);
    } catch (err) {
      console.error('\n❌ Failed to parse JSON response:', err.message);
      process.exit(1);
    }
  });
});

request.on('error', (err) => {
  console.error(`\n❌ Error: Could not connect to local server on port ${port}.`);
  console.error('   Please ensure that wrangler dev is running (npm run dev).');
  console.error(`   Details: ${err.message}`);
  process.exit(1);
});

function formatTime(seconds) {
  if (seconds === undefined || seconds === null) return 'N/A';
  if (typeof seconds === 'string') return seconds;
  const mins = Math.floor(seconds / 60);
  const secs = (seconds % 60).toFixed(1);
  return `${seconds.toFixed(1)}s (${mins}m ${secs}s)`;
}

function printLimits(data) {
  const browser = data.browser || { configured: false };
  const llm = data.primary_llm || { configured: false };

  console.log('\n========================================================');
  console.log('             CLOUDFLARE SWARM AGENT LIMITS              ');
  console.log('========================================================\n');

  console.log('🖥️  Browser Rendering (env.MYBROWSER):');
  if (browser.configured) {
    console.log(`   Status:                     ✅ Configured`);
    
    if (browser.error) {
      console.log(`   ⚠️  Error querying limits:  ${browser.error}`);
    } else {
      const activeCount = browser.activeSessionsCount ?? 0;
      const maxSessions = browser.maxConcurrentSessions ?? 'N/A';
      console.log(`   Active Sessions:            ${activeCount} / ${maxSessions}`);
      console.log(`   Browser Acquisitions:       ${browser.allowedBrowserAcquisitions ?? 'N/A'} allowed`);
      console.log(`   Time Until Next Allowed:    ${browser.timeUntilNextAcquisition ?? 0} ms`);
      
      const usedTime = browser.usedBrowserTimeSeconds;
      const limitTime = browser.browserTimeSecondsLimit;
      const includedTime = browser.browserTimeSecondsIncluded ?? ((browser.maxConcurrentSessions || 1) >= 10 ? 36000 : 600);
      const limitText = typeof limitTime === 'number' ? formatTime(limitTime) : limitTime;
      
      console.log(`   Used Browser Time:          ${formatTime(usedTime)}`);
      console.log(`   Included Time (No Charge):  ${formatTime(includedTime)}`);
      console.log(`   Hard Blocking Limit:        ${limitText}`);
      
      if (typeof limitTime === 'number' && usedTime >= limitTime) {
        console.log(`   🚨 Daily limit exceeded:    YES`);
      } else if (usedTime >= includedTime) {
        console.log(`   🚨 Included time exceeded:  YES (billed at $0.09/hr overage)`);
      } else {
        console.log(`   🚨 Limit exceeded:          NO`);
      }
      
      if (browser.timeUntilBrowserTimeReset !== undefined) {
        console.log(`   Time Until Reset:           ${formatTime(browser.timeUntilBrowserTimeReset)}`);
      }
    }
  } else {
    console.log(`   Status:                     ❌ Not Configured`);
  }

  console.log('\n🧠 Cloudflare Workers AI (env.AI):');
  if (llm.configured) {
    console.log(`   Status:                     ✅ Configured`);
  } else {
    console.log(`   Status:                     ❌ Not Configured`);
  }

  console.log('\n========================================================');
}
