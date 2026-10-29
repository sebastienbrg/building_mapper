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

        print("Navigating to http://localhost:8080/proto/static_app/index.html ...")
        await page.goto("http://localhost:8080/proto/static_app/index.html")

        # Wait for data to load
        await page.wait_for_selector("#kpi-buildings", timeout=15000)
        # Wait until buildings count is loaded
        for _ in range(30):
            txt = await page.text_content("#kpi-buildings")
            if txt and txt.strip() not in ["—", "0"]:
                print(f"Data loaded: {txt} buildings!")
                break
            await asyncio.sleep(0.5)

        # Tab 1: Map
        print("Testing Tab 1: Map...")
        await page.screenshot(path="proto/test_tab_1_map.png")

        # Tab 2: Buildings Table
        print("Testing Tab 2: Bâtiments...")
        await page.click('button[data-tab="buildings"]')
        await asyncio.sleep(1)
        row_count = await page.locator("#table-buildings-body tr").count()
        print(f"Bâtiments rows rendered: {row_count}")
        assert row_count > 0, "No building rows rendered!"
        await page.screenshot(path="proto/test_tab_2_buildings.png")

        # Test search query in Buildings Table
        print("Testing Search Query in Bâtiments...")
        await page.fill("#table-search-query", "Rue")
        await asyncio.sleep(0.8)
        search_note = await page.text_content("#table-filter-note")
        print(f"Search note: {search_note}")

        # Test clicking 'Voir' on first building
        print("Testing 'Voir' on a building from table...")
        first_btn = page.locator("#table-buildings-body .btn-table-view").first
        await first_btn.click()
        await asyncio.sleep(0.5)
        # Verify drawer is open and map tab is active
        drawer_class = await page.get_attribute("#building-drawer", "class")
        print(f"Drawer class: {drawer_class}")
        assert "open" in (drawer_class or ""), "Drawer did not open when clicking Voir!"

        # Close drawer
        await page.click("#btn-close-drawer")
        await asyncio.sleep(0.3)

        # Tab 3: Bailleurs & SCI
        print("Testing Tab 3: Bailleurs & SCI...")
        await page.click('button[data-tab="landlords"]')
        await asyncio.sleep(1)
        landlord_rows = await page.locator("#table-landlords-body tr").count()
        print(f"Landlord rows rendered: {landlord_rows}")
        assert landlord_rows > 0, "No landlord rows rendered!"
        await page.screenshot(path="proto/test_tab_3_landlords.png")

        # Test clicking inspect on first landlord
        print("Testing landlord inspection...")
        inspect_btn = page.locator("#table-landlords-body .btn-inspect-row").first
        if await inspect_btn.count() > 0:
            await inspect_btn.click()
            await asyncio.sleep(2)
            results_display = await page.evaluate("document.getElementById('landlord-api-results').style.display")
            print(f"Landlord API results display: {results_display}")
            assert results_display != "none", "Landlord results card not shown!"
            await page.screenshot(path="proto/test_tab_3_inspected.png")

        # Tab 4: Export ZIP
        print("Testing Tab 4: Export ZIP...")
        await page.click('button[data-tab="export"]')
        await asyncio.sleep(0.5)
        export_count = await page.text_content("#export-tab-count")
        print(f"Export tab count: {export_count}")
        await page.screenshot(path="proto/test_tab_4_export.png")

        # Tab 5: Sources de données
        print("Testing Tab 5: Sources de données...")
        await page.click('button[data-tab="sources"]')
        await asyncio.sleep(0.5)
        await page.screenshot(path="proto/test_tab_5_sources.png")

        # Tab 6: Pistes de données
        print("Testing Tab 6: Pistes de données...")
        await page.click('button[data-tab="potential"]')
        await asyncio.sleep(0.5)
        await page.screenshot(path="proto/test_tab_6_potential.png")

        print("Finished all tab tests successfully!")
        if console_errors:
            print("Console messages:")
            for err in console_errors:
                print("  ", err)

        await browser.close()

asyncio.run(run())
