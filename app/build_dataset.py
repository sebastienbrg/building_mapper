#!/usr/bin/env python3
"""
TeZeLoMa Rebirth — Multi-Department Fast Standalone Data Pipeline (DuckDB + GeoParquet)
=======================================================================================
Processes both:
  - Département 69 (Rhône) : Lyon (1er-9e) + Villeurbanne
      * CSTB BDNB 2025-07-a (`open_data_millesime_2025-07-a_dep69_csv.zip`)
      * Data Grand Lyon Urban Heat Islands (`ilots_chaleur_urbains.geojson`)
      * Data Grand Lyon Rent Control Zones (`encadrement_loyers.geojson`)
  - Département 38 (Isère) : Grenoble + Principales communes de Grenoble-Alpes Métropole
      * CSTB BDNB 2025-07-a (`open_data_millesime_2025-07-a_dep38_csv.zip`)
      * Cerema Local Climate Zones / ICU Grenoble (`LCZ_SPOT_2022_Grenoble.shp`)
      * Observatoire des Loyers / Zonage Encadrement Grenoble (`L3800_zone_cal_2024_1.kml` + `Base_OP_2024_L3800.csv`)

Outputs to `data/processed/`:
  1. `buildings.parquet`       — 1 row per building across Dept 69 & Dept 38
  2. `building_owners.parquet` — 1 row per (building, corporate owner) across Dept 69 & Dept 38
"""

import json
import time
import zipfile
from pathlib import Path

import duckdb
import geopandas as gpd
import numpy as np
import pandas as pd
import shapely
from shapely import Point, wkt

ROOT_DIR = Path(__file__).resolve().parent.parent
GRANDLYON_DIR = ROOT_DIR / "data" / "grandlyon"
GRENOBLE_DIR = ROOT_DIR / "data" / "grenoble"
OUT_DIR = ROOT_DIR / "data" / "processed"

DEPT_CONFIGS = {
    "69": {
        "label": "69 — Rhône",
        "zip_path": ROOT_DIR / "data" / "bdnb_2025_07_a_dep69" / "open_data_millesime_2025-07-a_dep69_csv.zip",
        "extract_dir": ROOT_DIR / "data" / "bdnb_2025_07_a_dep69" / "extracted_csv",
        "communes": None,
        "postal_codes": None,
    },
    "38": {
        "label": "38 — Isère",
        "zip_path": ROOT_DIR / "data" / "bdnb_2025_07_a_dep38" / "open_data_millesime_2025-07-a_dep38_csv.zip",
        "extract_dir": ROOT_DIR / "data" / "bdnb_2025_07_a_dep38" / "extracted_csv",
        "communes": None,
        "postal_codes": None,
    },
}

NEEDED_CSVS = [
    "csv/batiment_groupe.csv",
    "csv/batiment_groupe_adresse.csv",
    "csv/rel_batiment_groupe_adresse.csv",
    "csv/adresse.csv",
    "csv/batiment_groupe_ffo_bat.csv",
    "csv/batiment_groupe_dpe_representatif_logement.csv",
    "csv/batiment_groupe_dpe_statistique_logement.csv",
    "csv/rel_batiment_groupe_proprietaire.csv",
    "csv/proprietaire.csv",
    "csv/batiment_groupe_synthese_propriete_usage.csv",
    "csv/batiment_groupe_rnc.csv",
    "csv/batiment_groupe_rpls.csv",
    "csv/batiment_groupe_qpv.csv",
    "csv/batiment_groupe_bdtopo_bat.csv",
    "csv/batiment_groupe_urbanisme.csv",
    "csv/batiment_groupe_risques.csv",
    "csv/batiment_groupe_dvf_open_statistique.csv",
    "csv/batiment_groupe_dle_elec_multimillesime.csv",
    "csv/batiment_groupe_dle_gaz_multimillesime.csv",
    "csv/batiment_groupe_indicateur_reseau_chaud_froid.csv",
]

CEREMA_LCZ_LABELS = {
    "1": "Ensemble très compact élevé",
    "2": "Ensemble compact d'immeubles",
    "3": "Ensemble compact bas",
    "4": "Ensemble ouvert élevé",
    "5": "Ensemble ouvert d'immeubles",
    "6": "Ensemble ouvert bas (pavillonnaire)",
    "7": "Bâti léger bas",
    "8": "Grands bâtiments bas (activités/zones commerciales)",
    "9": "Bâti très peu dense",
    "10": "Zone industrielle lourde",
    "A": "Espace densément boisé",
    "B": "Arbres dispersés / parc",
    "C": "Buissons / broussailles",
    "D": "Végétation basse / prairies",
    "E": "Roche ou sol nu minéral",
    "F": "Sol nu ou sableux",
    "G": "Eau (Isère / Drac)",
}


def extract_needed_csvs(zip_path: Path, extract_dir: Path) -> None:
    """Extract only the needed CSV tables from a BDNB zip if not already extracted."""
    extract_dir.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(zip_path, "r") as z:
        for member in NEEDED_CSVS:
            target_file = extract_dir / Path(member).name
            if not target_file.exists():
                print(f"  -> Extracting {member} from {zip_path.name} ...")
                with z.open(member) as src, open(target_file, "wb") as dst:
                    dst.write(src.read())


