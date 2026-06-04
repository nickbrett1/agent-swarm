const NUM_ITERATIONS = 1000000;

function unoptimized(text: string) {
  return text.toLowerCase().includes("pay") ||
         text.toLowerCase().includes("submit") ||
         text.toLowerCase().includes("complete") ||
         text.toLowerCase().includes("buy") ||
         text.toLowerCase().includes("purchase");
}

function optimized(text: string) {
  const lowerText = text.toLowerCase();
  return lowerText.includes("pay") ||
         lowerText.includes("submit") ||
         lowerText.includes("complete") ||
         lowerText.includes("buy") ||
         lowerText.includes("purchase");
}

const testStrings = [
  "Click here to purchase the item",
  "This is just some random text",
  "SUBMIT YOUR ORDER NOW",
  "Complete your profile",
  "Buy this thing",
];

console.log(`Running benchmark for ${NUM_ITERATIONS} iterations...`);

let start = performance.now();
for (let i = 0; i < NUM_ITERATIONS; i++) {
  unoptimized(testStrings[i % testStrings.length]);
}
let end = performance.now();
const unoptTime = end - start;
console.log(`Unoptimized: ${unoptTime.toFixed(2)} ms`);

start = performance.now();
for (let i = 0; i < NUM_ITERATIONS; i++) {
  optimized(testStrings[i % testStrings.length]);
}
end = performance.now();
const optTime = end - start;
console.log(`Optimized: ${optTime.toFixed(2)} ms`);

console.log(`Improvement: ${((unoptTime - optTime) / unoptTime * 100).toFixed(2)}%`);
