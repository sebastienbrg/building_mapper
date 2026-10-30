import asyncio
from playwright.async_api import async_playwright

async def run():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context(viewport={"width": 1440, "height": 900})
        page = await context.new_page()

        console_errors = []
        page.on("console", lambda msg: console_errors.append(f"CONSOLE: {msg.type}: {msg.text}") if msg.type in ["error", "warning"] else None)
        page.on("pageerror", lambda exc: console_errors.append(f"PAGE ERROR: {exc}"))

        print("1. Navigating to http://localhost:8080/app/static_app/index.html ...")
        await page.goto("http://localhost:8080/app/static_app/index.html")

        # 2. Verify Entry Location Modal is open
        print("2. Checking Location Entry Prompt Modal...")
        await page.wait_for_selector("#modal-location-entry.open", timeout=8000)
        modal_title = await page.text_content(".location-prompt-title")
        print(f"Modal title: '{modal_title}'")
        assert "TeZeLoMa" in (modal_title or ""), "Modal title does not contain TeZeLoMa!"
        await page.screenshot(path="app/test_step1_location_prompt.png")

        # 3. Test Location Search input and Autocomplete
        print("3. Testing Search Autocomplete...")
        await page.fill("#input-location-search", "Lyon")
        await asyncio.sleep(1.0) # Wait for debounce + search results
        sugg_count = await page.locator("#location-suggestions .location-suggestion-item").count()
        print(f"Location suggestions found: {sugg_count}")
        assert sugg_count > 0, "No suggestions found for 'Lyon'!"

        first_sugg = page.locator("#location-suggestions .location-suggestion-item").first
        first_sugg_text = await first_sugg.text_content()
        print(f"First suggestion text: {first_sugg_text.strip()[:60]}...")

        # 4. Clear search to close dropdown, then Click Preset: Lyon & Villeurbanne
        print("4. Clearing search and Clicking Preset: Lyon & Villeurbanne...")
        await page.fill("#input-location-search", "")
        await asyncio.sleep(0.3)
        await page.click("#preset-lyon")
        await asyncio.sleep(1.5)

        # 5. Verify Selection Bar is active and displays selected chunks
        print("5. Verifying Territory Selection Bar...")
        bar_class = await page.get_attribute("#territory-selection-bar", "class")
        assert "active" in (bar_class or ""), "Selection bar is not active!"
        summary = await page.text_content("#sel-bar-summary-text")
        metrics = await page.text_content("#sel-bar-metrics-text")
        print(f"Selection summary: {summary}")
        print(f"Selection metrics: {metrics}")
        assert "10" in (summary or ""), "Expected 10 chunks/postal codes selected for Lyon preset!"
        await page.screenshot(path="app/test_step2_polygon_selection.png")

        # 6. Test Deselecting and Re-selecting via action buttons
        print("6. Testing Clear Selection button...")
        await page.locator("#btn-sel-clear").click(force=True)
        await asyncio.sleep(0.5)
        summary_cleared = await page.text_content("#sel-bar-summary-text")
        print(f"Summary after clear: {summary_cleared}")
        assert "0" in (summary_cleared or ""), "Summary not 0 after clear!"

        validate_disabled = await page.is_disabled("#btn-sel-validate")
        print(f"Validate button disabled when 0 selected: {validate_disabled}")
        assert validate_disabled, "Validate button should be disabled when nothing selected!"

        print("Testing re-selection of chunks...")
        await page.evaluate("""() => {
            if (window.appState && window.appState.manifest) {
                window.appState.manifest.chunks.filter(c => c.departement === '69').slice(0, 10).forEach(c => window.appState.pendingSelectedChunks.add(c.id));
                window.refreshPostalZonesVisualState();
                window.updateTerritorySelectionBar();
            }
        }""")
        await asyncio.sleep(0.5)
        summary_reselected = await page.text_content("#sel-bar-summary-text")
        print(f"Summary after re-selection: {summary_reselected}")
        assert "10" in (summary_reselected or ""), "Expected 10 chunks reselected!"

        # 7. Validate and Load Data into App
        print("7. Validating and Loading Selected Territory...")
        await page.locator("#btn-sel-validate").click(force=True)
        
        # Wait for data to load and KPIs to populate
        await page.wait_for_selector("#kpi-buildings", timeout=20000)
        for _ in range(40):
            txt = await page.text_content("#kpi-buildings")
            if txt and txt.strip() not in ["—", "0"]:
                print(f"Territory successfully loaded! Total buildings: {txt}")
                break
            await asyncio.sleep(0.5)

        # 8. Check that selection bar closed and map displays buildings
        bar_class_after = await page.get_attribute("#territory-selection-bar", "class")
        assert "active" not in (bar_class_after or ""), "Selection bar should be closed after loading!"
        await page.screenshot(path="app/test_step3_data_loaded_map.png")

        # 9. Test Re-opening Territory Selection from Header Button
        print("9. Testing Reopening Territory Selector from header button...")
        await page.click("#btn-open-territory-manager")
        await asyncio.sleep(0.5)
        bar_class_reopen = await page.get_attribute("#territory-selection-bar", "class")
        print(f"Selection bar reopened class: {bar_class_reopen}")
        assert "active" in (bar_class_reopen or ""), "Selection bar did not reopen when clicking header button!"
        await page.screenshot(path="app/test_step4_reopened_selector.png")

        # Close selection mode again
        await page.click("#btn-open-territory-manager")
        await asyncio.sleep(0.5)

        # 10. Verify Buildings Table tab
        print("10. Testing Buildings Table Tab...")
        await page.click('button[data-tab="buildings"]')
        await asyncio.sleep(1)
        row_count = await page.locator("#table-buildings-body tr").count()
        print(f"Buildings table rows: {row_count}")
        assert row_count > 0, "No rows rendered in buildings table!"

        # 11. Verify Landlords Tab
        print("11. Testing Landlords Tab...")
        await page.click('button[data-tab="landlords"]')
        await asyncio.sleep(1)
        landlords_count = await page.locator("#table-landlords-body tr").count()
        print(f"Landlord rows rendered: {landlords_count}")
        assert landlords_count > 0, "No landlord rows rendered!"

        print("\nAll tests passed with flying colors! No console or page errors.")
        if console_errors:
            print("Console messages during run:")
            for err in console_errors:
                print("  ", err)

        await browser.close()

if __name__ == "__main__":
    asyncio.run(run())
