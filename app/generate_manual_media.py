#!/usr/bin/env python3
"""
Reusable media generator for the TeZeLoMa User Manual.

Generates crisp PNG screenshots and animated GIF walkthroughs in
`app/static_app/manual/` by driving the live TeZeLoMa web app with Playwright
and assembling optimized GIFs with Pillow.

Usage:
    .venv/bin/python app/generate_manual_media.py
    .venv/bin/python app/generate_manual_media.py --out app/static_app/manual
"""

from __future__ import annotations

import argparse
import asyncio
import io
import subprocess
import sys
import time
import urllib.request
from pathlib import Path
from typing import Iterable

from PIL import Image
from playwright.async_api import Page, async_playwright

DEFAULT_URL = "http://localhost:8080/app/static_app/index.html"
DEFAULT_OUT = Path("app/static_app/manual")


def is_server_up(url: str) -> bool:
    """Return True if the local static server responds."""
    try:
        with urllib.request.urlopen(url, timeout=1.5) as resp:
            return resp.status == 200
    except Exception:
        return False


def start_local_server(repo_root: Path) -> subprocess.Popen:
    """Start `app/run_static.py` in the background and wait until ready."""
    proc = subprocess.Popen(
        [sys.executable, "app/run_static.py"],
        cwd=str(repo_root),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    for _ in range(30):
        if is_server_up(DEFAULT_URL):
            return proc
        time.sleep(0.25)
    proc.terminate()
    raise RuntimeError("Could not start local static server on port 8080.")


async def highlight_element(page: Page, selector: str, label: str = "") -> None:
    """Draw a temporary visual pulse ring around a target element for GIF clarity."""
    await page.evaluate(
        """([sel, txt]) => {
            const existing = document.getElementById('tz-manual-highlight');
            if (existing) existing.remove();
            const el = document.querySelector(sel);
            if (!el) return;
            const r = el.getBoundingClientRect();
            const ring = document.createElement('div');
            ring.id = 'tz-manual-highlight';
            Object.assign(ring.style, {
                position: 'fixed',
                left: (r.left - 4) + 'px',
                top: (r.top - 4) + 'px',
                width: (r.width + 8) + 'px',
                height: (r.height + 8) + 'px',
                border: '3px solid #f59e0b',
                borderRadius: '10px',
                boxShadow: '0 0 0 4px rgba(245, 158, 11, 0.28), 0 8px 20px rgba(0,0,0,0.35)',
                pointerEvents: 'none',
                zIndex: '999999',
                boxSizing: 'border-box',
            });
            if (txt) {
                const tag = document.createElement('div');
                tag.textContent = txt;
                Object.assign(tag.style, {
                    position: 'absolute',
                    top: '-28px',
                    left: '0',
                    background: '#f59e0b',
                    color: '#0f172a',
                    fontWeight: '700',
                    fontSize: '12px',
                    padding: '2px 8px',
                    borderRadius: '6px',
                    whiteSpace: 'nowrap',
                    fontFamily: 'system-ui, sans-serif',
                    boxShadow: '0 2px 6px rgba(0,0,0,0.25)',
                });
                ring.appendChild(tag);
            }
            document.body.appendChild(ring);
        }""",
        [selector, label],
    )


async def clear_highlight(page: Page) -> None:
    """Remove any temporary highlight ring."""
    await page.evaluate(
        "() => { const el = document.getElementById('tz-manual-highlight'); if (el) el.remove(); }"
    )


async def snap_frame(page: Page) -> Image.Image:
    """Capture a viewport screenshot into a PIL Image."""
    raw = await page.screenshot(type="png")
    return Image.open(io.BytesIO(raw)).convert("RGB")


def save_gif(
    frames: Iterable[tuple[Image.Image, int]],
    out_path: Path,
    max_width: int = 1080,
) -> None:
    """Resize frames, quantize cleanly, and save an optimized looping GIF."""
    frame_list = list(frames)
    if not frame_list:
        return

    images: list[Image.Image] = []
    durations: list[int] = []
    for img, dur in frame_list:
        if img.width > max_width:
            ratio = max_width / img.width
            img = img.resize((max_width, int(img.height * ratio)), Image.Resampling.LANCZOS)
        images.append(img.convert("P", palette=Image.Palette.ADAPTIVE, colors=256))
        durations.append(dur)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    images[0].save(
        out_path,
        save_all=True,
        append_images=images[1:],
        duration=durations,
        loop=0,
        optimize=True,
    )
    size_kb = out_path.stat().st_size / 1024
    print(f"  [GIF] {out_path} ({len(images)} frames, {size_kb:.0f} KB)")


def save_png(img: Image.Image, out_path: Path, max_width: int = 1280) -> None:
    """Save a crisp PNG screenshot."""
    if img.width > max_width:
        ratio = max_width / img.width
        img = img.resize((max_width, int(img.height * ratio)), Image.Resampling.LANCZOS)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    img.save(out_path, format="PNG", optimize=True)
    size_kb = out_path.stat().st_size / 1024
    print(f"  [PNG] {out_path} ({size_kb:.0f} KB)")


async def wait_for_buildings(page: Page) -> None:
    """Wait until KPI buildings count is populated."""
    await page.wait_for_selector("#kpi-buildings", timeout=25000)
    for _ in range(40):
        txt = await page.text_content("#kpi-buildings")
        if txt and txt.strip() not in ("—", "0", ""):
            return
        await asyncio.sleep(0.4)


async def generate_all(url: str, out_dir: Path) -> None:
    """Run all scripted scenarios and emit PNGs + GIFs."""
    out_dir.mkdir(parents=True, exist_ok=True)

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context(
            viewport={"width": 1440, "height": 900},
            device_scale_factor=1,
        )
        page = await context.new_page()

        print(f"Opening {url} ...")
        await page.goto(url, wait_until="networkidle")
        await page.wait_for_selector("#preset-lyon", timeout=15000)
        await asyncio.sleep(0.5)

        # ------------------------------------------------------------------
        # GIF 1: Welcome modal -> Territory selection -> Loaded map
        # ------------------------------------------------------------------
        print("Recording 01_accueil_territoire.gif ...")
        gif1: list[tuple[Image.Image, int]] = []
        gif1.append((await snap_frame(page), 1400))

        await highlight_element(page, "#preset-lyon", "1. Choisir un territoire")
        gif1.append((await snap_frame(page), 1000))
        await clear_highlight(page)

        await page.click("#preset-lyon")
        await asyncio.sleep(0.9)
        gif1.append((await snap_frame(page), 1200))

        await highlight_element(page, "#btn-sel-validate", "2. Valider et charger")
        gif1.append((await snap_frame(page), 1000))
        await clear_highlight(page)

        await page.locator("#btn-sel-validate").click(force=True)
        await wait_for_buildings(page)
        await asyncio.sleep(1.5)
        gif1.append((await snap_frame(page), 2200))
        save_gif(gif1, out_dir / "01_accueil_territoire.gif")

        # ------------------------------------------------------------------
        # GIF 2: Focus (Cadrer sur les résultats), Legend & Display overlay
        # ------------------------------------------------------------------
        print("Recording 02_carte_coloration_affichage.gif ...")
        gif2: list[tuple[Image.Image, int]] = []
        gif2.append((await snap_frame(page), 1000))

        # Show "Cadrer sur les résultats" (focus on selection)
        fit_btn = page.locator("#btn-fit-matches")
        if await fit_btn.is_enabled():
            await highlight_element(page, "#btn-fit-matches", "🎯 Cadrer sur les résultats")
            gif2.append((await snap_frame(page), 1000))
            await clear_highlight(page)
            await fit_btn.click()
            await asyncio.sleep(1.3)
            gif2.append((await snap_frame(page), 1300))

        # Static PNG: Main Map Tab (fitted to selection)
        save_png(await snap_frame(page), out_dir / "tab_carte.png")

        for mode, label in [
            ("overheating", "☀️ Surchauffe Estivale"),
            ("concentration", "🏢 Concentration Foncière"),
            ("dpe", "🎨 Diagnostic DPE"),
        ]:
            await page.select_option("#select-color-mode", mode)
            await asyncio.sleep(0.9)
            await highlight_element(page, "#map-legend", label)
            gif2.append((await snap_frame(page), 1400))
            await clear_highlight(page)

        # Open display settings overlay and adjust background whitening
        await page.click("#header-toggle-display-overlay")
        await asyncio.sleep(0.4)
        await highlight_element(page, "#map-display-overlay", "⚙️ Fond neutre & Limite bât.")
        gif2.append((await snap_frame(page), 1300))
        await clear_highlight(page)
        await page.click("#header-toggle-display-overlay")
        await asyncio.sleep(0.3)
        save_gif(gif2, out_dir / "02_carte_coloration_affichage.gif")

        # ------------------------------------------------------------------
        # GIF 3: Profiles & Sociological Filters
        # ------------------------------------------------------------------
        print("Recording 03_profils_et_filtres.gif ...")
        gif3: list[tuple[Image.Image, int]] = []
        await highlight_element(page, "#btn-open-filter-catalog", "🎭 Choisir un profil")
        gif3.append((await snap_frame(page), 1000))
        await clear_highlight(page)

        await page.click("#btn-open-filter-catalog")
        await asyncio.sleep(0.5)
        gif3.append((await snap_frame(page), 1300))

        # Select 'summer_heat' profile pill
        summer_pill = page.locator("#catalog-profile-buttons button", has_text="Canicule").first
        if await summer_pill.count() > 0:
            await summer_pill.click()
            await asyncio.sleep(0.5)
            gif3.append((await snap_frame(page), 1300))

        await highlight_element(page, "#btn-apply-filter-catalog", "✅ Appliquer le profil")
        gif3.append((await snap_frame(page), 1000))
        await clear_highlight(page)
        await page.click("#btn-apply-filter-catalog")
        await asyncio.sleep(0.7)
        gif3.append((await snap_frame(page), 1600))

        # Switch back to essential/default profile for subsequent captures
        await page.click("#btn-open-filter-catalog")
        await asyncio.sleep(0.3)
        default_pill = page.locator("#catalog-profile-buttons button", has_text="Cartographie").first
        if await default_pill.count() > 0:
            await default_pill.click()
            await asyncio.sleep(0.3)
        await page.click("#btn-apply-filter-catalog")
        await asyncio.sleep(0.5)
        save_gif(gif3, out_dir / "03_profils_et_filtres.gif")

        # ------------------------------------------------------------------
        # Static PNG: Buildings Tab + GIF 4: Building Drawer & SCI Lookup
        # ------------------------------------------------------------------
        print("Recording 04_fiche_batiment_et_sci.gif & tab PNGs ...")
        await page.click('button[data-tab="buildings"]')
        await asyncio.sleep(1.0)
        save_png(await snap_frame(page), out_dir / "tab_batiments.png")

        gif4: list[tuple[Image.Image, int]] = []
        gif4.append((await snap_frame(page), 1100))

        first_view = page.locator("#table-buildings-body .btn-table-view").first
        if await first_view.count() > 0:
            await first_view.click()
            await asyncio.sleep(0.9)
            gif4.append((await snap_frame(page), 1700))
            await page.click("#btn-close-drawer")
            await asyncio.sleep(0.3)

        # Landlords & SCI Tab
        await page.click('button[data-tab="landlords"]')
        await asyncio.sleep(1.0)
        gif4.append((await snap_frame(page), 1200))

        inspect_btn = page.locator("#table-landlords-body button").first
        if await inspect_btn.count() > 0:
            await inspect_btn.click()
            await asyncio.sleep(2.0)
            gif4.append((await snap_frame(page), 2000))

        save_png(await snap_frame(page), out_dir / "tab_bailleurs.png")
        save_gif(gif4, out_dir / "04_fiche_batiment_et_sci.gif")

        # ------------------------------------------------------------------
        # Static PNGs: Tools (Fieldwork, Export, Sources)
        # ------------------------------------------------------------------
        print("Capturing Tools PNGs ...")
        for tool_id, filename in [
            ("fieldwork", "tool_enquete_terrain.png"),
            ("export", "tool_exporter.png"),
            ("sources", "tool_sources.png"),
        ]:
            await page.click("#btn-tools-toggle")
            await asyncio.sleep(0.25)
            await page.click(f'[data-tool="{tool_id}"]')
            await asyncio.sleep(0.7)
            save_png(await snap_frame(page), out_dir / filename)
            await page.keyboard.press("Escape")
            await asyncio.sleep(0.3)

        await browser.close()
    print(f"Done! All manual media saved in {out_dir}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate TeZeLoMa manual screenshots & GIFs.")
    parser.add_argument("--url", default=DEFAULT_URL, help="App URL (default: localhost:8080)")
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT, help="Output directory")
    args = parser.parse_args()

    repo_root = Path(__file__).resolve().parent.parent
    server_proc = None
    if not is_server_up(args.url):
        print("Local server not detected on :8080, starting app/run_static.py ...")
        server_proc = start_local_server(repo_root)

    try:
        asyncio.run(generate_all(args.url, args.out))
    finally:
        if server_proc is not None:
            server_proc.terminate()
            server_proc.wait(timeout=5)


if __name__ == "__main__":
    main()
