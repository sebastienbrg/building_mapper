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

        print("Navigating to http://localhost:8080/app/static_app/index.html ...")
        await page.goto("http://localhost:8080/app/static_app/index.html")

        # Handle initial Location Entry Prompt
        print("Selecting Lyon Preset from Location Prompt...")
        await page.wait_for_selector("#preset-lyon", timeout=10000)
        await page.click("#preset-lyon")
        await asyncio.sleep(0.5)

        # Validate and Load Selected Territory
        await page.wait_for_selector("#btn-sel-validate", timeout=5000)
        await page.locator("#btn-sel-validate").click(force=True)

        # Wait for data to load
        await page.wait_for_selector("#kpi-buildings", timeout=20000)
        for _ in range(30):
            txt = await page.text_content("#kpi-buildings")
            if txt and txt.strip() not in ["—", "0"]:
                print(f"Data loaded: {txt} buildings!")
                break
            await asyncio.sleep(0.5)

        # Navigate to Tab 5: Sources de données
        print("Clicking Tab 5: Sources de données...")
        await page.click('button[data-tab="sources"]')
        await asyncio.sleep(0.8)

        # Verify Info-Oriented view is visible by default
        is_info_visible = await page.is_visible("#sources-subview-info")
        print(f"Info-oriented subview visible: {is_info_visible}")
        assert is_info_visible, "Info-oriented subview is not visible!"

        # Verify total rows rendered
        rows_count = await page.locator("#table-sources-dict-body tr").count()
        print(f"Total dictionary rows rendered: {rows_count}")
        assert rows_count >= 80, f"Expected at least 80 rows, got {rows_count}"

        feedback_text = await page.text_content("#sources-filter-feedback")
        print(f"Feedback text: {feedback_text}")
        assert "sur" in feedback_text, "Feedback text missing 'sur'"

        # Take screenshot of default Info-Oriented view
        await page.screenshot(path="app/test_sources_info_view_default.png")

        # Test Search Filter
        print("Testing text search for 'classe_bilan_dpe'...")
        await page.fill("#sources-search-input", "classe_bilan_dpe")
        await asyncio.sleep(0.3)
        filtered_count = await page.locator("#table-sources-dict-body tr").count()
        print(f"Filtered rows for 'classe_bilan_dpe': {filtered_count}")
        assert filtered_count >= 1, "Expected at least 1 row for classe_bilan_dpe"
        first_row_text = await page.locator("#table-sources-dict-body tr").first.inner_text()
        print(f"First row text: {first_row_text[:120]}...")
        assert "classe_bilan_dpe" in first_row_text

        # Test Clear search button
        print("Testing clear search button...")
        await page.click("#btn-sources-clear-search")
        await asyncio.sleep(0.3)
        restored_count = await page.locator("#table-sources-dict-body tr").count()
        print(f"Restored rows count after clear: {restored_count}")
        assert restored_count == rows_count

        # Test Category Filter Dropdown
        print("Testing category filter dropdown (winter)...")
        await page.select_option("#sources-filter-category", "winter")
        await asyncio.sleep(0.3)
        winter_count = await page.locator("#table-sources-dict-body tr").count()
        print(f"Winter rows count: {winter_count}")
        assert 10 <= winter_count <= 25, f"Unexpected winter count: {winter_count}"

        # Test Producer Filter Dropdown
        print("Testing producer filter dropdown (ADEME)...")
        # Find an option that has ADEME
        prod_options = await page.locator("#sources-filter-producer option").all_inner_texts()
        ademe_opt = next((opt for opt in prod_options if "ADEME" in opt), None)
        print(f"Available producer option: {ademe_opt}")
        if ademe_opt:
            await page.select_option("#sources-filter-producer", label=ademe_opt)
            await asyncio.sleep(0.3)
            prod_count = await page.locator("#table-sources-dict-body tr").count()
            print(f"Producer filter rows count: {prod_count}")

        # Test Reset Filters Button
        print("Testing reset filters button...")
        await page.click("#btn-sources-reset-filters")
        await asyncio.sleep(0.3)
        reset_count = await page.locator("#table-sources-dict-body tr").count()
        print(f"Rows count after reset: {reset_count}")
        assert reset_count == rows_count

        # Test Sorting by Raw Column
        print("Testing sorting by Raw Column...")
        raw_col_th = page.locator("#sources-dict-thead-tr th").nth(1)
        await raw_col_th.click()
        await asyncio.sleep(0.3)
        first_col_val = await page.locator("#table-sources-dict-body tr td code").first.inner_text()
        print(f"First raw col after sort asc: {first_col_val}")

        # Click again for descending sort
        await raw_col_th.click()
        await asyncio.sleep(0.3)
        first_col_val_desc = await page.locator("#table-sources-dict-body tr td code").first.inner_text()
        print(f"First raw col after sort desc: {first_col_val_desc}")
        assert first_col_val != first_col_val_desc, "Sort direction did not change first column value!"

        # Reset sort by clicking label
        await page.locator("#sources-dict-thead-tr th").nth(0).click()
        await asyncio.sleep(0.3)

        # Test hover on description cell
        print("Testing description hover popover...")
        first_desc_cell = page.locator(".sources-desc-cell").first
        await first_desc_cell.hover()
        await asyncio.sleep(0.3)
        popover_visible = await page.locator(".sources-desc-popover").first.is_visible()
        print(f"Description popover visible on hover: {popover_visible}")
        assert popover_visible, "Description popover was not visible on hover!"
        await page.screenshot(path="app/test_sources_hover_popover.png")

        # Test Subview Toggle (Switching to Dataset/Territory view)
        print("Testing subview switch to Dataset/Geo view...")
        await page.click("#btn-sources-subview-dataset")
        await asyncio.sleep(0.5)
        is_dataset_visible = await page.is_visible("#sources-subview-dataset")
        is_info_hidden = not await page.is_visible("#sources-subview-info")
        print(f"Dataset subview visible: {is_dataset_visible}, Info subview hidden: {is_info_hidden}")
        assert is_dataset_visible and is_info_hidden, "Failed to switch to dataset subview!"
        await page.screenshot(path="app/test_sources_dataset_view.png")

        # Switch back to Info view
        print("Switching back to Info subview...")
        await page.click("#btn-sources-subview-info")
        await asyncio.sleep(0.3)
        is_info_back = await page.is_visible("#sources-subview-info")
        assert is_info_back, "Failed to switch back to info subview!"

        # Test drawer link to sources
        print("Testing jump to sources from building drawer...")
        await page.click('button[data-tab="map"]')
        await asyncio.sleep(0.5)
        # Select first building from table to open drawer
        await page.click('button[data-tab="buildings"]')
        await asyncio.sleep(0.5)
        await page.locator("#table-buildings-body .btn-table-view").first.click()
        await asyncio.sleep(0.5)
        drawer_open = "open" in (await page.get_attribute("#building-drawer", "class") or "")
        print(f"Drawer opened: {drawer_open}")
        assert drawer_open, "Drawer did not open"

        # Click the goto sources button in drawer
        await page.click("#btn-drawer-goto-sources")
        await asyncio.sleep(0.5)
        active_tab = await page.evaluate("state.activeTab")
        print(f"Active tab after clicking drawer button: {active_tab}")
        assert active_tab == "sources", "Did not switch to sources tab from drawer!"

        print("ALL TESTS PASSED SUCCESSFULLY!")
        if console_errors:
            print("Console errors:")
            for err in console_errors:
                print("  ", err)

        await browser.close()

asyncio.run(run())
