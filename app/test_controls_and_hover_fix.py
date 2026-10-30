import asyncio
import json
from playwright.async_api import async_playwright

async def run():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context(viewport={"width": 1440, "height": 900})
        page = await context.new_page()

        console_errors = []
        page.on("console", lambda msg: console_errors.append(f"CONSOLE: {msg.type}: {msg.text}") if msg.type in ["error"] else None)
        page.on("pageerror", lambda exc: console_errors.append(f"PAGE ERROR: {exc}"))

        print("1. Opening app...")
        await page.goto("http://localhost:8080/app/static_app/index.html")
        await page.wait_for_selector("#modal-location-entry.open", timeout=8000)

        # 2. Check Map Color Selector position (in bottom-left stack, above legend)
        print("2. Checking Map Color Selector position...")
        color_selector_parent = await page.evaluate("document.querySelector('.map-floating-panel').parentElement.id")
        print(f"Color selector parent ID: {color_selector_parent}")
        assert color_selector_parent == "map-bottom-left-stack", f"Expected color selector in map-bottom-left-stack, got {color_selector_parent}"

        color_box = await page.locator(".map-floating-panel").bounding_box()
        print(f"Color selector bounding box: {color_box}")
        # Map pane starts after sidebar (sidebar is ~430px wide, so left of map is ~446px)
        assert color_box["x"] < 500, f"Expected color selector on the left of map (x < 500), got {color_box['x']}"
        assert color_box["y"] > 500, f"Expected color selector in bottom area (y > 500), got {color_box['y']}"

        # 3. Check Map Display Controls position (in bottom-right stack, above scale) and default collapsed
        print("3. Checking Map Display Controls position & default collapsed...")
        display_parent = await page.evaluate("document.getElementById('map-display-overlay').parentElement.className")
        print(f"Display overlay parent class: {display_parent}")
        assert "map-bottom-right-stack" in display_parent

        display_box = await page.locator("#map-display-overlay").bounding_box()
        print(f"Display overlay bounding box: {display_box}")
        # Viewport width is 1440, right side should be near 1440
        assert display_box["x"] > 1100, f"Expected display overlay on bottom-right (x > 1100), got {display_box['x']}"
        assert display_box["y"] > 750, f"Expected display overlay near bottom (y > 750), got {display_box['y']}"

        # Check default collapsed
        is_collapsed = await page.evaluate("document.getElementById('map-display-overlay').classList.contains('collapsed')")
        btn_arrow = await page.text_content("#btn-toggle-display-overlay")
        print(f"Default collapsed: {is_collapsed}, Toggle button text: '{btn_arrow.strip()}'")
        assert is_collapsed == True, "Expected map display controls to be default collapsed!"
        assert "▸" in btn_arrow, f"Expected collapsed arrow '▸', got '{btn_arrow}'"

        # 4. Enter territory selection with Lyon
        print("4. Selecting Lyon preset...")
        await page.click("#preset-lyon")
        await asyncio.sleep(1.0)

        # 5. TEST HOVER ACCURACY: Verify the EXACT polygon reacts, NOT the neighbor!
        print("5. Testing Hover highlighting accuracy on data chunks...")
        # Hover Lyon 1er (index 0, cp_69001)
        res_hover_1 = await page.evaluate("""() => {
            setPostalZoneHoverForChunk('cp_69001');
            const s0 = state.map.getFeatureState({ source: 'postal-zones-source', id: 0 });
            const s1 = state.map.getFeatureState({ source: 'postal-zones-source', id: 1 });
            const f0 = state.postalZonesGeoJson.features[0];
            const f1 = state.postalZonesGeoJson.features[1];
            return {
                f0Nom: f0.properties.nom,
                f0Hover: s0?.hover === true,
                f1Nom: f1.properties.nom,
                f1Hover: s1?.hover === true
            };
        }""")
        print(f"Hover result for cp_69001: {res_hover_1}")
        assert res_hover_1["f0Hover"] == True, "Feature 0 (Lyon 1er) did NOT react to hover!"
        assert res_hover_1["f1Hover"] == False, "Feature 1 (Lyon 2e) reacted when it should NOT!"

        # Hover Lyon 2e (index 1, cp_69002)
        res_hover_2 = await page.evaluate("""() => {
            setPostalZoneHoverForChunk('cp_69002');
            const s0 = state.map.getFeatureState({ source: 'postal-zones-source', id: 0 });
            const s1 = state.map.getFeatureState({ source: 'postal-zones-source', id: 1 });
            return {
                f0Hover: s0?.hover === true,
                f1Hover: s1?.hover === true
            };
        }""")
        print(f"Hover result for cp_69002: {res_hover_2}")
        assert res_hover_2["f0Hover"] == False, "Feature 0 (Lyon 1er) stayed hovered when hovering cp_69002!"
        assert res_hover_2["f1Hover"] == True, "Feature 1 (Lyon 2e) did NOT react to hover!"

        # Test hover on multi-commune chunk cp_38320
        res_hover_multi = await page.evaluate("""() => {
            setPostalZoneHoverForChunk('cp_38320');
            const allOfChunk = state.postalZonesGeoJson.features.filter(f => f.properties.chunk_id === 'cp_38320');
            const states = allOfChunk.map(f => state.map.getFeatureState({ source: 'postal-zones-source', id: f.id })?.hover);
            return {
                chunkCount: allOfChunk.length,
                allHovered: states.every(s => s === true)
            };
        }""")
        print(f"Multi-commune hover result for cp_38320: {res_hover_multi}")
        assert res_hover_multi["chunkCount"] > 1, "Expected multiple features for 38320"
        assert res_hover_multi["allHovered"] == True, "All communes in 38320 chunk should be hovered together!"

        # 6. Test Display Controls Expansion & Memorization in localStorage
        print("6. Testing Display Controls Expansion & localStorage persistence...")
        # Click header to expand
        await page.click("#header-toggle-display-overlay")
        await asyncio.sleep(0.3)
        expanded = await page.evaluate("!document.getElementById('map-display-overlay').classList.contains('collapsed')")
        btn_arrow_expanded = await page.text_content("#btn-toggle-display-overlay")
        assert expanded == True, "Expected display overlay to be expanded!"
        assert "▾" in btn_arrow_expanded, f"Expected expanded arrow '▾', got '{btn_arrow_expanded}'"

        # Change slider to 65%
        await page.evaluate("""() => {
            const slider = document.getElementById('slider-bg-dim');
            slider.value = 65;
            slider.dispatchEvent(new Event('input'));
        }""")
        await asyncio.sleep(0.3)

        # Change max polygons to 5000
        await page.evaluate("""() => {
            const select = document.getElementById('select-max-polygons');
            select.value = '5000';
            select.dispatchEvent(new Event('change'));
        }""")
        await asyncio.sleep(0.3)

        # Verify saved in localStorage
        stored_raw = await page.evaluate("localStorage.getItem('tezeloma_map_display_settings_v1')")
        print(f"Stored settings in localStorage: {stored_raw}")
        stored = json.loads(stored_raw)
        assert stored["collapsed"] == False, "Stored collapsed state should be False (expanded)"
        assert stored["bgDimPct"] == 65, f"Stored bgDimPct should be 65, got {stored['bgDimPct']}"
        assert stored["maxPolygons"] == 5000, f"Stored maxPolygons should be 5000, got {stored['maxPolygons']}"

        # Collapse again
        await page.click("#header-toggle-display-overlay")
        await asyncio.sleep(0.3)
        stored_raw_2 = await page.evaluate("localStorage.getItem('tezeloma_map_display_settings_v1')")
        stored_2 = json.loads(stored_raw_2)
        assert stored_2["collapsed"] == True, "Stored collapsed state should now be True"

        # Reload page and verify state restoration
        print("7. Reloading page to verify persistence...")
        await page.reload()
        await page.wait_for_selector("#map-display-overlay")
        await asyncio.sleep(1.0)

        restored_collapsed = await page.evaluate("document.getElementById('map-display-overlay').classList.contains('collapsed')")
        restored_slider = await page.evaluate("document.getElementById('slider-bg-dim').value")
        restored_label = await page.text_content("#label-bg-dim")
        restored_select = await page.evaluate("document.getElementById('select-max-polygons').value")

        print(f"Restored: collapsed={restored_collapsed}, slider={restored_slider}, label={restored_label}, select={restored_select}")
        assert restored_collapsed == True, "Expected display overlay to remain collapsed after reload"
        assert restored_slider == "65", f"Expected slider to be 65, got {restored_slider}"
        assert "65%" in restored_label, f"Expected label to be 65%, got {restored_label}"
        assert restored_select == "5000", f"Expected select to be 5000, got {restored_select}"

        # Take screenshot of final UI
        await page.screenshot(path="app/screenshot_display_controls_above_scale.png")
        print("Saved app/screenshot_display_controls_above_scale.png")

        print("\nALL tests passed successfully! Zero console errors.")
        assert len(console_errors) == 0, f"Encountered errors: {console_errors}"

if __name__ == "__main__":
    asyncio.run(run())
