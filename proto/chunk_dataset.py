#!/usr/bin/env python3
"""
TeZeLoMa Dataset Chunker
========================
Partitions the processed buildings and building_owners Parquet files into
per-postal-code (and department-level) chunks for lightweight static hosting
and on-demand client loading.

Outputs:
  - data/chunks/buildings_{cp}.parquet
  - data/chunks/owners_{cp}.parquet
  - data/chunks/buildings_dep_{dep}.parquet
  - data/chunks/owners_dep_{dep}.parquet
  - data/chunks/manifest.json

Usage:
  .venv/bin/python proto/chunk_dataset.py
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import sys
import time

import geopandas as gpd
import numpy as np
import pandas as pd
import pyarrow.parquet as pq

ROOT_DIR = Path(__file__).resolve().parent.parent
DEFAULT_BUILDINGS = ROOT_DIR / "data" / "processed" / "buildings.parquet"
DEFAULT_OWNERS = ROOT_DIR / "data" / "processed" / "building_owners.parquet"
DEFAULT_OUT_DIR = ROOT_DIR / "data" / "chunks"

DEP_LABELS = {
    "69": "69 — Rhône (Lyon & Villeurbanne)",
    "38": "38 — Isère (Grenoble & Métropole)",
}


def build_chunks(
    buildings_path: Path,
    owners_path: Path,
    out_dir: Path,
    compression: str = "zstd",
) -> None:
    t0 = time.time()
    out_dir.mkdir(parents=True, exist_ok=True)

    print(f"Loading {buildings_path}...")
    gdf_buildings = gpd.read_parquet(buildings_path)
    print(f"  Loaded {len(gdf_buildings):,} buildings.")

    print(f"Loading {owners_path}...")
    df_owners = pd.read_parquet(owners_path)
    print(f"  Loaded {len(df_owners):,} corporate owner records.")

    # Map building postal code onto owners via batiment_groupe_id
    print("Mapping postal codes to corporate owners...")
    bg_to_cp = gdf_buildings.set_index("batiment_groupe_id")["cp"].to_dict()
    df_owners["cp"] = df_owners["batiment_groupe_id"].map(bg_to_cp)

    missing_cp = df_owners["cp"].isna().sum()
    if missing_cp > 0:
        print(f"  WARNING: {missing_cp} owners could not be mapped to a building postal code.")
    else:
        print("  100% of owners successfully mapped to building postal codes.")

    # Cast CP to standard int for clean sorting and serialization
    gdf_buildings["cp"] = gdf_buildings["cp"].astype(int)
    df_owners["cp"] = df_owners["cp"].fillna(-1).astype(int)

    unique_cps = sorted(gdf_buildings["cp"].unique())
    unique_deps = sorted(gdf_buildings["departement"].astype(str).unique())
    print(f"\nPartitioning into {len(unique_cps)} postal code chunks across {len(unique_deps)} departments...")

    chunks_meta = []
    total_buildings_size = 0
    total_owners_size = 0

    for cp_val in unique_cps:
        b_sub = gdf_buildings[gdf_buildings["cp"] == cp_val].copy()
        o_sub = df_owners[df_owners["cp"] == cp_val].copy()

        dep_val = str(b_sub["departement"].iloc[0])
        communes = sorted(b_sub["libelle_commune_insee"].dropna().unique().tolist())

        # Compute bounding box and center for fast map fly-to
        min_lon = float(np.round(b_sub["lon"].min(), 6))
        max_lon = float(np.round(b_sub["lon"].max(), 6))
        min_lat = float(np.round(b_sub["lat"].min(), 6))
        max_lat = float(np.round(b_sub["lat"].max(), 6))
        center_lon = float(np.round((min_lon + max_lon) / 2.0, 6))
        center_lat = float(np.round((min_lat + max_lat) / 2.0, 6))

        b_file_name = f"buildings_{cp_val}.parquet"
        o_file_name = f"owners_{cp_val}.parquet"
        b_file_path = out_dir / b_file_name
        o_file_path = out_dir / o_file_name

        b_sub.to_parquet(b_file_path, compression=compression, index=False)
        o_sub.to_parquet(o_file_path, compression=compression, index=False)

        b_size = b_file_path.stat().st_size
        o_size = o_file_path.stat().st_size
        total_buildings_size += b_size
        total_owners_size += o_size

        chunk_entry = {
            "id": f"cp_{cp_val}",
            "cp": int(cp_val),
            "departement": dep_val,
            "communes": communes,
            "buildings_count": int(len(b_sub)),
            "owners_count": int(len(o_sub)),
            "buildings_file": b_file_name,
            "owners_file": o_file_name,
            "buildings_size_bytes": b_size,
            "owners_size_bytes": o_size,
            "total_size_bytes": b_size + o_size,
            "bbox": [min_lon, min_lat, max_lon, max_lat],
            "center": [center_lon, center_lat],
        }
        chunks_meta.append(chunk_entry)

        print(
            f"  CP {cp_val:05d} ({', '.join(communes[:2])}): "
            f"{len(b_sub):,} bldgs ({b_size / 1024:.1f} KB), "
            f"{len(o_sub):,} owners ({o_size / 1024:.1f} KB)"
        )

    # Department bundles (for downloading an entire metropolitan territory in one file)
    print("\nGenerating department bundles...")
    dep_bundles = {}
    for dep in unique_deps:
        b_dep = gdf_buildings[gdf_buildings["departement"].astype(str) == dep]
        o_dep = df_owners[df_owners["departement"].astype(str) == dep]

        b_dep_name = f"buildings_dep_{dep}.parquet"
        o_dep_name = f"owners_dep_{dep}.parquet"
        b_dep_path = out_dir / b_dep_name
        o_dep_path = out_dir / o_dep_name

        b_dep.to_parquet(b_dep_path, compression=compression, index=False)
        o_dep.to_parquet(o_dep_path, compression=compression, index=False)

        dep_cps = [c["cp"] for c in chunks_meta if c["departement"] == dep]
        dep_bundles[dep] = {
            "departement": dep,
            "label": DEP_LABELS.get(dep, f"Département {dep}"),
            "postal_codes": dep_cps,
            "buildings_count": int(len(b_dep)),
            "owners_count": int(len(o_dep)),
            "buildings_file": b_dep_name,
            "owners_file": o_dep_name,
            "buildings_size_bytes": b_dep_path.stat().st_size,
            "owners_size_bytes": o_dep_path.stat().st_size,
            "bbox": [
                float(np.round(b_dep["lon"].min(), 6)),
                float(np.round(b_dep["lat"].min(), 6)),
                float(np.round(b_dep["lon"].max(), 6)),
                float(np.round(b_dep["lat"].max(), 6)),
            ],
            "center": [
                float(np.round((b_dep["lon"].min() + b_dep["lon"].max()) / 2.0, 6)),
                float(np.round((b_dep["lat"].min() + b_dep["lat"].max()) / 2.0, 6)),
            ],
        }
        print(
            f"  Bundle Dept {dep}: {len(b_dep):,} bldgs "
            f"({b_dep_path.stat().st_size / (1024 * 1024):.2f} MB), "
            f"{len(o_dep):,} owners ({o_dep_path.stat().st_size / (1024 * 1024):.2f} MB)"
        )

    # Master manifest
    manifest = {
        "format_version": "1.0",
        "created_at": datetime.now(timezone.utc).isoformat(),
        "total_buildings": int(len(gdf_buildings)),
        "total_owners": int(len(df_owners)),
        "total_chunks": len(chunks_meta),
        "total_buildings_size_bytes": total_buildings_size,
        "total_owners_size_bytes": total_owners_size,
        "compression": compression,
        "departments": dep_bundles,
        "chunks": chunks_meta,
    }

    manifest_path = out_dir / "manifest.json"
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2, ensure_ascii=False)

    print(f"\nManifest written to {manifest_path} ({manifest_path.stat().st_size / 1024:.1f} KB).")
    print(f"Partitioning completed in {time.time() - t0:.1f}s!")


def main() -> None:
    parser = argparse.ArgumentParser(description="Split TeZeLoMa dataset into postal-code chunks")
    parser.add_argument("--buildings", type=Path, default=DEFAULT_BUILDINGS)
    parser.add_argument("--owners", type=Path, default=DEFAULT_OWNERS)
    parser.add_argument("--out-dir", type=Path, default=DEFAULT_OUT_DIR)
    parser.add_argument("--compression", type=str, default="zstd")
    args = parser.parse_args()

    if not args.buildings.exists():
        sys.exit(f"Error: {args.buildings} does not exist. Run proto/build_dataset.py first.")
    if not args.owners.exists():
        sys.exit(f"Error: {args.owners} does not exist. Run proto/build_dataset.py first.")

    build_chunks(args.buildings, args.owners, args.out_dir, args.compression)


if __name__ == "__main__":
    main()
