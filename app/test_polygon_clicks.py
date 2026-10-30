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

        print("1. Opening app...")
        await page.goto("http://localhost:8080/app/static_app/index.html")
        await page.wait_for_selector("#modal-location-entry.open", timeout=8000)

        # 2. Click 'Explorer la carte interactivement'
        print("2. Entering Interactive Map Selection mode...")
        await page.click("#link-explore-freely")
        await asyncio.sleep(1.0)

        # 3. Verify postal zones are loaded in client state
        total_features = await page.evaluate("state.postalZonesGeoJson.features.length")
        print(f"Total postal zone features loaded: {total_features}")
        assert total_features > 500, f"Expected > 500 features, got {total_features}"

        # 4. Test clicking on a downloadable chunk via onPostalZoneClick / toggleChunkSelection
        print("4. Testing selection of chunk cp_69001 (Lyon 1er)...")
        res1 = await page.evaluate("""() => {
            const feat = state.postalZonesGeoJson.features.find(f => f.properties.chunk_id === 'cp_69001');
            onPostalZoneClick(feat);
            return {
                isSelected: state.pendingSelectedChunks.has('cp_69001'),
                barSummary: document.getElementById('sel-bar-summary-text').textContent,
                featSelected: feat.properties.selected,
                renderColor: feat.properties.render_color
            };
        }""")
        print(f"Selection result for cp_69001: {res1}")
        assert res1["isSelected"] == True, "cp_69001 was not added to pendingSelectedChunks!"
        assert res1["featSelected"] == True, "Feature properties.selected is not true!"
        assert res1["renderColor"] == "#8b5cf6", f"Expected electric purple (#8b5cf6), got {res1['renderColor']}"

        # 5. Test clicking on a multi-commune chunk: cp_38320 (Eybens, Bresson, Brié-et-Angonnes, etc.)
        print("5. Testing selection of multi-commune chunk cp_38320...")
        res2 = await page.evaluate("""() => {
            const feat = state.postalZonesGeoJson.features.find(f => f.properties.chunk_id === 'cp_38320');
            onPostalZoneClick(feat);
            // Check that all features sharing this chunk_id are now selected
            const allOfChunk = state.postalZonesGeoJson.features.filter(f => f.properties.chunk_id === 'cp_38320');
            return {
                totalInChunk: allOfChunk.length,
                allSelected: allOfChunk.every(f => f.properties.selected === true),
                chunkNames: allOfChunk.map(f => f.properties.nom),
                pendingCount: state.pendingSelectedChunks.size
            };
        }""")
        print(f"Multi-commune chunk result: {res2}")
        assert res2["totalInChunk"] >= 2, f"Expected multiple communes for 38320, got {res2['totalInChunk']}"
        assert res2["allSelected"] == True, "Not all communes of chunk cp_38320 were marked selected!"
        assert res2["pendingCount"] == 2, f"Expected 2 chunks selected, got {res2['pendingCount']}"

        # 6. Test removing by clicking again
        print("6. Testing deselection by clicking cp_69001 again...")
        res3 = await page.evaluate("""() => {
            const feat = state.postalZonesGeoJson.features.find(f => f.properties.chunk_id === 'cp_69001');
            onPostalZoneClick(feat);
            return {
                isSelected: state.pendingSelectedChunks.has('cp_69001'),
                featSelected: feat.properties.selected,
                pendingCount: state.pendingSelectedChunks.size
            };
        }""")
        print(f"Deselection result: {res3}")
        assert res3["isSelected"] == False, "cp_69001 should have been removed!"
        assert res3["featSelected"] == False, "Feature properties.selected should be false!"
        assert res3["pendingCount"] == 1, f"Expected 1 chunk remaining (cp_38320), got {res3['pendingCount']}"

        # 7. Test clicking a Requestable zone (e.g. Villefranche 69400 or a requestable feature)
        print("7. Testing clicking on a Requestable zone...")
        res4 = await page.evaluate("""() => {
            const reqFeat = state.postalZonesGeoJson.features.find(f => f.properties.status === 'requestable');
            onPostalZoneClick(reqFeat);
            const modal = document.getElementById('modal-request-data');
            const communeName = document.getElementById('req-modal-commune').textContent;
            return {
                modalOpen: modal.classList.contains('open'),
                communeName: communeName,
                isPendingSelected: state.pendingSelectedChunks.has(reqFeat.properties.chunk_id)
            };
        }""")
        print(f"Requestable modal test result: {res4}")
        assert res4["modalOpen"] == True, "Requestable modal did not open!"
        assert res4["isPendingSelected"] == False, "Requestable zone should not be in pendingSelectedChunks!"

        # Close requestable modal
        await page.click("#btn-close-request-modal")
        await asyncio.sleep(0.3)
        modal_open = await page.evaluate("document.getElementById('modal-request-data').classList.contains('open')")
        assert not modal_open, "Request modal should be closed!"

        # 8. Add Lyon 1er back and validate loading
        print("8. Re-adding Lyon 1er (cp_69001) and validating...")
        await page.evaluate("""() => {
            state.pendingSelectedChunks.clear();
            state.pendingSelectedChunks.add('cp_69001');
            refreshPostalZonesVisualState();
            updateTerritorySelectionBar();
        }""")

        await page.click("#btn-sel-validate")

        # Wait for data to load
        await page.wait_for_selector("#kpi-buildings", timeout=15000)
        for _ in range(30):
            txt = await page.text_content("#kpi-buildings")
            if txt and txt.strip() not in ["—", "0"]:
                print(f"Chunk cp_69001 loaded successfully! Total buildings: {txt}")
                break
            await asyncio.sleep(0.5)

        # Verify that only 69001 was loaded
        territory_text = await page.text_content("#territory-status-text")
        print(f"Loaded territory status: {territory_text}")
        assert "69001" in (territory_text or ""), "Expected 69001 in territory status!"

        # Check Cache API: cp_69001 should now be recorded in locallyCachedChunkIds
        is_cached = await page.evaluate("state.locallyCachedChunkIds.has('cp_69001')")
        print(f"cp_69001 is recorded in locallyCachedChunkIds: {is_cached}")
        assert is_cached, "cp_69001 should be marked as locally cached after download!"

        print("\nAll interactive polygon & multi-selection tests PASSED successfully!")
        await browser.close()

if __name__ == "__main__":
    asyncio.run(run())
