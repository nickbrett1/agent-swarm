const { performance } = require('perf_hooks');

function testPerformance() {
  const currentUrl = "https://example.com/thank-you";

  // Original
  const startOriginal = performance.now();
  let countOriginal = 0;
  for (let i = 0; i < 1000000; i++) {
    if (currentUrl.toLowerCase().includes("success") ||
        currentUrl.toLowerCase().includes("thank") ||
        currentUrl.toLowerCase().includes("complete")) {
      countOriginal++;
    }
  }
  const endOriginal = performance.now();

  // Optimized
  const startOptimized = performance.now();
  let countOptimized = 0;
  for (let i = 0; i < 1000000; i++) {
    const lowerUrl = currentUrl.toLowerCase();
    if (lowerUrl.includes("success") ||
        lowerUrl.includes("thank") ||
        lowerUrl.includes("complete")) {
      countOptimized++;
    }
  }
  const endOptimized = performance.now();

  console.log(`Original: ${endOriginal - startOriginal} ms`);
  console.log(`Optimized: ${endOptimized - startOptimized} ms`);
  console.log(`Improvement: ${((endOriginal - startOriginal) - (endOptimized - startOptimized)) / (endOriginal - startOriginal) * 100}%`);
}

testPerformance();
