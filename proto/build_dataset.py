#!/usr/bin/env python3
"""
TeZeLoMa Rebirth — Fast Standalone Data Pipeline (DuckDB + GeoParquet)
======================================================================
Replaces the legacy 663-line PostgreSQL N+1 script (`extraction_bdnb_lyon.py`,
which ran ~350,000 SQL queries and output a 473 MB + 20 MB GeoPackage pair)
with a standalone, <10-second DuckDB + GeoPandas pipeline reading directly from:
  1. Official CSTB BDNB Open Data CSV archive (`open_data_millesime_2025-07-a_dep69_csv.zip`)
  2. Official Data Grand Lyon Urban Heat Islands (`ilots_chaleur_urbains.geojson`)
  3. Official Data Grand Lyon Rent Control Zones (`encadrement_loyers.geojson`)

Outputs to `data/processed/`:
  1. `buildings.parquet`       (~10.5 MB) — 1 row per building (with EPSG:4326 geometry,
                               DPE breakdown, ownership concentration, summer overheating
                               indicators + ICU spatial join, rent control ceilings,
                               copropriété/social housing/QPV/patrimoine flags)
  2. `building_owners.parquet` (~1.1 MB)  — 1 row per (building, corporate owner) for
                               instant owner search, SIREN lookup & detailed Excel export
"""

import json
import time
import zipfile
from pathlib import Path

import duckdb
import geopandas as gpd
import numpy as np
import pandas as pd
from shapely import Point, wkt

ROOT_DIR = Path(__file__).resolve().parent.parent
ZIP_PATH = ROOT_DIR / "data" / "bdnb_2025_07_a_dep69" / "open_data_millesime_2025-07-a_dep69_csv.zip"
EXTRACT_DIR = ROOT_DIR / "data" / "bdnb_2025_07_a_dep69" / "extracted_csv"
GRANDLYON_DIR = ROOT_DIR / "data" / "grandlyon"
OUT_DIR = ROOT_DIR / "data" / "processed"

# Default target scope: Lyon (1er-9e) + Villeurbanne
TARGET_COMMUNES = (
    "69381", "69382", "69383", "69384", "69385",
    "69386", "69387", "69388", "69389", "69266",
)
TARGET_POSTAL_CODES = (
    "69001", "69002", "69003", "69004", "69005",
    "69006", "69007", "69008", "69009", "69100",
)

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
]


def extract_needed_csvs() -> None:
    """Extract only the needed CSV tables from the BDNB zip if not already extracted."""
    EXTRACT_DIR.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(ZIP_PATH, "r") as z:
        for member in NEEDED_CSVS:
            target_file = EXTRACT_DIR / Path(member).name
            if not target_file.exists():
                print(f"  -> Extracting {member} ...")
                with z.open(member) as src, open(target_file, "wb") as dst:
                    dst.write(src.read())


