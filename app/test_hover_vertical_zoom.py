import asyncio
from playwright.async_api import async_playwright

async def run():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context(viewport={"width": 1440, "height": 900})
        page = await context.new_page()

        console_errors = []
        page.on("console", lambda msg: console_errors.append(f"CONSOLE: {msg.type}: {msg.text}") if msg.type in ["error"] else None)
        page.on("pageerror", lambda exc: console_errors.append(f"PAGE ERROR: {exc}"))

        print("1. Navigating to index.html...")
        await page.goto("http://localhost:8080/app/static_app/index.html")
        await page.wait_for_selector("#modal-location-entry.open", timeout=8000)

        # 2. Click Preset Lyon
        print("2. Clicking Preset Lyon...")
        await page.click("#preset-lyon")
        await asyncio.sleep(1.2)

        # 3. Verify Selection Bar is on the RIGHT and VERTICAL
        print("3. Checking Selection Bar position and vertical layout...")
        bar_box = await page.locator("#territory-selection-bar").bounding_box()
        print(f"Selection bar bounding box: {bar_box}")
        # Viewport width is 1440, right edge is 1440 - 16 = 1424.
        assert bar_box["x"] > 1000, f"Expected selection bar to be on the right (x > 1000), got {bar_box['x']}"
        assert bar_box["height"] > 400, f"Expected vertical orientation (height > 400), got {bar_box['height']}"

        # Verify chips container is column
        chips_flex_dir = await page.evaluate("window.getComputedStyle(document.getElementById('sel-bar-chips')).flexDirection")
        print(f"Chips container flex-direction: {chips_flex_dir}")
        assert chips_flex_dir == "column", f"Expected column flex direction, got {chips_flex_dir}"

        # 4. Verify Zoom Level is zoomed out with margins around selection
        print("4. Verifying Map Zoom and Margins...")
        zoom = await page.evaluate("state.map.getZoom()")
        center = await page.evaluate("state.map.getCenter()")
        print(f"Map Zoom: {zoom:.2f}, Center: [{center['lng']:.4f}, {center['lat']:.4f}]")
        assert zoom < 12.0, f"Expected zoomed-out view (zoom < 12.0), got {zoom}"

        # 5. Take screenshot of the vertical selection panel on the right with zoomed-out view
        await page.screenshot(path="app/screenshot_selection_right_vertical.png")
        print("Saved app/screenshot_selection_right_vertical.png")

        # 6. Test Hovering on a Data Selection (Postal Zone)
        print("6. Testing Hover interaction and alpha changes...")
        # Hover on first sector pill in list
        first_pill = page.locator(".sel-chunk-pill").first
        await first_pill.hover()
        await asyncio.sleep(0.5)

        hover_state = await page.evaluate("""() => {
            const feat = state.postalZonesGeoJson.features.find(f => f.properties.chunk_id === 'cp_69001');
            const stateObj = state.map.getFeatureState({ source: 'postal-zones-source', id: feat.id });
            return { featId: feat.id, stateObj };
        }""")
        print(f"Hover state for cp_69001 on pill hover: {hover_state}")
        assert hover_state["stateObj"].get("hover") == True, "Expected featureState hover to be True!"

        # Screenshot with hover active
        await page.screenshot(path="app/screenshot_selection_hover.png")
        print("Saved app/screenshot_selection_hover.png")

        # 7. Test Recadrer button
        print("7. Testing Recadrer (Cadrer) button...")
        await page.click("#btn-sel-fit")
        await asyncio.sleep(0.8)
        zoom_after_fit = await page.evaluate("state.map.getZoom()")
        print(f"Zoom after recadrer: {zoom_after_fit:.2f}")
        assert zoom_after_fit < 12.0, f"Expected zoom after fit to be < 12.0, got {zoom_after_fit}"

        # 8. Test Deselection & Selection
        print("8. Testing removing a chunk from list...")
        initial_count = await page.locator(".sel-chunk-pill").count()
        first_remove_btn = page.locator(".btn-remove-chunk").first
        await first_remove_btn.click()
        await asyncio.sleep(0.4)
        new_count = await page.locator(".sel-chunk-pill").count()
        print(f"Count after remove: {new_count} (was {initial_count})")
        assert new_count == initial_count - 1, f"Expected {initial_count - 1}, got {new_count}"

        print("\nAll hover, vertical panel, and zoomed-out margin tests PASSED successfully!")
        assert len(console_errors) == 0, f"Encountered console errors: {console_errors}"

if __name__ == "__main__":
    asyncio.run(run())
