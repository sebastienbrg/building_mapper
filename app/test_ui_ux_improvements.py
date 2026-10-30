import sys
import time
from playwright.sync_api import sync_playwright

def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1440, "height": 900})
        page = context.new_page()
        
        print("Navigating to http://localhost:8080/app/static_app/index.html ...")
        page.goto("http://localhost:8080/app/static_app/index.html")
        
        # Wait for manifest to load
        print("Waiting for manifest catalogue to load...")
        page.wait_for_function("() => window.appState && window.appState.manifest && window.appState.manifest.chunks && window.appState.manifest.chunks.length > 0", timeout=15000)

        # Select Lyon Preset
        print("Selecting Lyon preset...")
        page.wait_for_selector("#preset-lyon", timeout=10000)
        page.click("#preset-lyon")
        time.sleep(1.0)
        
        # Validate selection
        page.wait_for_selector("#btn-sel-validate", timeout=5000)
        page.locator("#btn-sel-validate").click(force=True)
        
        # Wait for data to load
        page.wait_for_selector("#kpi-buildings", timeout=20000)
        for _ in range(30):
            txt = page.text_content("#kpi-buildings")
            if txt and txt.strip() not in ["—", "0"]:
                print(f"Data loaded: {txt} buildings!")
                break
            time.sleep(0.5)
        
        # 1. Check sidebar width and removed "Affichage & Carte"
        sidebar_box = page.locator(".app-sidebar").bounding_box()
        print(f"Sidebar width: {sidebar_box['width']}px (target ~430px)")
        assert sidebar_box['width'] >= 400, f"Sidebar width too small: {sidebar_box['width']}"
        assert page.locator("#acc-display").count() == 0, "'Affichage & Carte' accordion should be dropped completely"
        print("Confirmed: 'Affichage & Carte' accordion is completely removed from sidebar.")
        
        # 2. Check first big button: 'Données chargées'
        btn_data = page.locator("#btn-sidebar-donnees-chargees")
        assert btn_data.is_visible(), "Big button 'Données chargées' not visible"
        data_title = page.locator("#btn-sidebar-donnees-chargees .sidebar-big-btn-title").inner_text()
        print(f"First big button title: '{data_title}'")
        assert "Données chargées" in data_title, f"Expected 'Données chargées', got: {data_title}"
        
        territory_text = page.locator("#sidebar-territory-name").inner_text()
        count_text = page.locator("#sidebar-data-count").inner_text()
        print(f"Sidebar territory: {territory_text}, count: {count_text}")
        assert "2" in count_text, f"Expected counts in big button, got {count_text}"
        
        # 3. Check profiles removed from sidebar
        assert page.locator("#sidebar-profiles-bar").count() == 0, "Old sidebar profiles bar should not exist"
        
        # 4. Check second big button: 'Choisir les filtres'
        btn_filter = page.locator("#btn-open-filter-catalog")
        assert btn_filter.is_visible(), "'Choisir les filtres' button not visible"
        filter_sub = page.locator("#sidebar-active-profile-name").inner_text()
        print(f"Sidebar active profile subtext: '{filter_sub}'")
        assert "no profiles" in filter_sub or len(filter_sub) > 0, "Expected profile name or 'no profiles'"
        
        # 5. Check overlayed display control above legend
        overlay = page.locator("#map-display-overlay")
        assert overlay.is_visible(), "Map display overlay not visible"
        assert page.locator("#slider-bg-dim").is_visible(), "Background whitening slider not visible in overlay"
        assert page.locator("#select-max-polygons").is_visible(), "Max polygons select not visible in overlay"
        
        # Check map navigation control removed (no collision with .map-floating-panel)
        assert page.locator(".maplibregl-ctrl-top-left .maplibregl-ctrl-zoom-in").count() == 0, "Zoom controls at top-left should be removed"
        print("Confirmed: Map zoom/compass navigation controls removed (no collision with style buttons).")
        
        # Check legend initial title (building coloring mode: DPE)
        legend_title = page.locator("#legend-title").inner_text()
        print(f"Normal map legend title: '{legend_title}'")
        assert "DPE" in legend_title or "Diagnostic" in legend_title, f"Expected DPE legend, got {legend_title}"
        
        # 6. Test 'Données chargées' opens Territory Mode and replaces legend
        print("Clicking 'Données chargées' button to enter territory mode...")
        btn_data.click()
        page.wait_for_timeout(500)
        assert page.locator("#territory-selection-bar").is_visible(), "Territory selection bar should appear"
        
        # Check legend replaced with Chunk Status Legend!
        legend_title_in_selection = page.locator("#legend-title").inner_text()
        print(f"Map legend title in territory selection mode: '{legend_title_in_selection}'")
        assert "Chunk" in legend_title_in_selection or "Secteur" in legend_title_in_selection or "Territoire" in legend_title_in_selection, "Legend should show Chunk/Territory status"
        
        # Check 'cocher tout' dropped from selection bar
        assert page.locator("#btn-sel-all").count() == 0, "#btn-sel-all ('Tout cocher') should be dropped"
        print("Confirmed: 'Tout cocher' button dropped from territory selection bar.")
        
        # 7. Check reworked layout of selected postal codes / chunks
        chips = page.locator("#sel-bar-chips .sel-chunk-pill")
        chips_count = chips.count()
        print(f"Selected chunks chips count: {chips_count}")
        assert chips_count == 10, f"Expected 10 chunk pills for Lyon preset, found {chips_count}"
        
        # Test individual remove on a chunk pill
        first_chip = chips.first
        first_cp = first_chip.locator(".chunk-cp-label").inner_text()
        print(f"Removing first chip ({first_cp})...")
        first_chip.locator(".btn-remove-chunk").click()
        page.wait_for_timeout(300)
        chips_count_after = page.locator("#sel-bar-chips .sel-chunk-pill").count()
        print(f"Chips count after removal: {chips_count_after}")
        assert chips_count_after == 9, "Expected 9 chips after removing one"
        
        # Screenshot territory selection mode with reworked layout & chunk status legend
        page.screenshot(path="screenshot_territory_mode_reworked.png")
        print("Captured screenshot_territory_mode_reworked.png")
        
        # Close territory selection mode via Cancel button
        page.locator("#btn-sel-cancel").click()
        page.wait_for_timeout(300)
        assert not page.locator("#territory-selection-bar").is_visible(), "Territory selection bar should be closed"
        
        # Check legend reverts to building coloring mode
        reverted_legend_title = page.locator("#legend-title").inner_text()
        print(f"Reverted map legend title: '{reverted_legend_title}'")
        assert "DPE" in reverted_legend_title or "Diagnostic" in reverted_legend_title, "Legend should revert after exiting territory mode"
        
        # 8. Open filter catalog modal
        print("Clicking 'Choisir les filtres'...")
        btn_filter.click()
        page.wait_for_selector("#modal-filter-catalog", state="visible")
        page.wait_for_timeout(500)
        
        # Check 'cocher tout' dropped from filter catalog
        assert page.locator("#btn-catalog-select-all").count() == 0, "#btn-catalog-select-all should be dropped"
        assert page.locator(".btn-toggle-cat").count() == 0, ".btn-toggle-cat ('Tout cocher') should be dropped from category headers"
        print("Confirmed: All 'Tout cocher' buttons dropped from filter catalog.")
        
        # Check profiles shortcuts & save button at top of catalog
        assert page.locator("#catalog-profile-buttons").is_visible(), "Profile pills row not visible in catalog"
        assert page.locator("#btn-catalog-save-profile").is_visible(), "Save profile button not visible at top of catalog"
        
        # Check foldable categories
        categories = page.locator(".catalog-category-block")
        cat_count = categories.count()
        print(f"Category blocks count: {cat_count}")
        assert cat_count >= 5, f"Expected at least 5 categories, found {cat_count}"
        
        # Test collapse all / expand all
        page.locator("#btn-catalog-collapse-all").click()
        page.wait_for_timeout(300)
        open_count = page.evaluate("() => document.querySelectorAll('.catalog-category-block[open]').length")
        assert open_count == 0, f"Expected 0 open categories after collapse all, got {open_count}"
        
        page.locator("#btn-catalog-expand-all").click()
        page.wait_for_timeout(300)
        open_count_after_expand = page.evaluate("() => document.querySelectorAll('.catalog-category-block[open]').length")
        assert open_count_after_expand == cat_count, "Expected all categories open after expand all"
        
        # Test selecting a profile pill in dialog and verifying sidebar updates
        canicule_pill = page.locator("#catalog-profile-buttons .profile-pill-btn:has-text('Canicule')")
        assert canicule_pill.count() > 0, "Canicule profile pill should exist"
        print("Selecting 'Canicule & Bouilloires Été' profile...")
        canicule_pill.click()
        page.wait_for_timeout(500)
        
        # Close catalog modal
        page.locator("#btn-close-filter-catalog").click()
        page.wait_for_selector("#modal-filter-catalog", state="hidden")
        page.wait_for_timeout(300)
        
        # Check updated active profile name in sidebar
        updated_profile_name = page.locator("#sidebar-active-profile-name").inner_text()
        print(f"Updated profile in sidebar: '{updated_profile_name}'")
        assert "Canicule" in updated_profile_name, f"Expected 'Canicule' in sidebar, got '{updated_profile_name}'"
        
        # Final main view screenshot with overlay above legend
        page.screenshot(path="screenshot_main_overlay_above_legend.png")
        print("Captured screenshot_main_overlay_above_legend.png")
        
        print("\nALL VERIFICATIONS PASSED SUCCESSFULLY!")
        browser.close()

if __name__ == "__main__":
    main()
