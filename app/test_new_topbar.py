import time
from playwright.sync_api import sync_playwright

def test_topbar():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1440, "height": 900})
        page = context.new_page()

        print("1. Navigating to static app...")
        page.goto("http://localhost:8080/app/static_app/index.html")

        # Select Lyon preset to load data
        page.wait_for_selector("#preset-lyon", timeout=10000)
        page.click("#preset-lyon")
        time.sleep(0.5)

        page.wait_for_selector("#btn-sel-validate", timeout=5000)
        page.locator("#btn-sel-validate").click(force=True)

        # Wait for data to load in KPI
        print("2. Waiting for data load in KPIs...")
        page.wait_for_selector("#kpi-buildings", timeout=20000)
        for _ in range(30):
            txt = page.text_content("#kpi-buildings")
            if txt and txt.strip() not in ["—", "0"]:
                print(f"Data loaded: {txt} buildings!")
                break
            time.sleep(0.5)

        # Check that old app-header is gone
        assert page.locator("header.app-header").count() == 0, "Old app-header should be gone!"
        assert page.locator("#btn-open-territory-manager").count() == 0, "Redundant data & chunk button in header should be gone!"
        assert page.locator("#btn-header-export").count() == 0, "Redundant export button in header should be gone!"
        print("Confirmed: Old top bar and redundant buttons are removed.")

        # Check single unified bar exists
        top_nav = page.locator("nav.app-tabs-nav")
        assert top_nav.is_visible(), "Unified top nav should be visible!"
        nav_box = top_nav.bounding_box()
        print(f"Top nav height: {nav_box['height']}px (expected ~52px)")
        assert 45 <= nav_box['height'] <= 60, f"Unexpected top nav height: {nav_box['height']}"

        # Check logo image
        logo_img = page.locator(".brand-logo-img")
        assert logo_img.is_visible(), "Logo image should be visible!"
        src = logo_img.get_attribute("src")
        print(f"Logo image src: {src}")
        assert "logo.png" in src, "Logo image should be logo.png"

        # Check hover widget is hidden by default
        hover_widget = page.locator("#brand-hover-widget")
        assert not hover_widget.is_visible(), "Brand hover widget should be hidden by default!"
        print("Confirmed: Hover widget hidden before hover.")

        # Take screenshot of default state
        page.screenshot(path="screenshot_new_topbar_default.png")
        print("Saved screenshot_new_topbar_default.png")

        # Hover over logo container
        print("Hovering over logo container...")
        page.hover("#brand-logo-container")
        time.sleep(0.5)

        # Now hover widget should be visible
        assert hover_widget.is_visible(), "Brand hover widget should be visible on hover!"
        widget_title = page.locator(".brand-hover-title").inner_text()
        widget_sub = page.locator(".brand-hover-subtitle").inner_text()
        widget_link = page.locator(".brand-external-link").get_attribute("href")
        print(f"Widget title: {widget_title}")
        print(f"Widget subtitle: {widget_sub}")
        print(f"Widget link href: {widget_link}")

        assert "TeZeLoMa" in widget_title, f"Expected TeZeLoMa in title, got: {widget_title}"
        assert "cartographie" in widget_sub.lower(), f"Expected Cartographie in subtitle, got: {widget_sub}"
        assert "zerologementmalade.org" in widget_link, f"Expected link to zerologementmalade.org, got: {widget_link}"

        # Take screenshot with hover widget open
        page.screenshot(path="screenshot_new_topbar_hover.png")
        print("Saved screenshot_new_topbar_hover.png")

        # Test tabs still work
        print("Testing tab navigation...")
        page.click('button[data-tab="buildings"]')
        time.sleep(0.5)
        assert page.locator("#pane-buildings").is_visible(), "Buildings tab pane should be visible!"
        page.screenshot(path="screenshot_new_topbar_buildings_tab.png")
        print("Saved screenshot_new_topbar_buildings_tab.png")

        # Test export tab still works
        page.click('button[data-tab="export"]')
        time.sleep(0.5)
        assert page.locator("#pane-export").is_visible(), "Export tab pane should be visible!"

        # Return to map tab
        page.click('button[data-tab="map"]')
        time.sleep(0.5)
        assert page.locator("#pane-map").is_visible(), "Map tab pane should be visible!"

        print("ALL NEW TOP BAR TESTS PASSED SUCCESSFULLY!")

if __name__ == "__main__":
    test_topbar()
