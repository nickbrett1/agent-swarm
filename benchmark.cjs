const { performance } = require('perf_hooks');

const STRIPE_CARD_SELECTORS = ['input#cardNumber'];
const STRIPE_EXPIRY_SELECTORS = ['input#cardExpiry'];
const STRIPE_CVC_SELECTORS = ['input#cardCvc'];
const STRIPE_NAME_SELECTORS = ['input#billingName'];

async function fillInFrame(frame, selectors, value) {
  // simulate async work
  await new Promise(r => setTimeout(r, 1));
  if (frame.hasFields) {
    return true;
  }
  return false;
}

async function runSequential(frames) {
  let cardFilled = false, expiryFilled = false, cvcFilled = false;

  const fillFramesSequentially = async (index) => {
    if (index >= frames.length) return;
    const frame = frames[index];
    if (!cardFilled) cardFilled = await fillInFrame(frame, STRIPE_CARD_SELECTORS, "1");
    if (!expiryFilled) expiryFilled = await fillInFrame(frame, STRIPE_EXPIRY_SELECTORS, "2");
    if (!cvcFilled) cvcFilled = await fillInFrame(frame, STRIPE_CVC_SELECTORS, "3");
    await fillFramesSequentially(index + 1);
  };
  await fillFramesSequentially(0);

  let nameFilled = false;
  const fillNameSequentially = async (index) => {
    if (index >= frames.length) return;
    const frame = frames[index];
    if (!nameFilled) nameFilled = await fillInFrame(frame, STRIPE_NAME_SELECTORS, "4");
    await fillNameSequentially(index + 1);
  };
  await fillNameSequentially(0);
  return {cardFilled, expiryFilled, cvcFilled, nameFilled};
}

async function runConcurrent(frames) {
  let cardFilled = false, expiryFilled = false, cvcFilled = false;

  await Promise.all(frames.map(async (frame) => {
    if (!cardFilled) {
      const filled = await fillInFrame(frame, STRIPE_CARD_SELECTORS, "1");
      if (filled) cardFilled = true;
    }
    if (!expiryFilled) {
      const filled = await fillInFrame(frame, STRIPE_EXPIRY_SELECTORS, "2");
      if (filled) expiryFilled = true;
    }
    if (!cvcFilled) {
      const filled = await fillInFrame(frame, STRIPE_CVC_SELECTORS, "3");
      if (filled) cvcFilled = true;
    }
  }));

  let nameFilled = false;
  await Promise.all(frames.map(async (frame) => {
    if (!nameFilled) {
      const filled = await fillInFrame(frame, STRIPE_NAME_SELECTORS, "4");
      if (filled) nameFilled = true;
    }
  }));
  return {cardFilled, expiryFilled, cvcFilled, nameFilled};
}

async function main() {
  const frames = [];
  for (let i = 0; i < 50; i++) {
    frames.push({ hasFields: i === 49 });
  }

  const startSeq = performance.now();
  await runSequential(frames);
  const endSeq = performance.now();
  console.log(`Sequential: ${endSeq - startSeq}ms`);

  const startConc = performance.now();
  await runConcurrent(frames);
  const endConc = performance.now();
  console.log(`Concurrent: ${endConc - startConc}ms`);
}

main();
