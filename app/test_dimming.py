import asyncio
from playwright.async_api import async_playwright

async def run():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context(viewport={"width": 1440, "height": 900})
        page = await context.new_page()

        print("Navigating to app...")
        await page.goto("http://localhost:8080/app/static_app/index.html")

        # Load Lyon
        print("Selecting Lyon preset...")
        await page.wait_for_selector("#preset-lyon", timeout=10000)
        await page.click("#preset-lyon")
        await asyncio.sleep(0.5)

        await page.wait_for_selector("#btn-sel-validate", timeout=5000)
        await page.locator("#btn-sel-validate").click(force=True)

        # Wait until data loaded
        await page.wait_for_selector("#kpi-buildings", timeout=15000)
        for _ in range(30):
            txt = await page.text_content("#kpi-buildings")
            if txt and txt.strip() not in ["—", "0"]:
                break
            await asyncio.sleep(0.5)

        await asyncio.sleep(1.0)

        # 1. Slider at 0% (Full normal background)
        print("Testing dimming at 0%...")
        await page.evaluate("""() => {
            const slider = document.getElementById('slider-bg-dim');
            slider.value = 0;
            slider.dispatchEvent(new Event('input'));
        }""")
        await asyncio.sleep(0.8)
        label_0 = await page.text_content("#label-bg-dim")
        print(f"Label at 0%: {label_0}")
        assert "0%" in label_0
        await page.screenshot(path="app/test_dim_0_normal.png")

        # 2. Slider at 50% (Softened / partially white)
        print("Testing dimming at 50%...")
        await page.evaluate("""() => {
            const slider = document.getElementById('slider-bg-dim');
            slider.value = 50;
            slider.dispatchEvent(new Event('input'));
        }""")
        await asyncio.sleep(0.8)
        label_50 = await page.text_content("#label-bg-dim")
        print(f"Label at 50%: {label_50}")
        assert "50%" in label_50
        await page.screenshot(path="app/test_dim_50_whitened.png")

        # 3. Slider at 100% (Fully white background)
        print("Testing dimming at 100%...")
        await page.evaluate("""() => {
            const slider = document.getElementById('slider-bg-dim');
            slider.value = 100;
            slider.dispatchEvent(new Event('input'));
        }""")
        await asyncio.sleep(0.8)
        label_100 = await page.text_content("#label-bg-dim")
        print(f"Label at 100%: {label_100}")
        assert "100%" in label_100
        await page.screenshot(path="app/test_dim_100_full_white.png")

        print("Dimming test complete! Screenshots saved.")
        await browser.close()

if __name__ == "__main__":
    asyncio.run(run())
