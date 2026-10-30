#!/usr/bin/env python3
"""
Generate Postal Code & Commune Zones GeoJSON for TeZeLoMa
==========================================================
Fetches geometries for:
- 9 Lyon Arrondissements (69001 - 69009)
- Villeurbanne (69100) and other Rhône communes
- Grenoble (38000 & 38100) and other Isère communes
Labels each zone with:
- status: "downloadable" (in manifest), "requestable" (BDNB raw data exists), or "unavailable"
- chunk metadata: buildings_count, size, etc.
"""

import json
import urllib.request
from pathlib import Path
from shapely.geometry import shape, mapping, box, Point
from shapely.ops import unary_union

ROOT_DIR = Path(__file__).resolve().parent.parent
CHUNKS_DIR = ROOT_DIR / "data" / "chunks"
MANIFEST_PATH = CHUNKS_DIR / "manifest.json"
OUT_PATH = CHUNKS_DIR / "postal_zones.geojson"
APP_STATIC_OUT = ROOT_DIR / "app" / "static_app" / "postal_zones.geojson"

def fetch_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": "TeZeLoMa-Builder/1.0"})
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read().decode("utf-8"))

def main():
    print("Loading manifest.json...")
    with open(MANIFEST_PATH, "r", encoding="utf-8") as f:
        manifest = json.load(f)

    chunks_by_cp = {c["cp"]: c for c in manifest["chunks"]}
    print(f"Loaded {len(chunks_by_cp)} downloadable chunks from manifest.")

    features = []

    # 1. Lyon Arrondissements (69001 - 69009)
    print("Fetching Lyon 9 arrondissements...")
    for code in range(69381, 69390):
        url = f"https://geo.api.gouv.fr/communes/{code}?fields=nom,code,codesPostaux,population&format=geojson&geometry=contour"
        feat = fetch_json(url)
        cp = int(feat["properties"]["codesPostaux"][0])
        chunk = chunks_by_cp.get(cp)

        geom = shape(feat["geometry"]).simplify(0.0003, preserve_topology=True)
        center = [round(geom.centroid.x, 6), round(geom.centroid.y, 6)]
        bbox = [round(b, 6) for b in geom.bounds]

        features.append({
            "type": "Feature",
            "properties": {
                "id": f"cp_{cp}",
                "cp": cp,
                "codesPostaux": [cp],
                "nom": feat["properties"]["nom"],
                "codeInsee": feat["properties"]["code"],
                "codeDepartement": "69",
                "departementLabel": "Rhône (69)",
                "status": "downloadable" if chunk else "requestable",
                "chunk_id": chunk["id"] if chunk else None,
                "buildings_count": chunk["buildings_count"] if chunk else None,
                "owners_count": chunk["owners_count"] if chunk else None,
                "total_size_bytes": chunk["total_size_bytes"] if chunk else None,
                "total_size_formatted": f"{chunk['total_size_bytes'] / 1048576:.1f} Mo" if chunk else None,
                "center": center,
                "bbox": bbox,
            },
            "geometry": mapping(geom)
        })

    # 2. Rhône Communes (dep 69)
    print("Fetching Rhône communes...")
    url_69 = "https://geo.api.gouv.fr/communes?codeDepartement=69&fields=nom,code,codesPostaux,population&format=geojson&geometry=contour"
    communes_69 = fetch_json(url_69)
    for feat in communes_69["features"]:
        code_insee = feat["properties"]["code"]
        # Skip Lyon entire city (code 69123) because we already added 9 individual arrondissements
        if code_insee == "69123":
            continue

        codes_postaux = feat["properties"].get("codesPostaux", [])
        primary_cp = int(codes_postaux[0]) if codes_postaux else None
        chunk = chunks_by_cp.get(primary_cp)

        geom = shape(feat["geometry"]).simplify(0.0005, preserve_topology=True)
        center = [round(geom.centroid.x, 6), round(geom.centroid.y, 6)]
        bbox = [round(b, 6) for b in geom.bounds]

        features.append({
            "type": "Feature",
            "properties": {
                "id": f"cp_{primary_cp}" if primary_cp else f"insee_{code_insee}",
                "cp": primary_cp,
                "codesPostaux": [int(p) for p in codes_postaux if p.isdigit()],
                "nom": feat["properties"]["nom"],
                "codeInsee": code_insee,
                "codeDepartement": "69",
                "departementLabel": "Rhône (69)",
                "status": "downloadable" if chunk else "requestable",
                "chunk_id": chunk["id"] if chunk else None,
                "buildings_count": chunk["buildings_count"] if chunk else None,
                "owners_count": chunk["owners_count"] if chunk else None,
                "total_size_bytes": chunk["total_size_bytes"] if chunk else None,
                "total_size_formatted": f"{chunk['total_size_bytes'] / 1048576:.1f} Mo" if chunk else None,
                "center": center,
                "bbox": bbox,
            },
            "geometry": mapping(geom)
        })

    # 3. Isère Communes (dep 38)
    print("Fetching Isère communes...")
    url_38 = "https://geo.api.gouv.fr/communes?codeDepartement=38&fields=nom,code,codesPostaux,population&format=geojson&geometry=contour"
    communes_38 = fetch_json(url_38)

    for feat in communes_38["features"]:
        code_insee = feat["properties"]["code"]
        codes_postaux = feat["properties"].get("codesPostaux", [])
        geom = shape(feat["geometry"]).simplify(0.0005, preserve_topology=True)

        if code_insee == "38185":
            # Grenoble has 38000 (North) and 38100 (South)
            # Split roughly at lat 45.183
            c_38000 = chunks_by_cp.get(38000)
            c_38100 = chunks_by_cp.get(38100)

            # Split geometry into North and South
            b_bounds = geom.bounds # minx, miny, maxx, maxy
            cut_lat = 45.183
            box_north = box(b_bounds[0] - 0.01, cut_lat, b_bounds[2] + 0.01, b_bounds[3] + 0.01)
            box_south = box(b_bounds[0] - 0.01, b_bounds[1] - 0.01, b_bounds[2] + 0.01, cut_lat)

            geom_north = geom.intersection(box_north)
            geom_south = geom.intersection(box_south)

            # North feature: 38000
            features.append({
                "type": "Feature",
                "properties": {
                    "id": "cp_38000",
                    "cp": 38000,
                    "codesPostaux": [38000],
                    "nom": "Grenoble Centre & Nord (38000)",
                    "codeInsee": "38185",
                    "codeDepartement": "38",
                    "departementLabel": "Isère (38)",
                    "status": "downloadable" if c_38000 else "requestable",
                    "chunk_id": c_38000["id"] if c_38000 else None,
                    "buildings_count": c_38000["buildings_count"] if c_38000 else None,
                    "owners_count": c_38000["owners_count"] if c_38000 else None,
                    "total_size_bytes": c_38000["total_size_bytes"] if c_38000 else None,
                    "total_size_formatted": f"{c_38000['total_size_bytes'] / 1048576:.1f} Mo" if c_38000 else None,
                    "center": [round(geom_north.centroid.x, 6), round(geom_north.centroid.y, 6)],
                    "bbox": [round(b, 6) for b in geom_north.bounds],
                },
                "geometry": mapping(geom_north)
            })

            # South feature: 38100
            features.append({
                "type": "Feature",
                "properties": {
                    "id": "cp_38100",
                    "cp": 38100,
                    "codesPostaux": [38100],
                    "nom": "Grenoble Sud (38100)",
                    "codeInsee": "38185",
                    "codeDepartement": "38",
                    "departementLabel": "Isère (38)",
                    "status": "downloadable" if c_38100 else "requestable",
                    "chunk_id": c_38100["id"] if c_38100 else None,
                    "buildings_count": c_38100["buildings_count"] if c_38100 else None,
                    "owners_count": c_38100["owners_count"] if c_38100 else None,
                    "total_size_bytes": c_38100["total_size_bytes"] if c_38100 else None,
                    "total_size_formatted": f"{c_38100['total_size_bytes'] / 1048576:.1f} Mo" if c_38100 else None,
                    "center": [round(geom_south.centroid.x, 6), round(geom_south.centroid.y, 6)],
                    "bbox": [round(b, 6) for b in geom_south.bounds],
                },
                "geometry": mapping(geom_south)
            })
            continue

        primary_cp = int(codes_postaux[0]) if codes_postaux else None
        chunk = chunks_by_cp.get(primary_cp)
        center = [round(geom.centroid.x, 6), round(geom.centroid.y, 6)]
        bbox = [round(b, 6) for b in geom.bounds]

        features.append({
            "type": "Feature",
            "properties": {
                "id": f"cp_{primary_cp}" if primary_cp else f"insee_{code_insee}",
                "cp": primary_cp,
                "codesPostaux": [int(p) for p in codes_postaux if p.isdigit()],
                "nom": feat["properties"]["nom"],
                "codeInsee": code_insee,
                "codeDepartement": "38",
                "departementLabel": "Isère (38)",
                "status": "downloadable" if chunk else "requestable",
                "chunk_id": chunk["id"] if chunk else None,
                "buildings_count": chunk["buildings_count"] if chunk else None,
                "owners_count": chunk["owners_count"] if chunk else None,
                "total_size_bytes": chunk["total_size_bytes"] if chunk else None,
                "total_size_formatted": f"{chunk['total_size_bytes'] / 1048576:.1f} Mo" if chunk else None,
                "center": center,
                "bbox": bbox,
            },
            "geometry": mapping(geom)
        })

    geojson = {
        "type": "FeatureCollection",
        "features": features
    }

    print(f"Total features created: {len(features)}")
    downloadable_count = sum(1 for f in features if f["properties"]["status"] == "downloadable")
    requestable_count = sum(1 for f in features if f["properties"]["status"] == "requestable")
    print(f"  - Downloadable chunks: {downloadable_count}")
    print(f"  - Requestable communes/zones: {requestable_count}")

    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(geojson, f, ensure_ascii=False)
    print(f"Saved {OUT_PATH} ({OUT_PATH.stat().st_size / 1024:.1f} KB)")

    with open(APP_STATIC_OUT, "w", encoding="utf-8") as f:
        json.dump(geojson, f, ensure_ascii=False)
    print(f"Saved {APP_STATIC_OUT} ({APP_STATIC_OUT.stat().st_size / 1024:.1f} KB)")

if __name__ == "__main__":
    main()
