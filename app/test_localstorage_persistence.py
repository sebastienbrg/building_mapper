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

        print("1. Opening app with fresh storage...")
        await page.goto("http://localhost:8080/app/static_app/index.html")
        await page.evaluate("() => localStorage.clear()")
        await page.reload()

        # Step 1: Initial location modal should be open on first visit
        print("2. Verifying Initial Location Prompt is shown on first visit...")
        await page.wait_for_selector("#modal-location-entry.open", timeout=8000)
        assert await page.is_visible("#modal-location-entry"), "Location prompt should be open on fresh visit"

        # Step 2: Select Lyon preset and validate
        print("3. Selecting Lyon Preset & Validating territory...")
        await page.click("#preset-lyon")
        await asyncio.sleep(0.5)
        await page.wait_for_selector("#btn-sel-validate", timeout=5000)
        await page.locator("#btn-sel-validate").click(force=True)

        # Wait for data to load
        print("4. Waiting for data to load...")
        for _ in range(40):
            txt = await page.text_content("#kpi-buildings")
            if txt and txt.strip() not in ["—", "0"]:
                print(f"Data loaded: {txt} buildings!")
                break
            await asyncio.sleep(0.5)

        total_bldgs = await page.text_content("#kpi-buildings")
        assert total_bldgs not in ["—", "0"], "Buildings data should be loaded"

        # Step 3: Switch Profile to 'summer_heat' via Filter Catalog modal
        print("5. Selecting 'Canicule & Bouilloires Été' profile...")
        await page.click("#btn-open-filter-catalog")
        await page.wait_for_selector("#modal-filter-catalog.open", timeout=5000)
        summer_btn = page.locator("#catalog-profile-buttons button.profile-pill-btn[data-profile-id='summer_heat']")
        await summer_btn.click()
        await asyncio.sleep(0.3)
        await page.click("#btn-apply-filter-catalog")
        await asyncio.sleep(0.5)

        # Verify profile name is displayed in sidebar button
        sidebar_profile = await page.text_content("#sidebar-active-profile-name")
        print(f"Active profile in sidebar: '{sidebar_profile}'")
        assert "Canicule" in sidebar_profile, f"Expected Canicule in sidebar, got '{sidebar_profile}'"

        # Step 4: Adjust a filter value (score_surchauffe_ete slider)
        print("6. Modifying filter value (score_surchauffe_ete slider to 25)...")
        slider_card = page.locator(".dyn-filter-card[data-filter-id='score_surchauffe_ete']")
        await slider_card.wait_for(timeout=5000)
        slider_input = slider_card.locator("input[type='range']")
        await slider_input.fill("25")
        await slider_input.dispatch_event("input")
        await asyncio.sleep(0.5)

        val_label = await slider_card.locator("#lbl-val-score_surchauffe_ete").text_content()
        print(f"Slider value label: {val_label}")
        assert "25" in val_label, f"Expected 25 in label, got {val_label}"

        # Step 5: Switch to Tab 2: 'Bâtiments'
        print("7. Switching to Tab 2: 'Bâtiments'...")
        await page.click("button[data-tab='buildings']")
        await asyncio.sleep(0.5)
        pane_active = await page.is_visible("#pane-buildings")
        assert pane_active, "Bâtiments pane should be visible"

        # Step 6: Verify localStorage content before reload
        print("8. Checking localStorage content...")
        raw_storage = await page.evaluate("() => localStorage.getItem('tezeloma_session_state_v1')")
        assert raw_storage is not None, "tezeloma_session_state_v1 must exist in localStorage"
        session_data = json.loads(raw_storage)
        print("Stored territoryData:", session_data["territoryData"])
        print("Stored activeProfileId:", session_data["activeProfileId"])
        print("Stored screenState:", session_data["screenState"])
        assert session_data["territoryData"]["hasLoadedData"] is True
        assert len(session_data["territoryData"]["activeTerritory"]["chunkIds"]) == 10
        assert session_data["activeProfileId"] == "summer_heat"
        assert session_data["filterValues"]["score_surchauffe_ete"] == 25
        assert session_data["screenState"]["activeTab"] == "buildings"
        assert session_data["screenState"]["mapStyleMode"] == "overheating"

        await page.screenshot(path="app/test_persistence_before_reload.png")

        # Step 7: RELOAD PAGE!
        print("9. Reloading page (F5 / Refresh)...")
        await page.reload()

        # Step 8: Verify user returns to the exact same screen on refresh!
        print("10. Verifying state after refresh...")

        # Modal location prompt must NOT be open!
        modal_open = await page.locator("#modal-location-entry.open").count()
        assert modal_open == 0, "Location prompt modal must NOT be open on refresh when data is loaded!"

        # Wait for data to be restored
        for _ in range(40):
            txt = await page.text_content("#kpi-buildings")
            if txt and txt.strip() not in ["—", "0"]:
                print(f"Data successfully restored: {txt} buildings!")
                break
            await asyncio.sleep(0.5)

        restored_bldgs = await page.text_content("#kpi-buildings")
        assert restored_bldgs not in ["—", "0"], "Buildings data should be restored"

        # Verify active tab is still Tab 2: 'Bâtiments'
        tab_buildings_class = await page.locator("button[data-tab='buildings']").get_attribute("class")
        assert "active" in tab_buildings_class, "Bâtiments tab must remain active on refresh"
        assert await page.is_visible("#pane-buildings"), "Bâtiments pane must be visible on refresh"

        # Verify profile is still 'summer_heat'
        sidebar_profile_reloaded = await page.text_content("#sidebar-active-profile-name")
        print(f"Restored profile in sidebar: '{sidebar_profile_reloaded}'")
        assert "Canicule" in sidebar_profile_reloaded, f"Expected Canicule in sidebar after refresh, got '{sidebar_profile_reloaded}'"
        summer_btn_reloaded = page.locator("#catalog-profile-buttons button.profile-pill-btn[data-profile-id='summer_heat']")
        btn_class_reloaded = await summer_btn_reloaded.get_attribute("class")
        assert "active" in btn_class_reloaded, "Summer heat profile button in catalog must remain active on refresh"

        # Verify filter value is still 25
        slider_card_reloaded = page.locator(".dyn-filter-card[data-filter-id='score_surchauffe_ete']")
        val_label_reloaded = await slider_card_reloaded.locator("#lbl-val-score_surchauffe_ete").text_content()
        print(f"Restored slider value label: {val_label_reloaded}")
        assert "25" in val_label_reloaded, f"Expected 25 in label after refresh, got {val_label_reloaded}"

        restored_slider_val = await slider_card_reloaded.locator("input[type='range']").input_value()
        assert restored_slider_val == "25", f"Slider range value should be 25, got {restored_slider_val}"

        # Verify sidebar button displays territory status
        status_text = await page.text_content("#sidebar-data-count")
        print(f"Sidebar data count: {status_text}")
        assert "bât" in status_text, "Sidebar count should display loaded buildings count"

        # Switch to Map tab and verify map is displayed with overheating style active
        print("11. Switching to Map tab and verifying mapStyleMode...")
        await page.click("button[data-tab='map']")
        await asyncio.sleep(0.5)
        overheating_style_btn = page.locator("button.map-style-btn[data-style='overheating']")
        btn_style_class = await overheating_style_btn.get_attribute("class")
        assert "active" in btn_style_class, "Map style button 'overheating' must remain active"

        await page.screenshot(path="app/test_persistence_after_reload.png")
        print("12. All assertions PASSED! State persistence works flawlessly.")

        if console_errors:
            print("Console errors found:", console_errors)

        await browser.close()

if __name__ == "__main__":
    asyncio.run(run())