def enrich_with_grandlyon_spatial_layers(gdf_4326: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    """
    Spatially join Grand Lyon Urban Heat Islands (ICU / LCZ) and Rent Control (Encadrement des loyers)
    onto buildings using their centroids.
    """
    pts = gpd.GeoDataFrame(
        {"batiment_groupe_id": gdf_4326["batiment_groupe_id"].values},
        geometry=[Point(xy) for xy in zip(gdf_4326["lon"], gdf_4326["lat"])],
        crs="EPSG:4326",
    )

    # 1. Urban Heat Islands (ICU / LCZ)
    icu_path = GRANDLYON_DIR / "ilots_chaleur_urbains.geojson"
    if icu_path.exists():
        print("  -> Spatially joining Grand Lyon Urban Heat Islands (ICU / LCZ)...")
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

    # 2. Rent Control Zones (Encadrement des loyers 2025-2026)
    loyers_path = GRANDLYON_DIR / "encadrement_loyers.geojson"
    if loyers_path.exists():
        print("  -> Spatially joining Grand Lyon Rent Control Zones (Encadrement des loyers 2025-2026)...")
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

    return gdf_4326


def compute_overheating_metrics(df: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    """
    Compute a transparent, explainable Summer Overheating Vulnerability Score (0-100)
    combining building envelope defects (BDNB/DPE) AND Urban Heat Island exposure (Grand Lyon ICU).
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

    # 8. Urban Heat Island (ICU Grand Lyon — Daytime & Nighttime exposure, up to +20 pts)
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
    # Assign score if we have either building envelope/DPE info OR high ICU exposure
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

    df["score_surchauffe_ete"] = pd.Series(final_scores, dtype="Int64")
    df["risque_surchauffe_ete"] = risk_labels
    df["facteurs_surchauffe"] = [
        " • ".join(f) if f else "Aucun facteur majeur identifié"
        for f in factors_list
    ]
    return df


def main() -> None:
    t0 = time.time()
    print("1. Checking extracted BDNB CSV tables...")
    extract_needed_csvs()
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    print("2. Running DuckDB join & aggregation across 16 BDNB tables...")
    con = duckdb.connect(database=":memory:")

    csv_dir = str(EXTRACT_DIR)
    communes_sql = ", ".join(f"'{c}'" for c in TARGET_COMMUNES)
    cp_sql = ", ".join(f"'{c}'" for c in TARGET_POSTAL_CODES)

    # Create filtered base buildings table for Lyon + Villeurbanne
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
        WHERE code_commune_insee IN ({communes_sql})
    """)

    # Addresses
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
        WHERE a.code_postal IN ({cp_sql})
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

    # Corporate Owners table (1 row per building x corporate owner)
    con.execute(f"""
        CREATE TABLE building_owners AS
        SELECT
            r.batiment_groupe_id,
            r.personne_id,
            p.siren,
            COALESCE(NULLIF(TRIM(p.forme_juridique), ''), 'personne_physique') AS forme_juridique,
            TRIM(p.denomination) AS denomination,
            TRIM(p.code_postal) AS code_postal_proprietaire,
            TRIM(p.libelle_commune) AS libelle_commune_proprietaire,
            TRY_CAST(r.nb_locaux_open AS INTEGER) AS nb_locaux_open_dans_batiment,
            TRY_CAST(p.nb_locaux_open AS INTEGER) AS nb_locaux_open_dans_MAJIC
        FROM read_csv_auto('{csv_dir}/rel_batiment_groupe_proprietaire.csv', delim=';', header=true, all_varchar=true) r
        INNER JOIN bg_adr ba ON r.batiment_groupe_id = ba.batiment_groupe_id
        LEFT JOIN read_csv_auto('{csv_dir}/proprietaire.csv', delim=';', header=true, all_varchar=true) p
            ON r.personne_id = p.personne_id
    """)

    # Deduplicate per (batiment_groupe_id, personne_id) for concentration calculation
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

    # Join all building-level tables together
    con.execute(f"""
        CREATE TABLE buildings_joined AS
        SELECT
            b.batiment_groupe_id,
            b.geom_groupe,
            b.code_commune_insee,
            b.libelle_commune_insee,
            b.code_iris,
            b.surface_emprise_sol_m2,
            ba.adr,
            ba.cp,
            ba.nb_adresses,
            -- FFO (Fichiers Fonciers)
            TRY_CAST(ffo.nb_log AS INTEGER) AS nb_log,
            TRY_CAST(ffo.nb_niveau AS INTEGER) AS nb_niveau,
            TRY_CAST(ffo.annee_construction AS INTEGER) AS annee_construction,
            ffo.usage_niveau_1_txt,
            ffo.mat_mur_txt,
            ffo.mat_toit_txt,
            -- Synthese propriete usage
            syn.usage_principal_bdnb_open,
            -- Representative DPE & Summer Overheating / Envelope columns
            UPPER(NULLIF(TRIM(dpe.classe_bilan_dpe), '')) AS dpe,
            UPPER(NULLIF(TRIM(dpe.classe_emission_ges), '')) AS classe_ges,
            TRY_CAST(dpe.conso_5_usages_ep_m2 AS DOUBLE) AS conso_ep_m2,
            dpe.type_dpe,
            dpe.type_batiment_dpe,
            dpe.periode_construction_dpe,
            dpe.type_installation_chauffage,
            dpe.type_energie_chauffage,
            dpe.type_generateur_chauffage,
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
            -- Statistical DPE counts
            TRY_CAST(stat.nb_classe_bilan_dpe_a AS INTEGER) AS nb_dpe_a,
            TRY_CAST(stat.nb_classe_bilan_dpe_b AS INTEGER) AS nb_dpe_b,
            TRY_CAST(stat.nb_classe_bilan_dpe_c AS INTEGER) AS nb_dpe_c,
            TRY_CAST(stat.nb_classe_bilan_dpe_d AS INTEGER) AS nb_dpe_d,
            TRY_CAST(stat.nb_classe_bilan_dpe_e AS INTEGER) AS nb_dpe_e,
            TRY_CAST(stat.nb_classe_bilan_dpe_f AS INTEGER) AS nb_dpe_f,
            TRY_CAST(stat.nb_classe_bilan_dpe_g AS INTEGER) AS nb_dpe_g,
            -- Ownership aggregation
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
            -- Copropriete (RNIC)
            rnc.numero_immat_principal AS immat_copro,
            rnc.l_nom_copro AS nom_copro,
            rnc.l_siret AS siret_copro,
            TRY_CAST(rnc.nb_lot_tot AS INTEGER) AS nb_lots_copro,
            -- Social Housing (RPLS)
            CASE WHEN rpls.batiment_groupe_id IS NOT NULL THEN TRUE ELSE FALSE END AS est_logement_social_rpls,
            TRY_CAST(rpls.nb_log AS INTEGER) AS nb_log_sociaux_rpls,
            rpls.classe_ener_principale AS dpe_principal_rpls,
            -- Priority Neighborhood (QPV)
            qpv.nom_quartier AS quartier_qpv,
            -- Height (BDTOPO)
            TRY_CAST(topo.hauteur_mean AS DOUBLE) AS hauteur_moyenne_m,
            -- Urbanisme / Heritage protection (PLU / ABF)
            urb.zone_plu_bati_patrimonial,
            urb.contrainte_urbanisme_ac1,
            urb.monument_historique,
            -- Climate Risks (Clay / Radon)
            risq.alea_argile,
            risq.alea_radon
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
    """)

    df_buildings = con.execute("SELECT * FROM buildings_joined").df()
    df_owners = con.execute("SELECT * FROM building_owners").df()
    print(f"   Joined {len(df_buildings):,} buildings and {len(df_owners):,} building-owner links in {time.time() - t0:.1f}s")

    # Compute DPE percentages (matching legacy fields + clean numeric columns)
    print("3. Computing DPE shares & ownership concentration...")
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

    # Passoires F+G combined share
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

    # Normalize formes_juridiques list (if building has no corporate owner rows, it is ["personne_physique"])
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

    # Concentration prop max (only when nb_log >= 1, matching legacy script)
    conc_num = np.where(
        valid_log & df_buildings["concentration_prop_max_num"].notna(),
        df_buildings["concentration_prop_max_num"],
        np.nan,
    )
    df_buildings["concentration_prop_max_pct"] = np.round(conc_num * 100.0, 1)
    df_buildings["concentration_prop_max"] = [
        str(v) if pd.notna(v) else "NC" for v in conc_num
    ]

    # Convert WKT EPSG:2154 geometry to EPSG:4326 and compute centroids
    print("4. Reprojecting building geometries (EPSG:2154 -> EPSG:4326) and computing centroids...")
    geoms_2154 = [wkt.loads(g) if isinstance(g, str) and g else None for g in df_buildings["geom_groupe"]]
    gdf = gpd.GeoDataFrame(
        df_buildings.drop(columns=["geom_groupe", "formes_juridiques_list", "denominations_list"]),
        geometry=geoms_2154,
        crs="EPSG:2154",
    )
    gdf_4326 = gdf.to_crs(epsg=4326)

    centroids_4326 = gdf.geometry.centroid.to_crs(epsg=4326)
    gdf_4326["lon"] = np.round(centroids_4326.x, 6)
    gdf_4326["lat"] = np.round(centroids_4326.y, 6)

    # Spatially join Grand Lyon ICU + Rent Control
    print("5. Enriching with Grand Lyon Urban Heat Islands (ICU) & Rent Control zones...")
    gdf_4326 = enrich_with_grandlyon_spatial_layers(gdf_4326)

    # Compute Summer Overheating score & factors (combining BDNB envelope + Grand Lyon ICU)
    print("6. Computing composite Summer Overheating Vulnerability Scores...")
    gdf_4326 = compute_overheating_metrics(gdf_4326)

    # Save GeoParquet & Owners Parquet
    buildings_parquet_path = OUT_DIR / "buildings.parquet"
    owners_parquet_path = OUT_DIR / "building_owners.parquet"

    print("7. Writing compressed Parquet files...")
    gdf_4326.to_parquet(buildings_parquet_path, compression="zstd", index=False)
    df_owners.to_parquet(owners_parquet_path, compression="zstd", index=False)

    b_size_mb = buildings_parquet_path.stat().st_size / (1024 * 1024)
    o_size_mb = owners_parquet_path.stat().st_size / (1024 * 1024)
    print(f"Done in {time.time() - t0:.1f}s!")
    print(f"  -> {buildings_parquet_path}: {b_size_mb:.2f} MB ({len(gdf_4326):,} buildings)")
    print(f"  -> {owners_parquet_path}: {o_size_mb:.2f} MB ({len(df_owners):,} owner links)")
    print(f"  -> Total size: {b_size_mb + o_size_mb:.2f} MB (down from 472.0 MB in legacy GPKGs = {100 * (1 - (b_size_mb + o_size_mb) / 472.0):.1f}% reduction!)")


if __name__ == "__main__":
    main()
