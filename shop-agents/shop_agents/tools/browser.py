import asyncio
from playwright.async_api import async_playwright
from crewai.tools import BaseTool
from shop_agents.config import settings


class ProductScraperTool(BaseTool):
    name: str = "product_scraper"
    description: str = "Navigates to the shop and returns a list of available products with their names, prices, and IDs."

    def _run(self) -> str:
        """Fetch products synchronously for CrewAI."""
        return asyncio.run(self._fetch_products())

    async def _fetch_products(self) -> str:
        """Perform the actual scraping with Playwright."""
        async with async_playwright() as p:
            browser = await p.chromium.launch(headless=True)
            page = await browser.new_page()
            await page.goto(settings.shop_url)

            # Extract products (assuming standard list-of-items structure)
            # We'll grab text content for simplicity in the MVP
            products = await page.evaluate('''() => {
                const items = Array.from(document.querySelectorAll('.product, [class*="product"]'));
                if (items.length === 0) return document.body.innerText; // Fallback
                return items.map(item => item.innerText).join('\\n---\\n');
            }''')

            await browser.close()
            return products


class PurchaseTool(BaseTool):
    name: str = "purchase_tool"
    description: str = "Initiates a purchase for a product. Provide the product name or ID as input."

    def _run(self, product_identifier: str) -> str:
        """Simulate clicking buy and handling Stripe Checkout."""
        return asyncio.run(self._initiate_purchase(product_identifier))

    async def _initiate_purchase(self, product_identifier: str) -> str:
        async with async_playwright() as p:
            browser = await p.chromium.launch(headless=True)
            page = await browser.new_page()
            await page.goto(settings.shop_url)

            # Find the buy button associated with the product
            # In simple shop sites, look for the text match and the nearest button
            try:
                # Find element containing product identifier and click buy
                await page.get_by_text(product_identifier).first.scroll_into_view_if_needed()
                # Find 'Buy' button near that text or a button within the same container
                buy_button = page.locator(
                    f"xpath=//*[contains(text(), '{product_identifier}')]/ancestor::*[.//button]//button")
                if await buy_button.count() == 0:
                    # Fallback to any 'Buy' button near the text
                    buy_button = page.get_by_role("button", name="Buy").first

                await buy_button.click()
                await page.wait_for_load_state("networkidle")

                # Check if we are on Stripe Checkout
                if "checkout.stripe.com" in page.url:
                    # Fill Stripe Elements
                    await page.get_by_label("Email").fill("agent@example.com")
                    await page.get_by_label("Card number").fill(settings.stripe_test_card)
                    await page.get_by_placeholder("MM / YY").fill(settings.stripe_test_expiry)
                    await page.get_by_placeholder("CVC").fill(settings.stripe_test_cvc)
                    await page.get_by_label("Name on card").fill("Agent Shopper")

                    # Submit
                    await page.get_by_role("button", name="Pay").click()
                    await page.wait_for_load_state("networkidle")

                    final_url = page.url
                    await browser.close()
                    return f"Successfully processed payment. Final page: {final_url}"
                else:
                    url = page.url
                    await browser.close()
                    return f"Failed to reach Stripe Checkout. Current URL: {url}"
            except Exception as e:
                await browser.close()
                return f"Error during purchase process: {str(e)}"
