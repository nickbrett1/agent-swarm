import asyncio
from playwright.async_api import async_playwright

async def inspect():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        page = await browser.new_page()
        await page.goto('https://fintechnick.com/shop')
        await page.wait_for_load_state('networkidle')
        
        # Find a "Buy Now" button and its parent/container
        container_info = await page.evaluate('''() => {
            const buyButton = Array.from(document.querySelectorAll('button')).find(b => b.innerText === 'Buy Now');
            if (!buyButton) return "No Buy Now button found";
            
            let container = buyButton.parentElement;
            // Go up until we find something that looks like a product card
            while (container && container.tagName !== 'BODY' && container.childElementCount < 3) {
                container = container.parentElement;
            }
            
            return {
                tagName: container.tagName,
                className: container.className,
                html: container.outerHTML.substring(0, 500)
            };
        }''')
        print(f"Container info: {container_info}")

        await browser.close()

if __name__ == "__main__":
    asyncio.run(inspect())