def enrich_with_grandlyon_spatial_layers(gdf_4326: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    """
    Spatially join Grand Lyon Urban Heat Islands (ICU / LCZ) and Rent Control (Encadrement des loyers)
    onto Dept 69 buildings using their centroids.
    """
    pts = gpd.GeoDataFrame(
        {"batiment_groupe_id": gdf_4326["batiment_groupe_id"].values},
        geometry=gpd.points_from_xy(gdf_4326["lon"], gdf_4326["lat"]),
        crs="EPSG:4326",
    )

    icu_path = GRANDLYON_DIR / "ilots_chaleur_urbains.geojson"
    if icu_path.exists():
        print("  -> [69] Spatially joining Grand Lyon Urban Heat Islands (ICU / LCZ)...")
        icu_gdf = gpd.read_file(icu_path)[
            ["lcz_lib", "lcz_code", "expo_jour", "expo_nuit", "vulnerabilite_jour", "vulnerabilite_nuit", "geometry"]
        ]
        joined_icu = gpd.sjoin(pts, icu_gdf, how="left", predicate="within").drop_duplicates(
            subset=["batiment_groupe_id"]
        )
        icu_map = joined_icu.set_index("batiment_groupe_id")
        gdf_4326["icu_lcz_lib"] = gdf_4326["batiment_groupe_id"].map(icu_map["lcz_lib"])
        gdf_4326["icu_lcz_code"] = gdf_4326["batiment_groupe_id"].map(icu_map["lcz_code"])
        gdf_4326["icu_expo_jour"] = gdf_4326["batiment_groupe_id"].map(icu_map["expo_jour"])
        gdf_4326["icu_expo_nuit"] = gdf_4326["batiment_groupe_id"].map(icu_map["expo_nuit"])
        gdf_4326["icu_vulnerabilite_jour"] = gdf_4326["batiment_groupe_id"].map(icu_map["vulnerabilite_jour"])
        gdf_4326["icu_vulnerabilite_nuit"] = gdf_4326["batiment_groupe_id"].map(icu_map["vulnerabilite_nuit"])
    else:
        for c in ["icu_lcz_lib", "icu_lcz_code", "icu_expo_jour", "icu_expo_nuit", "icu_vulnerabilite_jour", "icu_vulnerabilite_nuit"]:
            gdf_4326[c] = None

    loyers_path = GRANDLYON_DIR / "encadrement_loyers.geojson"
    if loyers_path.exists():
        print("  -> [69] Spatially joining Grand Lyon Rent Control Zones (Encadrement des loyers 2025-2026)...")
        loy_gdf = gpd.read_file(loyers_path)[["zonage", "valeurs", "geometry"]]
        joined_loy = gpd.sjoin(pts, loy_gdf, how="left", predicate="within").drop_duplicates(
            subset=["batiment_groupe_id"]
        )
        loy_map = joined_loy.set_index("batiment_groupe_id")
        gdf_4326["zone_encadrement_loyers"] = pd.to_numeric(
            gdf_4326["batiment_groupe_id"].map(loy_map["zonage"]), errors="coerce"
        ).astype("Int64")

        valeurs_series = gdf_4326["batiment_groupe_id"].map(loy_map["valeurs"])
        annees = pd.to_numeric(gdf_4326["annee_construction"], errors="coerce")

        ref_t2_nm = []
        max_t2_nm = []
        max_t2_m = []
        for val_obj, annee in zip(valeurs_series, annees):
            if not isinstance(val_obj, dict) and isinstance(val_obj, str):
                try:
                    val_obj = json.loads(val_obj)
                except Exception:
                    val_obj = None
            if not isinstance(val_obj, dict):
                ref_t2_nm.append(np.nan)
                max_t2_nm.append(np.nan)
                max_t2_m.append(np.nan)
                continue

            if pd.isna(annee) or annee < 1946:
                epoque = "avant 1946"
            elif annee <= 1970:
                epoque = "1946-1970"
            elif annee <= 1990:
                epoque = "1971-1990"
            elif annee <= 2005:
                epoque = "1991-2005"
            else:
                epoque = "après 2005"

            t2_dict = val_obj.get("2", {}).get(epoque, {})
            nm_dict = t2_dict.get("non meuble", {})
            m_dict = t2_dict.get("meuble", {})
            ref_t2_nm.append(nm_dict.get("loyer_reference", np.nan))
            max_t2_nm.append(nm_dict.get("loyer_reference_majore", np.nan))
            max_t2_m.append(m_dict.get("loyer_reference_majore", np.nan))

        gdf_4326["loyer_ref_t2_non_meuble_m2"] = ref_t2_nm
        gdf_4326["loyer_max_t2_non_meuble_m2"] = max_t2_nm
        gdf_4326["loyer_max_t2_meuble_m2"] = max_t2_m
    else:
        gdf_4326["zone_encadrement_loyers"] = pd.Series([None] * len(gdf_4326), dtype="Int64")
        gdf_4326["loyer_ref_t2_non_meuble_m2"] = np.nan
        gdf_4326["loyer_max_t2_non_meuble_m2"] = np.nan
        gdf_4326["loyer_max_t2_meuble_m2"] = np.nan

    return gdf_4326


def enrich_with_grenoble_spatial_layers(gdf_4326: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    """
    Spatially join Cerema Local Climate Zones (`LCZ_SPOT_2022_Grenoble.shp`) and
    Grenoble Rent Control / OLL Reference Zones (`L3800_zone_cal_2024_1.kml` + `Base_OP_2024_L3800.csv`)
    onto Dept 38 buildings.
    """
    pts_4326 = gpd.GeoDataFrame(
        {"batiment_groupe_id": gdf_4326["batiment_groupe_id"].values},
        geometry=gpd.points_from_xy(gdf_4326["lon"], gdf_4326["lat"]),
        crs="EPSG:4326",
    )

    # 1. Cerema LCZ Grenoble (EPSG:2154)
    lcz_shp = GRENOBLE_DIR / "LCZ_SPOT_2022_Grenoble.shp"
    if lcz_shp.exists():
        print("  -> [38] Spatially joining Cerema LCZ / Urban Heat Islands for Grenoble...")
        pts_2154 = pts_4326.to_crs(epsg=2154)
        minx, miny, maxx, maxy = pts_2154.total_bounds
        lcz_gdf = gpd.read_file(
            lcz_shp,
            bbox=(minx - 500, miny - 500, maxx + 500, maxy + 500),
        )[["lcz", "bur", "ver", "bsr", "geometry"]]
        joined_lcz = gpd.sjoin(pts_2154, lcz_gdf, how="left", predicate="within").drop_duplicates(
            subset=["batiment_groupe_id"]
        )
        lcz_map = joined_lcz.set_index("batiment_groupe_id")

        lcz_codes = gdf_4326["batiment_groupe_id"].map(lcz_map["lcz"]).fillna("").astype(str).str.strip()
        ver_vals = pd.to_numeric(gdf_4326["batiment_groupe_id"].map(lcz_map["ver"]), errors="coerce").fillna(50.0)

        lcz_libs = [CEREMA_LCZ_LABELS.get(c, None) for c in lcz_codes]
        expo_nuit = []
        expo_jour = []
        vuln_nuit = []
        for c, ver in zip(lcz_codes, ver_vals):
            if not c:
                expo_nuit.append(None)
                expo_jour.append(None)
                vuln_nuit.append(None)
            elif c in ("1", "2", "3", "8", "10"):
                if ver < 25.0:
                    expo_nuit.append("fort")
                    expo_jour.append("fort")
                    vuln_nuit.append("fort" if ver < 15.0 else "moyen")
                else:
                    expo_nuit.append("moyen")
                    expo_jour.append("fort")
                    vuln_nuit.append("moyen")
            elif c in ("4", "5", "E"):
                expo_nuit.append("moyen" if ver < 40.0 else "faible")
                expo_jour.append("fort" if ver < 20.0 else "moyen")
                vuln_nuit.append("moyen")
            elif c in ("6", "7", "9", "F"):
                expo_nuit.append("faible")
                expo_jour.append("moyen" if ver < 35.0 else "faible")
                vuln_nuit.append("faible")
            else:
                expo_nuit.append("effet rafraîchissant")
                expo_jour.append("effet rafraîchissant")
                vuln_nuit.append("faible")

        gdf_4326["icu_lcz_code"] = [c if c else None for c in lcz_codes]
        gdf_4326["icu_lcz_lib"] = lcz_libs
        gdf_4326["icu_expo_jour"] = expo_jour
        gdf_4326["icu_expo_nuit"] = expo_nuit
        gdf_4326["icu_vulnerabilite_jour"] = expo_jour
        gdf_4326["icu_vulnerabilite_nuit"] = vuln_nuit
    else:
        for c in ["icu_lcz_lib", "icu_lcz_code", "icu_expo_jour", "icu_expo_nuit", "icu_vulnerabilite_jour", "icu_vulnerabilite_nuit"]:
            gdf_4326[c] = None

    # 2. Grenoble Rent Control / OLL Reference Zones (L3800)
    kml_path = GRENOBLE_DIR / "oll_3800" / "L3800_zone_cal_2024_1.kml"
    csv_path = GRENOBLE_DIR / "oll_3800" / "Base_OP_2024_L3800.csv"
    if kml_path.exists() and csv_path.exists():
        print("  -> [38] Spatially joining Grenoble Rent Control / OLL Zones (L3800)...")
        kml_gdf = gpd.read_file(kml_path)[["VAR4", "geometry"]]
        joined_loy = gpd.sjoin(pts_4326, kml_gdf, how="left", predicate="within").drop_duplicates(
            subset=["batiment_groupe_id"]
        )
        loy_map = joined_loy.set_index("batiment_groupe_id")
        zone_codes = gdf_4326["batiment_groupe_id"].map(loy_map["VAR4"]).fillna("").astype(str)
        # Extract zone number 1..6 from "L3800.1.01".."L3800.1.06"
        zone_nums = [
            int(zc.split(".")[-1]) if zc.startswith("L3800.") and zc.split(".")[-1].isdigit() else None
            for zc in zone_codes
        ]
        gdf_4326["zone_encadrement_loyers"] = pd.Series(zone_nums, dtype="Int64")

        # Load reference rent lookup table from Base_OP_2024_L3800.csv
        oll_df = pd.read_csv(csv_path, sep=";", encoding="latin1")
        oll_t2 = oll_df[
            oll_df["Zone_calcul"].notna()
            & oll_df["Zone_complementaire"].isna()
            & oll_df["anciennete_locataire_local"].isna()
            & oll_df["anciennete_locataire_homogene"].isna()
            & (oll_df["nombre_pieces_homogene"] == "Appart 2P")
            & oll_df["loyer_median"].notna()
        ].copy()
        oll_t2["loyer_num"] = (
            oll_t2["loyer_median"].astype(str).str.replace(",", ".", regex=False).astype(float)
        )

        # Build lookup {(zone_code, epoque_key): loyer_ref} and fallback {zone_code: loyer_ref}
        zone_fallback = {}
        zone_epoque_lookup = {}
        for _, r in oll_t2.iterrows():
            zc = str(r["Zone_calcul"]).strip()
            ep = r["epoque_construction_homogene"]
            val = float(r["loyer_num"])
            if pd.isna(ep) or str(ep).strip() == "":
                zone_fallback[zc] = val
            else:
                zone_epoque_lookup[(zc, str(ep).strip())] = val

        annees = pd.to_numeric(gdf_4326["annee_construction"], errors="coerce")
        ref_t2_nm = []
        max_t2_nm = []
        max_t2_m = []
        for zc, annee in zip(zone_codes, annees):
            if not zc or zc not in zone_fallback:
                ref_t2_nm.append(np.nan)
                max_t2_nm.append(np.nan)
                max_t2_m.append(np.nan)
                continue

            if pd.isna(annee) or annee < 1946:
                ep_key = "1. Avant 1946"
            elif annee <= 1970:
                ep_key = "2. Entre 1946-1970"
            elif annee <= 1990:
                ep_key = "3. Entre 1971-1990"
            elif annee <= 2005:
                ep_key = "4. Entre 1991-2005"
            else:
                ep_key = "5. Après 2005"

            ref_val = zone_epoque_lookup.get((zc, ep_key), zone_fallback.get(zc, np.nan))
            if pd.notna(ref_val):
                maj_nm = round(ref_val * 1.20, 2)
                maj_m = round(maj_nm * 1.12, 2)
                ref_t2_nm.append(round(ref_val, 2))
                max_t2_nm.append(maj_nm)
                max_t2_m.append(maj_m)
            else:
                ref_t2_nm.append(np.nan)
                max_t2_nm.append(np.nan)
                max_t2_m.append(np.nan)

        gdf_4326["loyer_ref_t2_non_meuble_m2"] = ref_t2_nm
        gdf_4326["loyer_max_t2_non_meuble_m2"] = max_t2_nm
        gdf_4326["loyer_max_t2_meuble_m2"] = max_t2_m
    else:
        gdf_4326["zone_encadrement_loyers"] = pd.Series([None] * len(gdf_4326), dtype="Int64")
        gdf_4326["loyer_ref_t2_non_meuble_m2"] = np.nan
        gdf_4326["loyer_max_t2_non_meuble_m2"] = np.nan
        gdf_4326["loyer_max_t2_meuble_m2"] = np.nan

    return gdf_4326


def compute_overheating_metrics(df: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    """
    Compute a transparent, explainable Summer Overheating Vulnerability Score (0-100)
    combining building envelope defects (BDNB/DPE) AND Urban Heat Island exposure (ICU / LCZ).
    """
    scores = np.zeros(len(df), dtype=float)
    has_envelope_or_dpe = np.zeros(len(df), dtype=bool)
    factors_list = [[] for _ in range(len(df))]

    # 1. Roof / Attic Insulation (up to +25 pts)
    isol_haut = df["type_isolation_plancher_haut"].fillna("").astype(str).str.lower()
    u_haut = pd.to_numeric(df["u_plancher_haut_deperditif"], errors="coerce")
    for i, (ih, uh) in enumerate(zip(isol_haut, u_haut)):
        if ih and ih not in ("inconnu", "non renseigné", "none", "nan"):
            has_envelope_or_dpe[i] = True
            if "non isol" in ih:
                scores[i] += 25
                factors_list[i].append("Toiture/plancher haut non isolé")
        elif pd.notna(uh):
            has_envelope_or_dpe[i] = True
            if uh > 1.2:
                scores[i] += 22
                factors_list[i].append(f"Forte déperdition toiture (U={uh:.2f})")
            elif uh > 0.5:
                scores[i] += 10

    # 2. Exterior Wall Insulation (up to +12 pts)
    isol_mur = df["type_isolation_mur_exterieur"].fillna("").astype(str).str.lower()
    for i, im in enumerate(isol_mur):
        if im and im not in ("inconnu", "non renseigné", "none", "nan"):
            has_envelope_or_dpe[i] = True
            if "non isol" in im:
                scores[i] += 12
                factors_list[i].append("Murs extérieurs non isolés")

    # 3. Shutters / Exterior Solar Protection (up to +18 pts)
    ferm = df["type_fermeture"].fillna("").astype(str).str.lower()
    for i, fm in enumerate(ferm):
        if fm and fm not in ("inconnu", "non renseigné", "none", "nan"):
            has_envelope_or_dpe[i] = True
            if "sans fermeture" in fm or "absence" in fm:
                scores[i] += 18
                factors_list[i].append("Absence de volets / fermetures")
            elif "volets roulants" not in fm and "persienne" not in fm and "battant" not in fm:
                scores[i] += 7

    # 4. Building Thermal Inertia (up to +12 pts)
    inertie = df["classe_inertie"].fillna("").astype(str).str.lower()
    for i, inr in enumerate(inertie):
        if inr and inr not in ("inconnu", "non renseigné", "none", "nan"):
            has_envelope_or_dpe[i] = True
            if "légère" in inr or "legere" in inr:
                scores[i] += 12
                factors_list[i].append("Inertie thermique légère")
            elif "moyenne" in inr:
                scores[i] += 5

    # 5. Cross-ventilation / Traversant (up to +10 pts)
    trav = df["traversant"].fillna("").astype(str).str.lower()
    multi_fac = pd.to_numeric(df["plusieurs_facade_exposee"], errors="coerce")
    for i, (tr, mf) in enumerate(zip(trav, multi_fac)):
        if tr and tr not in ("inconnu", "non renseigné", "none", "nan"):
            has_envelope_or_dpe[i] = True
            if "non" in tr or tr in ("0", "false", "faux") or "une seule" in tr:
                scores[i] += 10
                factors_list[i].append("Logement non traversant")
        elif pd.notna(mf):
            has_envelope_or_dpe[i] = True
            if mf == 0:
                scores[i] += 10
                factors_list[i].append("Une seule façade exposée")

    # 6. Roof Windows / Skylights & Solar Factor (up to +8 pts)
    sv_horiz = pd.to_numeric(df["surface_vitree_horizontal"], errors="coerce").fillna(0)
    fs_baie = pd.to_numeric(df["facteur_solaire_baie_vitree"], errors="coerce")
    for i, (svh, fsb) in enumerate(zip(sv_horiz, fs_baie)):
        if svh > 0:
            has_envelope_or_dpe[i] = True
            scores[i] += 5
            factors_list[i].append(f"Fenêtres de toit / Velux ({svh:.1f} m²)")
        if pd.notna(fsb) and fsb > 0.55:
            has_envelope_or_dpe[i] = True
            scores[i] += 3
            factors_list[i].append(f"Facteur solaire vitrage élevé ({fsb:.2f})")

    # 7. Passoire énergétique DPE F or G (up to +15 pts)
    dpe_col = df["dpe"].fillna("").astype(str).str.upper()
    pct_fg_col = pd.to_numeric(df.get("pct_dpe_fg"), errors="coerce").fillna(0)
    for i, (d_val, pfg) in enumerate(zip(dpe_col, pct_fg_col)):
        if d_val in ("F", "G") or pfg >= 30:
            has_envelope_or_dpe[i] = True
            if d_val == "G":
                scores[i] += 15
                factors_list[i].append("Passoire énergétique (DPE G)")
            elif d_val == "F":
                scores[i] += 10
                factors_list[i].append("Passoire énergétique (DPE F)")
            elif pfg >= 30:
                scores[i] += 8
                factors_list[i].append(f"{pfg:.0f}% de logements DPE F/G")

    # 8. Urban Heat Island (ICU / Cerema LCZ — Daytime & Nighttime exposure, up to +20 pts)
    icu_j = df.get("icu_expo_jour", pd.Series([None] * len(df))).fillna("").astype(str).str.lower()
    icu_n = df.get("icu_expo_nuit", pd.Series([None] * len(df))).fillna("").astype(str).str.lower()
    icu_vn = df.get("icu_vulnerabilite_nuit", pd.Series([None] * len(df))).fillna("").astype(str).str.lower()
    for i, (ej, en, vn) in enumerate(zip(icu_j, icu_n, icu_vn)):
        icu_pts = 0
        if en == "fort":
            icu_pts += 12
            factors_list[i].append("Îlot de chaleur nocturne fort")
        elif en == "moyen":
            icu_pts += 6
        if ej == "fort":
            icu_pts += 8
            factors_list[i].append("Îlot de chaleur diurne fort")
        elif ej == "moyen":
            icu_pts += 4
        if vn == "fort" and "Îlot de chaleur nocturne fort" not in factors_list[i]:
            icu_pts += 4
            factors_list[i].append("Forte vulnérabilité thermique nocturne (ICU)")
        scores[i] += min(icu_pts, 20)

    scores = np.clip(np.round(scores, 0), 0, 100)
    has_icu = (icu_j != "") | (icu_n != "")
    final_scores = [int(s) if (hd or hi) else None for s, hd, hi in zip(scores, has_envelope_or_dpe, has_icu)]

    risk_labels = []
    for s in final_scores:
        if s is None:
            risk_labels.append("Non renseigné")
        elif s >= 65:
            risk_labels.append("Critique")
        elif s >= 45:
            risk_labels.append("Élevé")
        elif s >= 25:
            risk_labels.append("Modéré")
        else:
            risk_labels.append("Faible")

    df["score_surchauffe_ete"] = pd.Series(final_scores, dtype="Int64", index=df.index)
    df["risque_surchauffe_ete"] = risk_labels
    df["facteurs_surchauffe"] = [
        " • ".join(f) if f else "Aucun facteur majeur identifié"
        for f in factors_list
    ]
    return df


def process_department(dept_code: str, cfg: dict) -> tuple[gpd.GeoDataFrame, pd.DataFrame]:
    """Run DuckDB extraction, geometry projection, spatial joins, and overheating scoring for one department."""
    t_dep = time.time()
    print(f"\n=== Processing Department {dept_code} ({cfg['label']}) ===")
    extract_needed_csvs(cfg["zip_path"], cfg["extract_dir"])

    con = duckdb.connect(database=":memory:")
    csv_dir = str(cfg["extract_dir"])

    communes_clause = ""
    if cfg.get("communes"):
        communes_sql = ", ".join(f"'{c}'" for c in cfg["communes"])
        communes_clause = f"WHERE code_commune_insee IN ({communes_sql})"

    cp_clause = "WHERE a.code_postal IS NOT NULL AND a.code_postal != ''"
    if cfg.get("postal_codes"):
        cp_sql = ", ".join(f"'{c}'" for c in cfg["postal_codes"])
        cp_clause += f" AND a.code_postal IN ({cp_sql})"

    con.execute(f"""
        CREATE TABLE bg_base AS
        SELECT
            batiment_groupe_id,
            geom_groupe,
            code_commune_insee,
            libelle_commune_insee,
            code_iris,
            TRY_CAST(s_geom_groupe AS DOUBLE) AS surface_emprise_sol_m2
        FROM read_csv_auto('{csv_dir}/batiment_groupe.csv', delim=';', header=true, all_varchar=true)
        {communes_clause}
    """)

    con.execute(f"""
        CREATE TABLE bg_adr_raw AS
        SELECT
            r.batiment_groupe_id,
            a.numero,
            a.rep,
            a.type_voie,
            a.nom_voie,
            a.code_postal,
            a.libelle_commune,
            TRIM(
                COALESCE(CAST(TRY_CAST(a.numero AS INTEGER) AS VARCHAR) || ' ', '') ||
                COALESCE(NULLIF(TRIM(a.rep), '') || ' ', '') ||
                COALESCE(NULLIF(TRIM(a.type_voie), '') || ' ', '') ||
                COALESCE(NULLIF(TRIM(a.nom_voie), '') || ' ', '') ||
                COALESCE(CAST(TRY_CAST(a.code_postal AS INTEGER) AS VARCHAR), '')
            ) AS adr_formatted
        FROM read_csv_auto('{csv_dir}/rel_batiment_groupe_adresse.csv', delim=';', header=true, all_varchar=true) r
        INNER JOIN bg_base b ON r.batiment_groupe_id = b.batiment_groupe_id
        LEFT JOIN read_csv_auto('{csv_dir}/adresse.csv', delim=';', header=true, all_varchar=true) a
            ON r.cle_interop_adr = a.cle_interop_adr
        {cp_clause}
    """)

    con.execute("""
        CREATE TABLE bg_adr AS
        SELECT
            batiment_groupe_id,
            FIRST(adr_formatted ORDER BY numero NULLS LAST) AS adr,
            FIRST(TRY_CAST(code_postal AS INTEGER) ORDER BY numero NULLS LAST) AS cp,
            FIRST(libelle_commune ORDER BY numero NULLS LAST) AS commune_adr,
            COUNT(DISTINCT adr_formatted) AS nb_adresses
        FROM bg_adr_raw
        GROUP BY batiment_groupe_id
    """)

    con.execute(f"""
        CREATE TABLE building_owners AS
        SELECT
            '{dept_code}' AS departement,
            r.batiment_groupe_id,
            r.personne_id,
            p.siren,
            COALESCE(NULLIF(TRIM(p.forme_juridique), ''), 'personne_physique') AS forme_juridique,
            TRIM(p.denomination) AS denomination,
            TRIM(p.code_postal) AS code_postal_proprietaire,
            TRIM(p.libelle_commune) AS libelle_commune_proprietaire,
            TRY_CAST(r.nb_locaux_open AS INTEGER) AS nb_locaux_open_dans_batiment,
            TRY_CAST(p.nb_locaux_open AS INTEGER) AS nb_locaux_open_dans_MAJIC,
            TRY_CAST(ba.cp AS INTEGER) AS cp
        FROM read_csv_auto('{csv_dir}/rel_batiment_groupe_proprietaire.csv', delim=';', header=true, all_varchar=true) r
        INNER JOIN bg_adr ba ON r.batiment_groupe_id = ba.batiment_groupe_id
        LEFT JOIN read_csv_auto('{csv_dir}/proprietaire.csv', delim=';', header=true, all_varchar=true) p
            ON r.personne_id = p.personne_id
    """)

    con.execute("""
        CREATE TABLE owners_per_building AS
        WITH dedup AS (
            SELECT
                batiment_groupe_id,
                personne_id,
                FIRST(siren) AS siren,
                FIRST(forme_juridique) AS forme_juridique,
                FIRST(denomination) AS denomination,
                FIRST(nb_locaux_open_dans_batiment) AS nb_locaux_bat,
                FIRST(nb_locaux_open_dans_MAJIC) AS nb_locaux_majic
            FROM building_owners
            GROUP BY batiment_groupe_id, personne_id
        ),
        totals AS (
            SELECT
                batiment_groupe_id,
                SUM(COALESCE(nb_locaux_bat, 0)) AS total_locaux_open_bat,
                COUNT(DISTINCT personne_id) AS nb_proprietaires_open,
                MAX(nb_locaux_majic) AS max_patrimoine_majic_bailleur
            FROM dedup
            GROUP BY batiment_groupe_id
        )
        SELECT
            d.batiment_groupe_id,
            LIST(DISTINCT d.forme_juridique ORDER BY d.forme_juridique) AS formes_juridiques_list,
            LIST(DISTINCT d.denomination ORDER BY d.denomination) FILTER (WHERE d.denomination IS NOT NULL AND d.denomination != '') AS denominations_list,
            FIRST(d.denomination ORDER BY d.nb_locaux_bat DESC NULLS LAST) AS concentration_prop_max_denomination,
            FIRST(d.siren ORDER BY d.nb_locaux_bat DESC NULLS LAST) AS siren_principal,
            FIRST(d.forme_juridique ORDER BY d.nb_locaux_bat DESC NULLS LAST) AS forme_juridique_principale,
            FIRST(d.nb_locaux_bat ORDER BY d.nb_locaux_bat DESC NULLS LAST) AS max_locaux_open_un_prop,
            FIRST(t.total_locaux_open_bat) AS total_locaux_open_bat,
            FIRST(t.nb_proprietaires_open) AS nb_proprietaires_open,
            FIRST(t.max_patrimoine_majic_bailleur) AS max_patrimoine_majic_bailleur,
            CASE
                WHEN FIRST(t.total_locaux_open_bat) > 0
                THEN ROUND(CAST(MAX(d.nb_locaux_bat) AS DOUBLE) / CAST(FIRST(t.total_locaux_open_bat) AS DOUBLE), 4)
                ELSE NULL
            END AS concentration_prop_max_num
        FROM dedup d
        JOIN totals t ON d.batiment_groupe_id = t.batiment_groupe_id
        GROUP BY d.batiment_groupe_id
    """)

    con.execute(f"""
        CREATE TABLE dle_elec_latest AS
        SELECT
            e.batiment_groupe_id,
            ROUND(FIRST(TRY_CAST(e.conso_res_par_pdl AS DOUBLE) ORDER BY e.millesime DESC NULLS LAST), 0) AS conso_elec_res_par_pdl_kwh
        FROM read_csv_auto('{csv_dir}/batiment_groupe_dle_elec_multimillesime.csv', delim=';', header=true, all_varchar=true) e
        INNER JOIN bg_adr ba ON e.batiment_groupe_id = ba.batiment_groupe_id
        WHERE e.conso_res_par_pdl IS NOT NULL AND e.conso_res_par_pdl != ''
        GROUP BY e.batiment_groupe_id
    """)

    con.execute(f"""
        CREATE TABLE dle_gaz_latest AS
        SELECT
            g.batiment_groupe_id,
            ROUND(FIRST(TRY_CAST(g.conso_res_par_pdl AS DOUBLE) ORDER BY g.millesime DESC NULLS LAST), 0) AS conso_gaz_res_par_pdl_kwh
        FROM read_csv_auto('{csv_dir}/batiment_groupe_dle_gaz_multimillesime.csv', delim=';', header=true, all_varchar=true) g
        INNER JOIN bg_adr ba ON g.batiment_groupe_id = ba.batiment_groupe_id
        WHERE g.conso_res_par_pdl IS NOT NULL AND g.conso_res_par_pdl != ''
        GROUP BY g.batiment_groupe_id
    """)

    con.execute(f"""
        CREATE TABLE rcu_dedup AS
        SELECT
            rc.batiment_groupe_id,
            FIRST(rc.indicateur_distance_au_reseau ORDER BY rc.indicateur_distance_au_reseau NULLS LAST) AS distance_reseau_chaleur,
            MAX(TRY_CAST(rc.perimetre_developpement_prioritaire AS INTEGER)) AS rcu_perimetre_prioritaire
        FROM read_csv_auto('{csv_dir}/batiment_groupe_indicateur_reseau_chaud_froid.csv', delim=';', header=true, all_varchar=true) rc
        INNER JOIN bg_adr ba ON rc.batiment_groupe_id = ba.batiment_groupe_id
        GROUP BY rc.batiment_groupe_id
    """)

    con.execute(f"""
        CREATE TABLE buildings_joined AS
        SELECT
            '{dept_code}' AS departement,
            b.batiment_groupe_id,
            b.geom_groupe,
            b.code_commune_insee,
            b.libelle_commune_insee,
            b.code_iris,
            b.surface_emprise_sol_m2,
            ba.adr,
            ba.cp,
            ba.nb_adresses,
            TRY_CAST(ffo.nb_log AS INTEGER) AS nb_log,
            TRY_CAST(ffo.nb_niveau AS INTEGER) AS nb_niveau,
            TRY_CAST(ffo.annee_construction AS INTEGER) AS annee_construction,
            ffo.usage_niveau_1_txt,
            ffo.mat_mur_txt,
            ffo.mat_toit_txt,
            syn.usage_principal_bdnb_open,
            UPPER(NULLIF(TRIM(dpe.classe_bilan_dpe), '')) AS dpe,
            UPPER(NULLIF(TRIM(dpe.classe_emission_ges), '')) AS classe_ges,
            TRY_CAST(dpe.conso_5_usages_ep_m2 AS DOUBLE) AS conso_ep_m2,
            TRY_CAST(dpe.emission_ges_5_usages_m2 AS DOUBLE) AS emission_ges_m2,
            TRY_CAST(dpe.surface_habitable_logement AS DOUBLE) AS surface_habitable_logement,
            TRY_CAST(dpe.arrete_2021 AS INTEGER) AS dpe_arrete_2021,
            dpe.date_etablissement_dpe,
            dpe.type_dpe,
            dpe.type_batiment_dpe,
            dpe.periode_construction_dpe,
            dpe.type_installation_chauffage,
            dpe.type_energie_chauffage,
            dpe.type_generateur_chauffage,
            dpe.type_installation_ecs,
            dpe.type_energie_ecs,
            dpe.type_energie_climatisation,
            dpe.type_generateur_climatisation,
            dpe.type_ventilation,
            dpe.type_vitrage,
            dpe.type_materiaux_menuiserie,
            dpe.type_fermeture,
            dpe.traversant,
            TRY_CAST(dpe.plusieurs_facade_exposee AS INTEGER) AS plusieurs_facade_exposee,
            TRY_CAST(dpe.presence_balcon AS INTEGER) AS presence_balcon,
            TRY_CAST(dpe.surface_vitree_sud AS DOUBLE) AS surface_vitree_sud,
            TRY_CAST(dpe.surface_vitree_ouest AS DOUBLE) AS surface_vitree_ouest,
            TRY_CAST(dpe.surface_vitree_horizontal AS DOUBLE) AS surface_vitree_horizontal,
            TRY_CAST(dpe.facteur_solaire_baie_vitree AS DOUBLE) AS facteur_solaire_baie_vitree,
            dpe.type_isolation_mur_exterieur,
            dpe.materiaux_structure_mur_exterieur,
            TRY_CAST(dpe.u_mur_exterieur AS DOUBLE) AS u_mur_exterieur,
            dpe.type_isolation_plancher_bas,
            dpe.type_isolation_plancher_haut,
            dpe.type_plancher_haut_deperditif,
            TRY_CAST(dpe.u_plancher_haut_deperditif AS DOUBLE) AS u_plancher_haut_deperditif,
            dpe.classe_inertie,
            TRY_CAST(stat.nb_classe_bilan_dpe_a AS INTEGER) AS nb_dpe_a,
            TRY_CAST(stat.nb_classe_bilan_dpe_b AS INTEGER) AS nb_dpe_b,
            TRY_CAST(stat.nb_classe_bilan_dpe_c AS INTEGER) AS nb_dpe_c,
            TRY_CAST(stat.nb_classe_bilan_dpe_d AS INTEGER) AS nb_dpe_d,
            TRY_CAST(stat.nb_classe_bilan_dpe_e AS INTEGER) AS nb_dpe_e,
            TRY_CAST(stat.nb_classe_bilan_dpe_f AS INTEGER) AS nb_dpe_f,
            TRY_CAST(stat.nb_classe_bilan_dpe_g AS INTEGER) AS nb_dpe_g,
            own.formes_juridiques_list,
            own.denominations_list,
            COALESCE(own.concentration_prop_max_denomination, 'NC') AS concentration_prop_max_denomination,
            own.siren_principal,
            own.forme_juridique_principale,
            COALESCE(own.max_locaux_open_un_prop, 0) AS max_locaux_open_un_prop,
            COALESCE(own.total_locaux_open_bat, 0) AS total_locaux_open_bat,
            COALESCE(own.nb_proprietaires_open, 0) AS nb_proprietaires_open,
            COALESCE(own.max_patrimoine_majic_bailleur, 0) AS max_patrimoine_majic_bailleur,
            own.concentration_prop_max_num,
            rnc.numero_immat_principal AS immat_copro,
            rnc.l_nom_copro AS nom_copro,
            rnc.l_siret AS siret_copro,
            TRY_CAST(rnc.nb_lot_tot AS INTEGER) AS nb_lots_copro,
            TRY_CAST(rnc.nb_lot_garpark AS INTEGER) AS nb_lots_stationnement_copro,
            TRY_CAST(rnc.nb_lot_tertiaire AS INTEGER) AS nb_lots_tertiaire_copro,
            CASE WHEN rpls.batiment_groupe_id IS NOT NULL THEN TRUE ELSE FALSE END AS est_logement_social_rpls,
            TRY_CAST(rpls.nb_log AS INTEGER) AS nb_log_sociaux_rpls,
            rpls.classe_ener_principale AS dpe_principal_rpls,
            TRY_CAST(rpls.accessible_pmr AS INTEGER) AS nb_log_pmr_rpls,
            qpv.nom_quartier AS quartier_qpv,
            TRY_CAST(topo.hauteur_mean AS DOUBLE) AS hauteur_moyenne_m,
            urb.zone_plu_bati_patrimonial,
            urb.contrainte_urbanisme_ac1,
            urb.monument_historique,
            risq.alea_argile,
            risq.alea_radon,
            TRY_CAST(dvf.nb_mutation AS INTEGER) AS dvf_nb_mutations,
            TRY_CAST(dvf.prix_m2_local_median AS DOUBLE) AS dvf_prix_m2_median,
            TRY_CAST(dvf.valeur_fonciere_median AS DOUBLE) AS dvf_valeur_mediane,
            elec.conso_elec_res_par_pdl_kwh,
            gaz.conso_gaz_res_par_pdl_kwh,
            rcu.distance_reseau_chaleur,
            rcu.rcu_perimetre_prioritaire
        FROM bg_base b
        INNER JOIN bg_adr ba ON b.batiment_groupe_id = ba.batiment_groupe_id
        LEFT JOIN read_csv_auto('{csv_dir}/batiment_groupe_ffo_bat.csv', delim=';', header=true, all_varchar=true) ffo
            ON b.batiment_groupe_id = ffo.batiment_groupe_id
        LEFT JOIN read_csv_auto('{csv_dir}/batiment_groupe_synthese_propriete_usage.csv', delim=';', header=true, all_varchar=true) syn
            ON b.batiment_groupe_id = syn.batiment_groupe_id
        LEFT JOIN read_csv_auto('{csv_dir}/batiment_groupe_dpe_representatif_logement.csv', delim=';', header=true, all_varchar=true) dpe
            ON b.batiment_groupe_id = dpe.batiment_groupe_id
        LEFT JOIN read_csv_auto('{csv_dir}/batiment_groupe_dpe_statistique_logement.csv', delim=';', header=true, all_varchar=true) stat
            ON b.batiment_groupe_id = stat.batiment_groupe_id
        LEFT JOIN owners_per_building own
            ON b.batiment_groupe_id = own.batiment_groupe_id
        LEFT JOIN read_csv_auto('{csv_dir}/batiment_groupe_rnc.csv', delim=';', header=true, all_varchar=true) rnc
            ON b.batiment_groupe_id = rnc.batiment_groupe_id
        LEFT JOIN read_csv_auto('{csv_dir}/batiment_groupe_rpls.csv', delim=';', header=true, all_varchar=true) rpls
            ON b.batiment_groupe_id = rpls.batiment_groupe_id
        LEFT JOIN read_csv_auto('{csv_dir}/batiment_groupe_qpv.csv', delim=';', header=true, all_varchar=true) qpv
            ON b.batiment_groupe_id = qpv.batiment_groupe_id
        LEFT JOIN read_csv_auto('{csv_dir}/batiment_groupe_bdtopo_bat.csv', delim=';', header=true, all_varchar=true) topo
            ON b.batiment_groupe_id = topo.batiment_groupe_id
        LEFT JOIN read_csv_auto('{csv_dir}/batiment_groupe_urbanisme.csv', delim=';', header=true, all_varchar=true) urb
            ON b.batiment_groupe_id = urb.batiment_groupe_id
        LEFT JOIN read_csv_auto('{csv_dir}/batiment_groupe_risques.csv', delim=';', header=true, all_varchar=true) risq
            ON b.batiment_groupe_id = risq.batiment_groupe_id
        LEFT JOIN read_csv_auto('{csv_dir}/batiment_groupe_dvf_open_statistique.csv', delim=';', header=true, all_varchar=true) dvf
            ON b.batiment_groupe_id = dvf.batiment_groupe_id
        LEFT JOIN dle_elec_latest elec
            ON b.batiment_groupe_id = elec.batiment_groupe_id
        LEFT JOIN dle_gaz_latest gaz
            ON b.batiment_groupe_id = gaz.batiment_groupe_id
        LEFT JOIN rcu_dedup rcu
            ON b.batiment_groupe_id = rcu.batiment_groupe_id
    """)

    df_buildings = con.execute("SELECT * FROM buildings_joined").df()
    df_owners = con.execute("SELECT * FROM building_owners").df()
    print(f"  -> [{dept_code}] Joined {len(df_buildings):,} buildings and {len(df_owners):,} owner links in {time.time() - t_dep:.1f}s")

    nb_log_num = pd.to_numeric(df_buildings["nb_log"], errors="coerce")
    valid_log = nb_log_num.notna() & (nb_log_num > 0)

    total_dpe_counted = np.zeros(len(df_buildings), dtype=float)
    has_any_dpe = np.zeros(len(df_buildings), dtype=bool)

    for letter in ["a", "b", "c", "d", "e", "f", "g"]:
        cnt_col = pd.to_numeric(df_buildings[f"nb_dpe_{letter}"], errors="coerce")
        pct_num = np.where(valid_log & cnt_col.notna(), np.round((cnt_col / nb_log_num) * 100.0, 2), np.nan)
        df_buildings[f"pct_dpe_{letter}"] = pct_num
        df_buildings[f"pourcentage_dpe_{letter}"] = [
            f"{v:.2f}" if pd.notna(v) else "NC" for v in pct_num
        ]
        total_dpe_counted += np.where(cnt_col.notna(), cnt_col, 0.0)
        has_any_dpe |= cnt_col.notna()

    df_buildings["nb_dpe_fg"] = (
        pd.to_numeric(df_buildings["nb_dpe_f"], errors="coerce").fillna(0)
        + pd.to_numeric(df_buildings["nb_dpe_g"], errors="coerce").fillna(0)
    ).astype(int)
    df_buildings["pct_dpe_fg"] = np.where(
        valid_log & has_any_dpe,
        np.clip(np.round((df_buildings["nb_dpe_fg"] / nb_log_num) * 100.0, 2), 0.0, 100.0),
        np.nan,
    )

    pct_inconnu_num = np.where(
        valid_log,
        np.clip(np.round(((nb_log_num - total_dpe_counted) / nb_log_num) * 100.0, 2), -100.0, 100.0),
        np.nan,
    )
    df_buildings["pct_dpe_inconnu"] = pct_inconnu_num
    df_buildings["pourcentage_dpe_inconnu"] = [
        f"{v:.2f}" if pd.notna(v) else "NC" for v in pct_inconnu_num
    ]

    formes_clean = []
    for fj_list in df_buildings["formes_juridiques_list"]:
        if fj_list is None or (not isinstance(fj_list, (list, np.ndarray)) and pd.isna(fj_list)):
            formes_clean.append(["personne_physique"])
        elif len(fj_list) == 0:
            formes_clean.append(["personne_physique"])
        else:
            lst = [str(x) for x in fj_list if x is not None and not pd.isna(x)]
            formes_clean.append(lst if lst else ["personne_physique"])

    df_buildings["formes_juridiques_ivec"] = formes_clean
    df_buildings["formes_juridiques"] = [str(x) for x in formes_clean]

    conc_num = np.where(
        valid_log & df_buildings["concentration_prop_max_num"].notna(),
        df_buildings["concentration_prop_max_num"],
        np.nan,
    )
    df_buildings["concentration_prop_max_pct"] = np.round(conc_num * 100.0, 1)
    df_buildings["concentration_prop_max"] = [
        str(v) if pd.notna(v) else "NC" for v in conc_num
    ]

    print(f"  -> [{dept_code}] Parsing geometries with Shapely...")
    geoms_2154 = shapely.from_wkt(df_buildings["geom_groupe"].fillna("").values, on_invalid="ignore")
    gdf = gpd.GeoDataFrame(
        df_buildings.drop(columns=["geom_groupe", "formes_juridiques_list", "denominations_list"]),
        geometry=geoms_2154,
        crs="EPSG:2154",
    )
    print(f"  -> [{dept_code}] Reprojecting geometries to WGS84 (EPSG:4326)...")
    gdf_4326 = gdf.to_crs(epsg=4326)

    centroids_4326 = gdf.geometry.centroid.to_crs(epsg=4326)
    gdf_4326["lon"] = np.round(centroids_4326.x, 6)
    gdf_4326["lat"] = np.round(centroids_4326.y, 6)

    if dept_code == "69":
        gdf_4326 = enrich_with_grandlyon_spatial_layers(gdf_4326)
    elif dept_code == "38":
        gdf_4326 = enrich_with_grenoble_spatial_layers(gdf_4326)

    gdf_4326 = compute_overheating_metrics(gdf_4326)
    return gdf_4326, df_owners


def main() -> None:
    t0 = time.time()
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    gdfs = []
    owner_dfs = []
    for dept_code, cfg in DEPT_CONFIGS.items():
        if cfg["zip_path"].exists():
            gdf_dep, df_own_dep = process_department(dept_code, cfg)
            gdfs.append(gdf_dep)
            owner_dfs.append(df_own_dep)
        else:
            print(f"WARNING: {cfg['zip_path']} not found, skipping dept {dept_code}")

    gdf_all = gpd.GeoDataFrame(pd.concat(gdfs, ignore_index=True), crs="EPSG:4326")
    df_owners_all = pd.concat(owner_dfs, ignore_index=True)

    buildings_parquet_path = OUT_DIR / "buildings.parquet"
    owners_parquet_path = OUT_DIR / "building_owners.parquet"

    print("\nWriting combined compressed Parquet files (Dept 69 + Dept 38)...")
    gdf_all.to_parquet(buildings_parquet_path, compression="zstd", index=False)
    df_owners_all.to_parquet(owners_parquet_path, compression="zstd", index=False)

    b_size_mb = buildings_parquet_path.stat().st_size / (1024 * 1024)
    o_size_mb = owners_parquet_path.stat().st_size / (1024 * 1024)
    print(f"Done in {time.time() - t0:.1f}s!")
    print(f"  -> {buildings_parquet_path}: {b_size_mb:.2f} MB ({len(gdf_all):,} buildings total)")
    print(f"  -> {owners_parquet_path}: {o_size_mb:.2f} MB ({len(df_owners_all):,} owner links total)")

    # Generate postal-code and department chunks + manifest for standalone static UI
    chunks_dir = ROOT_DIR / "data" / "chunks"
    try:
        try:
            from app.chunk_dataset import build_chunks
        except ImportError:
            from chunk_dataset import build_chunks
        print("\nGenerating postal-code chunks and manifest.json for static app...")
        build_chunks(buildings_parquet_path, owners_parquet_path, chunks_dir)
    except Exception as e:
        print(f"Notice: Chunk generation skipped or failed: {e}")

    try:
        try:
            from app.build_postal_zones import main as build_zones_main
        except ImportError:
            from build_postal_zones import main as build_zones_main
        print("\nRegenerating postal_zones.geojson for static app...")
        build_zones_main()
    except Exception as e:
        print(f"Notice: Postal zones generation skipped or failed: {e}")


if __name__ == "__main__":
    main()
