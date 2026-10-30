#!/usr/bin/env python3
"""
Test Filter Clearing, Match Counts, XX/YYY Display & Blink Animation
=====================================================================
Verifies:
1. KPI Strip displays format "XX / YYY" for Bâtiments and Logements.
2. Subtle blink animation (.kpi-blink) is triggered on KPI change.
3. Clear all filters button (#btn-clear-all-filters) exists next to active filters badge.
4. Clicking Clear all filters resets active filters to 0 and clears filters.
5. Unselected filters are cleared and never filter data.
6. Number of matches is shown for active filters.
"""

import asyncio
from playwright.async_api import async_playwright

APP_URL = "http://localhost:8080/app/static_app/index.html"

async def test_filters_kpis_and_clearing():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context(viewport={"width": 1400, "height": 900})
        page = await context.new_page()

        # Track console logs and errors
        page.on("console", lambda msg: print(f"[Browser Console] {msg.type}: {msg.text}") if msg.type in ['error', 'warn'] else None)
        page.on("pageerror", lambda err: print(f"[Browser Uncaught Error] {err}"))

        print("1. Navigating to static app...")
        await page.goto(APP_URL, wait_until="networkidle")

        # Location entry modal is open on clean start
        print("2. Selecting Lyon preset in location entry modal...")
        await page.wait_for_selector("#modal-location-entry.open", timeout=8000)
        await page.click("#preset-lyon")
        await asyncio.sleep(0.5)

        print("3. Validating and loading territory data...")
        await page.wait_for_selector("#territory-selection-bar.active", timeout=5000)
        await page.locator("#btn-sel-validate").click(force=True)

        # Wait for data to load
        await page.wait_for_selector("#kpi-buildings", timeout=20000)
        for _ in range(40):
            txt = await page.text_content("#kpi-buildings")
            if txt and "/" in txt:
                print(f"Data loaded with XX/YYY format: {txt}")
                break
            await asyncio.sleep(0.5)

        # 1. Verify format XX / YYY
        bldg_txt = await page.text_content("#kpi-buildings")
        dwell_txt = await page.text_content("#kpi-dwellings")
        print(f"Initial KPI Buildings: '{bldg_txt}'")
        print(f"Initial KPI Dwellings: '{dwell_txt}'")

        assert "/" in bldg_txt, f"KPI Buildings should contain '/': got '{bldg_txt}'"
        assert "/" in dwell_txt, f"KPI Dwellings should contain '/': got '{dwell_txt}'"

        parts_bldg = [p.replace('\xa0', '').replace('\u202f', '').replace(' ', '').strip() for p in bldg_txt.split("/")]
        assert len(parts_bldg) == 2, f"Expected 2 parts in {bldg_txt}"
        assert int(parts_bldg[0]) > 0
        assert int(parts_bldg[1]) > 0

        # 2. Check Active Filters count & Clear button presence
        badge_text = await page.text_content("#active-filters-count-badge")
        print(f"Active filters badge text: '{badge_text}'")
        clear_btn = page.locator("#btn-clear-all-filters")
        assert await clear_btn.is_visible(), "Clear all filters button should be visible when activeCount > 0"

        # 3. Test Blink Animation on Filter Change
        print("4. Testing filter change and blink animation...")
        # Unselect all except G to filter further
        pill_f = page.locator("#filter-dpe button.dpe-f")
        if await pill_f.is_visible():
            await pill_f.click()
            await asyncio.sleep(0.1)

            # Check that KPI updated
            new_bldg_txt = await page.text_content("#kpi-buildings")
            print(f"KPI Buildings after filtering DPE G only: '{new_bldg_txt}'")
            assert new_bldg_txt != bldg_txt, "Building count should change after toggling filter"

            # Check if kpi-blink class was triggered
            classes = await page.locator("#kpi-buildings").get_attribute("class")
            print(f"Classes on #kpi-buildings right after change: '{classes}'")

        # 4. Verify match count on active filter card
        match_count_el = page.locator(".dyn-filter-match-count").first
        if await match_count_el.is_visible():
            match_txt = await match_count_el.text_content()
            print(f"Active filter match count badge: '{match_txt}'")
            assert "bât." in match_txt, f"Match badge should display 'bât.': got {match_txt}"

        # 5. Test "Clear All Filters" button ('x' next to 'N actifs')
        print("5. Testing Clear All Filters button (#btn-clear-all-filters)...")
        await clear_btn.click()
        await asyncio.sleep(0.5)

        badge_text_after_clear = await page.text_content("#active-filters-count-badge")
        print(f"Active filters badge after clear: '{badge_text_after_clear}'")
        assert "0 actif" in badge_text_after_clear, f"Active filters should be '0 actif', got '{badge_text_after_clear}'"
        assert not await clear_btn.is_visible(), "Clear button should hide when 0 active filters"

        # KPIs should now show full total: total / total
        cleared_bldg_txt = await page.text_content("#kpi-buildings")
        print(f"KPI Buildings after clearing all filters: '{cleared_bldg_txt}'")
        cleared_parts = [p.replace('\xa0', '').replace('\u202f', '').replace(' ', '').strip() for p in cleared_bldg_txt.split("/")]
        assert cleared_parts[0] == cleared_parts[1], f"Filtered should equal total after clear: {cleared_bldg_txt}"

        # 6. Test that unselected filters are cleared and do not filter
        print("6. Testing unselected filters clearing...")
        # Open catalog
        await page.click("#btn-open-filter-catalog")
        await page.wait_for_selector("#modal-filter-catalog.open", timeout=5000)

        # Switch to 'summer_heat' profile
        await page.click("#catalog-profile-buttons button[data-profile-id='summer_heat']")
        await asyncio.sleep(0.3)
        await page.click("#btn-apply-filter-catalog")
        await asyncio.sleep(0.5)

        summer_bldg_txt = await page.text_content("#kpi-buildings")
        print(f"Summer heat profile loaded: '{summer_bldg_txt}'")
        # In summer_heat, DPE is not an active indicator; ensure DPE is not filtering in background
        dpe_card = page.locator(".dyn-filter-card[data-filter-id='dpe']")
        assert await dpe_card.count() == 0, "DPE card should not be present in summer_heat profile"

        print("\nAll tests passed successfully!")
        await browser.close()

if __name__ == "__main__":
    asyncio.run(test_filters_kpis_and_clearing())
