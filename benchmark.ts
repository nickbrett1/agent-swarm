const history = [];
for (let i = 0; i < 10000; i++) {
  history.push("Some random text that is not a click action");
  history.push("Action: Type into field");
  history.push("Action: click on random button");
  history.push("action: click on button_14 to proceed"); // This one matches
}

console.time("baseline");
for (let i = 0; i < 100; i++) {
  const hasClickedPay = history.some(log =>
    log.toLowerCase().includes("action: click") &&
    (log.toLowerCase().includes("pay") ||
     log.toLowerCase().includes("submit") ||
     log.toLowerCase().includes("complete") ||
     log.toLowerCase().includes("buy") ||
     log.toLowerCase().includes("button_14") ||
     log.toLowerCase().includes("button_12") ||
     log.toLowerCase().includes("button_45"))
  );
}
console.timeEnd("baseline");

console.time("optimized");
for (let i = 0; i < 100; i++) {
  const hasClickedPay = history.some(log => {
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
}
console.timeEnd("optimized");
