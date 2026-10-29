#!/usr/bin/env python3
"""
TeZeLoMa / TeZeLoPa — Prototype v2 ("Rebirth")
==============================================
Zero-Postgres, Zero-Dropbox cartographic & investigative tool for identifying
thermally maladapted buildings (winter energy poverty + summer overheating)
and analyzing landlord concentration in Lyon & Villeurbanne.

Run with:
    .venv/bin/streamlit run proto/app.py
"""

from io import BytesIO
from pathlib import Path
import zipfile

import folium
import geopandas as gpd
import numpy as np
import pandas as pd
import requests
import streamlit as st
from streamlit_folium import st_folium

ROOT_DIR = Path(__file__).resolve().parent.parent
PROCESSED_DIR = ROOT_DIR / "data" / "processed"
BUILDINGS_PARQUET = PROCESSED_DIR / "buildings.parquet"
OWNERS_PARQUET = PROCESSED_DIR / "building_owners.parquet"
SAVED_FIELDWORK_PATH = PROCESSED_DIR / "fieldwork_saved.parquet"

st.set_page_config(
    page_title="TeZeLoMa — Cartographie & Enquête Bailleurs",
    page_icon="🏠",
    layout="wide",
    initial_sidebar_state="expanded",
)

# Compact full-bleed layout CSS: maximize map width & height, zero tab jump, clean sidebar spacing
st.markdown(
    """
    <style>
        header[data-testid="stHeader"] {
            background: transparent !important;
            height: 1.2rem !important;
            min-height: 1.2rem !important;
        }
        .block-container {
            padding-top: 0.45rem !important;
            padding-bottom: 0rem !important;
            padding-left: 0.5rem !important;
            padding-right: 0.5rem !important;
            max-width: 100% !important;
        }
        /* Clean, non-overlapping compact sidebar with all-collapsible categories */
        [data-testid="stSidebarHeader"] {
            height: 1.4rem !important;
            min-height: 1.4rem !important;
            padding: 0.15rem 0.5rem !important;
            margin-bottom: 0 !important;
        }
        [data-testid="stSidebarUserContent"] {
            padding-top: 0.25rem !important;
            padding-bottom: 0.4rem !important;
            padding-left: 0.65rem !important;
            padding-right: 0.65rem !important;
        }
        section[data-testid="stSidebar"] [data-testid="stVerticalBlock"] {
            gap: 0.35rem !important;
        }
        section[data-testid="stSidebar"] [data-testid="stWidgetLabel"] {
            min-height: 1.15rem !important;
            margin-bottom: 0.1rem !important;
        }
        section[data-testid="stSidebar"] label p {
            font-size: 0.76rem !important;
            line-height: 1.2 !important;
            margin: 0 !important;
        }
        section[data-testid="stSidebar"] [data-testid="stExpander"] {
            border-radius: 6px !important;
        }
        section[data-testid="stSidebar"] [data-testid="stExpander"] summary {
            padding: 0.32rem 0.55rem !important;
            font-size: 0.8rem !important;
            font-weight: 600 !important;
            background: #eef4f1 !important;
            border-radius: 5px !important;
        }
        section[data-testid="stSidebar"] [data-testid="stExpanderDetails"] {
            padding: 0.4rem 0.55rem 0.45rem 0.55rem !important;
        }
        /* Single-line top bar that never wraps into a tall block */
        .tz-header-bar {
            display: flex;
            flex-wrap: nowrap;
            align-items: center;
            justify-content: space-between;
            gap: 0.4rem;
            padding: 0.22rem 0.6rem;
            background: #1b4332;
            color: #ffffff;
            border-radius: 5px;
            margin-bottom: 0.15rem;
            overflow-x: auto;
        }
        .tz-topbar-title {
            font-size: 0.86rem;
            font-weight: 700;
            letter-spacing: -0.01em;
            margin: 0;
            white-space: nowrap;
        }
        .tz-kpi-strip {
            display: flex;
            flex-wrap: nowrap;
            gap: 0.25rem;
            margin: 0;
        }
        .tz-kpi-pill {
            background: rgba(255, 255, 255, 0.14);
            border: 1px solid rgba(255, 255, 255, 0.24);
            border-radius: 4px;
            padding: 0.08rem 0.38rem;
            font-size: 0.72rem;
            color: #f9fafb;
            display: inline-flex;
            align-items: center;
            gap: 0.2rem;
            white-space: nowrap;
        }
        .tz-kpi-pill b {
            font-size: 0.77rem;
            color: #ffffff;
        }
        /* Keep tab bar compact and lock panel height to fill 100% of remaining viewport */
        div[data-baseweb="tab-list"] {
            gap: 0.25rem !important;
            min-height: 1.8rem !important;
        }
        button[data-baseweb="tab"] {
            padding: 0.15rem 0.6rem !important;
            font-size: 0.82rem !important;
        }
        div[data-baseweb="tab-panel"] {
            padding-top: 0.15rem !important;
            height: calc(100vh - 86px) !important;
            min-height: calc(100vh - 86px) !important;
            max-height: calc(100vh - 86px) !important;
            overflow-y: auto !important;
            overflow-x: hidden !important;
        }
        /* Force both the Streamlit component wrapper AND the Folium iframe to fill 100% of the tab panel */
        div[data-baseweb="tab-panel"] [data-testid="stElementContainer"]:has(iframe),
        div[data-baseweb="tab-panel"] [data-testid="stCustomComponentV1"],
        iframe[title="streamlit_folium.st_folium"] {
            width: 100% !important;
            height: calc(100vh - 92px) !important;
            min-height: calc(100vh - 92px) !important;
            max-height: calc(100vh - 92px) !important;
            border-radius: 5px;
            display: block;
            margin: 0 !important;
        }
        /* Prominent search input & counts header inside the Buildings tab */
        .tz-table-header {
            display: flex;
            flex-wrap: nowrap;
            align-items: center;
            justify-content: space-between;
            gap: 0.5rem;
            background: #f1f5f9;
            border: 1px solid #cbd5e1;
            border-left: 4px solid #1b4332;
            border-radius: 6px;
            padding: 0.3rem 0.65rem;
            margin-bottom: 0.25rem;
            font-size: 0.8rem;
            color: #1e293b;
            overflow-x: auto;
            white-space: nowrap;
        }
        .tz-table-counts {
            display: flex;
            flex-wrap: nowrap;
            gap: 0.35rem;
            align-items: center;
        }
        .tz-count-badge {
            background: #ffffff;
            border: 1px solid #cbd5e1;
            border-radius: 4px;
            padding: 0.1rem 0.45rem;
            font-size: 0.76rem;
            color: #334155;
            white-space: nowrap;
        }
        .tz-count-badge b {
            color: #0f172a;
            font-size: 0.82rem;
        }
        /* Make the buildings table search input larger and more prominent */
        div[data-testid="stTextInput"] input[aria-label="🔎 Rechercher dans le tableau des bâtiments"] {
            font-size: 0.95rem !important;
            padding: 0.48rem 0.85rem !important;
            border: 2px solid #2d6a4f !important;
            border-radius: 6px !important;
            background-color: #ffffff !important;
        }
        /* Make the buildings table fill the exact remaining vertical space */
        div[data-testid="stElementContainer"]:has(.tz-table-header) + div[data-testid="stElementContainer"] [data-testid="stDataFrame"],
        div[data-testid="stElementContainer"]:has(.tz-table-header) + div[data-testid="stElementContainer"] [data-testid="stDataFrameResizable"] {
            height: calc(100vh - 216px) !important;
            min-height: calc(100vh - 216px) !important;
            max-height: calc(100vh - 216px) !important;
        }
        /* Data sources architecture cards */
        .tz-arch-grid {
            display: grid;
            grid-template-columns: repeat(3, 1fr);
            gap: 0.75rem;
            margin-bottom: 0.75rem;
        }
        .tz-arch-card {
            background: #f8fafc;
            border: 1px solid #e2e8f0;
            border-top: 3px solid #1b4332;
            border-radius: 6px;
            padding: 0.65rem 0.8rem;
            font-size: 0.82rem;
        }
        .tz-arch-card h4 {
            margin: 0 0 0.35rem 0;
            font-size: 0.9rem;
            color: #1b4332;
        }
        .tz-badge {
            display: inline-block;
            padding: 1px 6px;
            border-radius: 4px;
            font-size: 0.72rem;
            font-weight: 600;
            background: #e2e8f0;
            color: #1e293b;
            margin-right: 4px;
        }
        .tz-badge-live { background: #dcfce7; color: #166534; }
        .tz-badge-static { background: #dbeafe; color: #1e40af; }
        .tz-badge-field { background: #fef3c7; color: #92400e; }
    </style>
    """,
    unsafe_allow_html=True,
)

DPE_COLORS = {
    "A": "#009c6d",
    "B": "#52b153",
    "C": "#7fd460",
    "D": "#f6e934",
    "E": "#f0b51d",
    "F": "#eb8235",
    "G": "#d7221f",
}

OVERHEAT_COLORS = {
    "Critique": "#99000d",
    "Élevé": "#ef3b2c",
    "Modéré": "#fe9929",
    "Faible": "#41ab5d",
    "Non renseigné": "#969696",
}

ICU_COLORS = {
    "fort": "#b10026",
    "moyen": "#fd8d3c",
    "faible": "#fed976",
    "effet rafraîchissant": "#2b8cbe",
}


# ---------------------------------------------------------------------------
# Cached Data Loaders & Helpers
# ---------------------------------------------------------------------------
@st.cache_data(show_spinner="Chargement de la base bâtiments optimisée (GeoParquet)...")
def load_buildings() -> gpd.GeoDataFrame:
    gdf = gpd.read_parquet(BUILDINGS_PARQUET)
    return gdf


@st.cache_data(show_spinner="Chargement de la table des propriétaires (Parquet)...")
def load_owners() -> pd.DataFrame:
    return pd.read_parquet(OWNERS_PARQUET)


@st.cache_data(ttl=3600, show_spinner=False)
def fetch_company_info_api_gouv(siren_or_query: str) -> list[dict]:
    """Query the French government's free Open Data API Recherche d'Entreprises."""
    q = str(siren_or_query).strip()
    if not q:
        return []
    url = "https://recherche-entreprises.api.gouv.fr/search"
    try:
        resp = requests.get(url, params={"q": q, "per_page": 5}, timeout=6)
        resp.raise_for_status()
        return resp.json().get("results", [])
    except Exception:
        return []


def dataframe_to_excel_bytes(df: pd.DataFrame, sheet_name: str = "Data") -> bytes:
    output = BytesIO()
    clean_df = df.copy()
    if "geometry" in clean_df.columns:
        clean_df = clean_df.drop(columns=["geometry"])
    for col in clean_df.columns:
        if clean_df[col].dtype == "object":
            clean_df[col] = clean_df[col].apply(
                lambda x: ", ".join(map(str, x)) if isinstance(x, (list, np.ndarray)) else x
            )
    with pd.ExcelWriter(output, engine="xlsxwriter") as writer:
        clean_df.to_excel(writer, index=False, sheet_name=sheet_name)
    return output.getvalue()


def build_export_zip(gdf_filtered: gpd.GeoDataFrame, owners_df: pd.DataFrame) -> bytes:
    """Create the 3-file ZIP export (Grouped Excel, Detailed Owners Excel, GeoJSON) in memory."""
    bgi_set = set(gdf_filtered["batiment_groupe_id"].astype(str))
    owners_sub = owners_df[owners_df["batiment_groupe_id"].astype(str).isin(bgi_set)].copy()

    b_context_cols = [
        "batiment_groupe_id", "adr", "cp", "nb_log", "dpe", "pct_dpe_fg",
        "score_surchauffe_ete", "risque_surchauffe_ete", "facteurs_surchauffe",
        "icu_expo_jour", "icu_expo_nuit", "loyer_max_t2_non_meuble_m2",
        "annee_construction", "type_isolation_mur_exterieur", "type_isolation_plancher_haut",
        "type_fermeture", "classe_inertie",
    ]
    b_context_cols = [c for c in b_context_cols if c in gdf_filtered.columns]
    detailed_merged = pd.merge(
        gdf_filtered[b_context_cols],
        owners_sub,
        on="batiment_groupe_id",
        how="left",
    )

    export_cols_grouped = [c for c in gdf_filtered.columns if c not in ("formes_juridiques_ivec",)]
    grouped_xlsx = dataframe_to_excel_bytes(gdf_filtered[export_cols_grouped], sheet_name="Batiments")
    detailed_xlsx = dataframe_to_excel_bytes(detailed_merged, sheet_name="Proprietaires_Detail")

    geojson_gdf = gdf_filtered[export_cols_grouped].copy()
    for col in geojson_gdf.columns:
        if col != "geometry" and geojson_gdf[col].dtype == "object":
            geojson_gdf[col] = geojson_gdf[col].apply(
                lambda x: ", ".join(map(str, x)) if isinstance(x, (list, np.ndarray)) else x
            )
    geojson_bytes = geojson_gdf.to_json().encode("utf-8")

    zip_buf = BytesIO()
    with zipfile.ZipFile(zip_buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("tableur_batiments_groupe.xlsx", grouped_xlsx)
        zf.writestr("tableur_proprietaires_detaille.xlsx", detailed_xlsx)
        zf.writestr("carte_batiments.geojson", geojson_bytes)
    zip_buf.seek(0)
    return zip_buf.getvalue()


def get_feature_color(props: dict, color_mode: str) -> str:
    if color_mode == "Étiquette DPE (A → G)":
        dpe = str(props.get("dpe") or "").upper()
        return DPE_COLORS.get(dpe, "#636363")
    if color_mode == "Risque Surchauffe d'Été":
        risk = str(props.get("risque_surchauffe_ete") or "Non renseigné")
        return OVERHEAT_COLORS.get(risk, "#969696")
    if color_mode == "Îlot de Chaleur Nocturne (ICU)":
        icu = str(props.get("icu_expo_nuit") or "").lower()
        return ICU_COLORS.get(icu, "#969696")
    if color_mode == "Concentration Propriétaire (%)":
        pct = props.get("concentration_prop_max_pct")
        try:
            val = float(pct)
            if np.isnan(val):
                return "#969696"
            if val >= 80:
                return "#7a0177"
            if val >= 50:
                return "#c51b8a"
            if val >= 25:
                return "#f768a1"
            return "#fbb4b9"
        except Exception:
            return "#969696"
    return "#2b8cbe"


# ---------------------------------------------------------------------------
# Load Base Data
# ---------------------------------------------------------------------------
gdf_base = load_buildings()
df_owners = load_owners()

# ---------------------------------------------------------------------------
# All-Collapsible Compact Sidebar
# ---------------------------------------------------------------------------
with st.sidebar:
    with st.expander("🎨 Affichage Carte & Fond", expanded=True):
        sc1, sc2 = st.columns([3, 2])
        with sc1:
            color_mode = st.selectbox(
                "Coloration",
                [
                    "Étiquette DPE (A → G)",
                    "Risque Surchauffe d'Été",
                    "Îlot de Chaleur Nocturne (ICU)",
                    "Concentration Propriétaire (%)",
                ],
            )
        with sc2:
            max_polygons = st.selectbox(
                "Limite",
                [500, 1500, 3000, 5000],
                index=1,
                help="Nombre maximum de polygones affichés sur la carte.",
            )

        if color_mode == "Étiquette DPE (A → G)":
            st.markdown(
                "<div style='font-size:0.7rem;padding-top:2px;padding-bottom:10px;display:block;'>"
                + " ".join(
                    f"<span style='background:{col};color:white;padding:2px 5px;border-radius:3px;font-weight:bold;'>{k}</span>"
                    for k, col in DPE_COLORS.items()
                )
                + "</div>",
                unsafe_allow_html=True,
            )
        elif color_mode == "Risque Surchauffe d'Été":
            st.markdown(
                "<div style='font-size:0.68rem;padding-top:2px;padding-bottom:10px;display:block;'>"
                + " ".join(
                    f"<span style='background:{col};color:white;padding:2px 4px;border-radius:3px;font-weight:bold;'>{k}</span>"
                    for k, col in OVERHEAT_COLORS.items()
                )
                + "</div>",
                unsafe_allow_html=True,
            )

        bg_dim_pct = st.slider(
            "Estomper le fond de carte (%)",
            min_value=0,
            max_value=90,
            value=55,
            step=5,
            help="Estompe et désature le fond OpenStreetMap pour faire ressortir les bâtiments colorés.",
        )

    # 1. Core Building & DPE Filters
    with st.expander("🎯 1. Localisation & DPE", expanded=True):
        all_cps = sorted(gdf_base["cp"].dropna().unique().astype(int).tolist())
        sel_cps = st.multiselect(
            "Code postal (OU)",
            options=all_cps,
            default=[69001, 69007],
        )

        dpe_options = ["A", "B", "C", "D", "E", "F", "G", "Non renseigné"]
        sel_dpes = st.multiselect(
            "DPE représentatif (OU)",
            options=dpe_options,
            default=["F", "G"],
        )

        c_d1, c_d2 = st.columns(2)
        with c_d1:
            min_nb_log = st.number_input("Logements min.", min_value=1, max_value=500, value=4, step=1)
        with c_d2:
            min_pct_fg = st.number_input("% DPE F+G min.", min_value=0, max_value=100, value=0, step=10)

    # 2. Summer Overheating & ICU
    with st.expander("☀️ 2. Surchauffe Été & ICU", expanded=False):
        c_s1, c_s2 = st.columns(2)
        with c_s1:
            sel_overheat_risk = st.multiselect(
                "Risque été",
                options=["Critique", "Élevé", "Modéré", "Faible", "Non renseigné"],
                default=[],
                placeholder="Tous",
            )
        with c_s2:
            sel_icu_nuit = st.multiselect(
                "ICU Nocturne",
                options=["fort", "moyen", "faible", "effet rafraîchissant"],
                default=[],
                placeholder="Tous",
            )

        c_s3, c_s4 = st.columns(2)
        with c_s3:
            only_uninsulated_roof = st.checkbox("Toit non isolé", value=False)
        with c_s4:
            only_no_shutters = st.checkbox("Sans volets", value=False)
        min_overheat_score = st.slider("Score surchauffe min. (0–100)", 0, 100, 0, 5)

    # 3. Landlords & Concentration
    with st.expander("🏢 3. Propriétaires & Bailleurs", expanded=False):
        owner_search_text = st.text_input(
            "Nom bailleur / SCI / SIREN",
            value="",
            placeholder="Ex: FONCIERE, SCI, 908120595...",
        ).strip()

        all_formes = sorted(
            {
                fj
                for lst in gdf_base["formes_juridiques_ivec"].dropna()
                for fj in (lst if isinstance(lst, (list, np.ndarray)) else [])
            }
        )
        c_p1, c_p2 = st.columns([2, 1])
        with c_p1:
            sel_formes = st.multiselect(
                "Forme juridique",
                options=all_formes,
                default=[],
                placeholder="Toutes (SCI, SA...)",
            )
        with c_p2:
            forme_mode = st.selectbox("Mode", ["Inclusif", "Exclusif"], index=0)

        c_p3, c_p4 = st.columns(2)
        with c_p3:
            min_conc_pct = st.number_input("Conc. bailleur %", min_value=0, max_value=100, value=0, step=10)
        with c_p4:
            min_patrimoine_majic = st.number_input("Patrimoine 69 min", min_value=0, max_value=10000, value=0, step=10)

    # 4. Collapsible Expanders for Urbanisme/Social & Fieldwork Upload
    with st.expander("⚖️ 4. Urbanisme & Social", expanded=False):
        filter_qpv = st.checkbox("En Quartier Prioritaire (QPV)", value=False)
        filter_social = st.checkbox("Uniquement parc social (RPLS)", value=False)
        filter_exclude_social = st.checkbox("Exclure parc social (cibler privé)", value=False)
        filter_hors_abf = st.checkbox("Hors périmètre patrimonial PLU / MH", value=False)

    fieldwork_df = None
    custom_cols = []
    fieldwork_mode = "Lié (toute la base + filtres)"
    custom_filter_state = {}

    with st.expander("📋 5. Terrain (.xlsx)", expanded=False):
        uploaded_xlsx = st.file_uploader(
            "Fichier `.xlsx` (`batiment_groupe_id`)",
            type=["xlsx"],
            label_visibility="collapsed",
        )
        if uploaded_xlsx is not None:
            try:
                xl = pd.ExcelFile(uploaded_xlsx)
                sheet = st.selectbox("Feuille Excel", xl.sheet_names)
                df_up = pd.read_excel(uploaded_xlsx, sheet_name=sheet)
                if "batiment_groupe_id" not in df_up.columns:
                    st.error("Colonne `batiment_groupe_id` requise.")
                else:
                    df_up["batiment_groupe_id"] = df_up["batiment_groupe_id"].astype(str).str.strip()
                    fieldwork_df = df_up.drop_duplicates(subset=["batiment_groupe_id"])
                    st.success(f"{len(fieldwork_df):,} bât. terrain chargés.")
                    if st.button("💾 Sauvegarder localement"):
                        fieldwork_df.to_parquet(SAVED_FIELDWORK_PATH, index=False)
                        st.toast("Sauvegardé dans data/processed/fieldwork_saved.parquet !")
            except Exception as exc:
                st.error(f"Erreur Excel : {exc}")
        elif SAVED_FIELDWORK_PATH.exists():
            if st.checkbox("Activer le fichier terrain sauvegardé", value=False):
                fieldwork_df = pd.read_parquet(SAVED_FIELDWORK_PATH)
                st.caption(f"{len(fieldwork_df):,} bât. terrain actifs.")

        gdf_work = gdf_base.copy()
        if fieldwork_df is not None:
            custom_cols = [c for c in fieldwork_df.columns if c not in gdf_work.columns and c != "batiment_groupe_id"]
            gdf_work = gdf_work.merge(
                fieldwork_df[["batiment_groupe_id"] + custom_cols],
                on="batiment_groupe_id",
                how="left",
            )
            fieldwork_mode = st.radio(
                "Mode terrain",
                ["Lié (toute la base + filtres)", "Restreint au fichier terrain"],
                index=1,
            )
            for c in custom_cols:
                s_col = gdf_work[c]
                if pd.api.types.is_numeric_dtype(s_col):
                    c_min = float(s_col.min()) if s_col.notna().any() else 0.0
                    c_max = float(s_col.max()) if s_col.notna().any() else 100.0
                    if c_min < c_max:
                        custom_filter_state[c] = ("range", st.slider(f"{c}", c_min, c_max, (c_min, c_max)))
                else:
                    opts = sorted(s_col.dropna().astype(str).unique().tolist())
                    if opts:
                        custom_filter_state[c] = ("multi", st.multiselect(f"{c}", opts, default=[]))
        else:
            gdf_work = gdf_base


# ---------------------------------------------------------------------------
# Apply Vectorized Filtering (Instant — < 20ms)
# ---------------------------------------------------------------------------
mask = pd.Series(True, index=gdf_work.index)

if fieldwork_df is not None and fieldwork_mode.startswith("Restreint"):
    mask &= gdf_work["batiment_groupe_id"].isin(set(fieldwork_df["batiment_groupe_id"]))

if sel_cps:
    mask &= gdf_work["cp"].isin(sel_cps)

if sel_dpes:
    want_nr = "Non renseigné" in sel_dpes
    letters = [d for d in sel_dpes if d != "Non renseigné"]
    dpe_mask = gdf_work["dpe"].isin(letters)
    if want_nr:
        dpe_mask |= gdf_work["dpe"].isna() | (gdf_work["dpe"] == "")
    mask &= dpe_mask

if min_pct_fg > 0:
    mask &= gdf_work["pct_dpe_fg"].fillna(0) >= min_pct_fg

if min_nb_log > 1:
    mask &= gdf_work["nb_log"].fillna(0) >= min_nb_log

if sel_overheat_risk:
    mask &= gdf_work["risque_surchauffe_ete"].isin(sel_overheat_risk)

if min_overheat_score > 0:
    mask &= gdf_work["score_surchauffe_ete"].fillna(0) >= min_overheat_score

if sel_icu_nuit:
    mask &= gdf_work["icu_expo_nuit"].fillna("").str.lower().isin(sel_icu_nuit)

if only_uninsulated_roof:
    mask &= gdf_work["type_isolation_plancher_haut"].fillna("").str.lower().str.contains("non isol")

if only_no_shutters:
    mask &= gdf_work["type_fermeture"].fillna("").str.lower().str.contains("sans fermeture|absence")

if sel_formes:
    sel_set = set(sel_formes)
    if forme_mode.startswith("Inclusif"):
        mask &= gdf_work["formes_juridiques_ivec"].apply(
            lambda lst: bool(sel_set.intersection(lst)) if isinstance(lst, (list, np.ndarray)) else False
        )
    else:
        mask &= gdf_work["formes_juridiques_ivec"].apply(
            lambda lst: set(lst).issubset(sel_set) and len(lst) > 0 if isinstance(lst, (list, np.ndarray)) else False
        )

if min_conc_pct > 0:
    mask &= gdf_work["concentration_prop_max_pct"].fillna(0) >= min_conc_pct

if min_patrimoine_majic > 0:
    mask &= gdf_work["max_patrimoine_majic_bailleur"].fillna(0) >= min_patrimoine_majic

if owner_search_text:
    q_up = owner_search_text.upper()
    matching_bgis = set(
        df_owners[
            df_owners["denomination"].fillna("").str.upper().str.contains(q_up, na=False)
            | df_owners["siren"].fillna("").str.contains(q_up, na=False)
        ]["batiment_groupe_id"]
    )
    mask &= gdf_work["batiment_groupe_id"].isin(matching_bgis)

if filter_qpv:
    mask &= gdf_work["quartier_qpv"].notna() & (gdf_work["quartier_qpv"] != "")

if filter_social:
    mask &= gdf_work["est_logement_social_rpls"] == True  # noqa: E712

if filter_exclude_social:
    mask &= gdf_work["est_logement_social_rpls"] == False  # noqa: E712

if filter_hors_abf:
    no_plu_pat = gdf_work["zone_plu_bati_patrimonial"].isna() | (
        gdf_work["zone_plu_bati_patrimonial"].astype(str).isin(["0", "False", "false", ""])
    )
    no_mh = gdf_work["monument_historique"].isna() | (
        gdf_work["monument_historique"].astype(str).isin(["0", "False", "false", ""])
    )
    mask &= no_plu_pat & no_mh

for col_name, (ftype, fval) in custom_filter_state.items():
    if ftype == "range":
        mask &= gdf_work[col_name].between(fval[0], fval[1])
    elif ftype == "multi" and fval:
        mask &= gdf_work[col_name].astype(str).isin(fval)

gdf_filtered = gdf_work[mask].copy()


# ---------------------------------------------------------------------------
# Compact Header & Responsive KPI Pill Strip (No Truncation)
# ---------------------------------------------------------------------------
total_bats = len(gdf_filtered)
total_logs = int(gdf_filtered["nb_log"].fillna(0).sum())
total_fg_logs = int(gdf_filtered["nb_dpe_fg"].fillna(0).sum())
crit_overheat = int((gdf_filtered["risque_surchauffe_ete"].isin(["Critique", "Élevé"])).sum())
corp_owned = int((gdf_filtered["nb_proprietaires_open"].fillna(0) > 0).sum())

fmt_int = lambda n: f"{n:,}".replace(",", " ")

st.markdown(
    f"""
    <div class="tz-header-bar">
        <span class="tz-topbar-title">🏠 TeZeLoMa</span>
        <div class="tz-kpi-strip">
            <div class="tz-kpi-pill">🏢 <b>{fmt_int(total_bats)}</b>/{fmt_int(len(gdf_work))} bât.</div>
            <div class="tz-kpi-pill">🚪 <b>{fmt_int(total_logs)}</b> log.</div>
            <div class="tz-kpi-pill">❄️ <b>{fmt_int(total_fg_logs)}</b> F/G</div>
            <div class="tz-kpi-pill">☀️ <b>{fmt_int(crit_overheat)}</b> surchauffe</div>
            <div class="tz-kpi-pill">🏛️ <b>{fmt_int(corp_owned)}</b> PM</div>
        </div>
    </div>
    """,
    unsafe_allow_html=True,
)


# ---------------------------------------------------------------------------
# Main Navigation Tabs (Short Labels + Fixed Height Panel -> Zero Layout Jump)
# ---------------------------------------------------------------------------
tab_map, tab_table, tab_landlords, tab_export, tab_sources = st.tabs(
    [
        "🗺️ Carte",
        "📊 Bâtiments",
        "🔍 Bailleurs & SCI",
        "📦 Export ZIP",
        "📚 Sources de données",
    ]
)

with tab_map:
    if total_bats == 0:
        st.warning("Aucun bâtiment ne correspond aux critères sélectionnés. Élargissez vos filtres dans le panneau de gauche.")
    else:
        gdf_map = gdf_filtered.sort_values(
            by=["score_surchauffe_ete", "nb_log"], ascending=[False, False]
        ).head(max_polygons)

        center_lat = float(gdf_map["lat"].mean()) if gdf_map["lat"].notna().any() else 45.7578
        center_lon = float(gdf_map["lon"].mean()) if gdf_map["lon"].notna().any() else 4.8320

        m = folium.Map(
            location=[center_lat, center_lon],
            zoom_start=14,
            tiles="OpenStreetMap",
            control_scale=True,
        )
        # Dim & desaturate ONLY the background map tiles (.leaflet-tile-pane) so building overlays pop
        tile_opacity = max(0.12, round(1.0 - (bg_dim_pct / 100.0) * 0.85, 2))
        tile_gray = min(100, int(bg_dim_pct * 1.2))
        m.get_root().header.add_child(
            folium.Element(
                f"""
                <style>
                    html, body {{
                        height: 100% !important;
                        margin: 0 !important;
                        padding: 0 !important;
                    }}
                    .folium-map {{
                        height: 100vh !important;
                        width: 100% !important;
                        background: #f1f5f9 !important;
                    }}
                    .leaflet-tile-pane {{
                        filter: grayscale({tile_gray}%) opacity({tile_opacity}) !important;
                    }}
                </style>
                """
            )
        )

        popup_cols = [
            "batiment_groupe_id",
            "adr",
            "cp",
            "nb_log",
            "dpe",
            "pct_dpe_fg",
            "risque_surchauffe_ete",
            "score_surchauffe_ete",
            "facteurs_surchauffe",
            "icu_expo_nuit",
            "icu_lcz_lib",
            "type_isolation_plancher_haut",
            "type_isolation_mur_exterieur",
            "type_fermeture",
            "classe_inertie",
            "concentration_prop_max_denomination",
            "siren_principal",
            "concentration_prop_max_pct",
            "max_patrimoine_majic_bailleur",
            "loyer_max_t2_non_meuble_m2",
            "loyer_max_t2_meuble_m2",
            "nom_copro",
            "quartier_qpv",
        ] + custom_cols
        popup_cols = [c for c in popup_cols if c in gdf_map.columns]

        gdf_folium = gdf_map[popup_cols + ["geometry"]].copy()
        for c in popup_cols:
            if gdf_folium[c].dtype == "object":
                gdf_folium[c] = gdf_folium[c].apply(
                    lambda x: ", ".join(map(str, x)) if isinstance(x, (list, np.ndarray)) else x
                )

        folium.GeoJson(
            gdf_folium,
            style_function=lambda feature: {
                "fillColor": get_feature_color(feature["properties"], color_mode),
                "color": get_feature_color(feature["properties"], color_mode),
                "weight": 2.2,
                "fillOpacity": 0.9,
            },
            tooltip=folium.GeoJsonTooltip(
                fields=["adr", "dpe", "nb_log", "risque_surchauffe_ete", "concentration_prop_max_denomination"],
                aliases=[
                    "Adresse :",
                    "DPE représentatif :",
                    "Nb logements :",
                    "Risque surchauffe été :",
                    "Principal propriétaire morale :",
                ],
                localize=True,
            ),
            popup=folium.GeoJsonPopup(
                fields=[
                    "batiment_groupe_id",
                    "adr",
                    "nb_log",
                    "dpe",
                    "pct_dpe_fg",
                    "risque_surchauffe_ete",
                    "score_surchauffe_ete",
                    "facteurs_surchauffe",
                    "icu_expo_nuit",
                    "type_isolation_plancher_haut",
                    "type_fermeture",
                    "concentration_prop_max_denomination",
                    "siren_principal",
                    "concentration_prop_max_pct",
                    "max_patrimoine_majic_bailleur",
                    "loyer_max_t2_non_meuble_m2",
                ],
                aliases=[
                    "ID BDNB :",
                    "Adresse :",
                    "Nb logements :",
                    "DPE :",
                    "% DPE F+G :",
                    "Risque Surchauffe Été :",
                    "Score Surchauffe (/100) :",
                    "Facteurs thermiques :",
                    "Îlot de chaleur nocturne :",
                    "Isolation toiture :",
                    "Volets / Fermetures :",
                    "Bailleur principal :",
                    "SIREN :",
                    "Concentration bailleur (%) :",
                    "Patrimoine bailleur (locaux 69) :",
                    "Plafond loyer T2 non-meublé (€/m²) :",
                ],
                localize=True,
                max_width=450,
            ),
        ).add_to(m)

        st_folium(m, use_container_width=True, height=1100, returned_objects=[])


with tab_table:
    display_cols = [
        "batiment_groupe_id",
        "adr",
        "cp",
        "nb_log",
        "dpe",
        "nb_dpe_fg",
        "pct_dpe_fg",
        "risque_surchauffe_ete",
        "score_surchauffe_ete",
        "facteurs_surchauffe",
        "icu_expo_nuit",
        "type_isolation_plancher_haut",
        "type_isolation_mur_exterieur",
        "type_fermeture",
        "classe_inertie",
        "concentration_prop_max_denomination",
        "siren_principal",
        "concentration_prop_max_pct",
        "max_patrimoine_majic_bailleur",
        "loyer_max_t2_non_meuble_m2",
        "loyer_max_t2_meuble_m2",
        "est_logement_social_rpls",
        "nom_copro",
        "quartier_qpv",
    ] + custom_cols
    display_cols = [c for c in display_cols if c in gdf_filtered.columns]

    df_table = gdf_filtered[display_cols].sort_values(
        by=["score_surchauffe_ete", "nb_dpe_fg" if "nb_dpe_fg" in display_cols else "nb_log"],
        ascending=False,
    )

    # Prominent search bar that filters or highlights rows across all displayed columns
    c_srch, c_smode = st.columns([4, 1])
    with c_srch:
        table_query = st.text_input(
            "🔎 Rechercher dans le tableau des bâtiments",
            value="",
            placeholder="🔎 Rechercher par adresse, ID BDNB, bailleur, SIREN, facteur de surchauffe, copropriété...",
            label_visibility="collapsed",
        ).strip()
    with c_smode:
        search_action = st.selectbox(
            "Mode recherche",
            ["Filtrer les lignes", "Surligner les lignes"],
            index=0,
            label_visibility="collapsed",
        )

    row_mask = pd.Series(True, index=df_table.index)
    if table_query:
        search_blob = (
            df_table.astype(object)
            .fillna("")
            .astype(str)
            .agg(" ".join, axis=1)
            .str.upper()
        )
        for token in table_query.upper().split():
            row_mask &= search_blob.str.contains(token, regex=False, na=False)

    if table_query and search_action == "Filtrer les lignes":
        df_table_shown = df_table[row_mask]
    elif table_query and search_action == "Surligner les lignes":
        # Put matching rows at the top and highlight them
        df_table_shown = pd.concat([df_table[row_mask], df_table[~row_mask]])
    else:
        df_table_shown = df_table

    df_stats_source = df_table[row_mask] if table_query else df_table
    t_bats = len(df_stats_source)
    t_logs = int(pd.to_numeric(df_stats_source["nb_log"], errors="coerce").fillna(0).sum())
    t_fg = int(pd.to_numeric(df_stats_source.get("nb_dpe_fg", 0), errors="coerce").fillna(0).sum())
    t_overheat = int(df_stats_source["risque_surchauffe_ete"].isin(["Critique", "Élevé"]).sum())
    t_pm = int((df_stats_source["concentration_prop_max_denomination"].fillna("NC") != "NC").sum())

    filter_note = (
        f" — <b>{fmt_int(int(row_mask.sum()))} / {fmt_int(len(df_table))}</b> bât. pour « <b>{table_query}</b> »"
        if table_query
        else f" (sur {fmt_int(len(gdf_work))} bât. Lyon & Villeurbanne)"
    )

    st.markdown(
        f"""
        <div class="tz-table-header">
            <span>📊 <b>Synthèse du tableau</b>{filter_note}</span>
            <div class="tz-table-counts">
                <span class="tz-count-badge">🏢 <b>{fmt_int(t_bats)}</b> bâtiments</span>
                <span class="tz-count-badge">🚪 <b>{fmt_int(t_logs)}</b> logements</span>
                <span class="tz-count-badge">❄️ <b>{fmt_int(t_fg)}</b> log. DPE F/G</span>
                <span class="tz-count-badge">☀️ <b>{fmt_int(t_overheat)}</b> surchauffe</span>
                <span class="tz-count-badge">🏛️ <b>{fmt_int(t_pm)}</b> avec bailleur PM</span>
            </div>
        </div>
        """,
        unsafe_allow_html=True,
    )

    if table_query and search_action == "Surligner les lignes":
        matched_indices = set(df_table[row_mask].index)
        styled_df = df_table_shown.style.apply(
            lambda row: [
                "background-color: #fef08a; color: #0f172a; font-weight: 600;"
                if row.name in matched_indices
                else ""
                for _ in row
            ],
            axis=1,
        )
        st.dataframe(
            styled_df,
            width="stretch",
            height=760,
            hide_index=True,
        )
    else:
        st.dataframe(
            df_table_shown,
            width="stretch",
            height=760,
            hide_index=True,
        )


with tab_landlords:
    bgi_filtered_set = set(gdf_filtered["batiment_groupe_id"])
    owners_in_filter = df_owners[
        df_owners["batiment_groupe_id"].isin(bgi_filtered_set)
        & df_owners["denomination"].notna()
        & (df_owners["denomination"] != "")
    ].copy()

    if owners_in_filter.empty:
        st.info("Aucun propriétaire personne morale dans la sélection actuelle.")
    else:
        top_owners = (
            owners_in_filter.groupby(["siren", "denomination", "forme_juridique"], dropna=False)
            .agg(
                nb_batiments_selection=("batiment_groupe_id", "nunique"),
                nb_locaux_selection=("nb_locaux_open_dans_batiment", "sum"),
                patrimoine_total_dep69=("nb_locaux_open_dans_MAJIC", "max"),
                commune_siege=("libelle_commune_proprietaire", "first"),
            )
            .reset_index()
            .sort_values(by=["nb_locaux_selection", "nb_batiments_selection"], ascending=False)
        )

        st.dataframe(top_owners.head(100), width="stretch", height=230)

        owner_options = [
            f"{row.denomination} (SIREN: {row.siren or 'N/A'} — {row.nb_batiments_selection} bât. / {row.nb_locaux_selection} locaux)"
            for _, row in top_owners.head(150).iterrows()
        ]
        col_sel, col_man = st.columns([2, 1])
        with col_sel:
            chosen_owner_label = st.selectbox("Inspecter les dirigeants d'un bailleur (API Gouv) :", options=owner_options)
        with col_man:
            manual_siren = st.text_input("Ou saisir un SIREN / nom :", value="")

        query_target = manual_siren.strip()
        selected_siren = None
        if not query_target and chosen_owner_label:
            idx = owner_options.index(chosen_owner_label)
            row_sel = top_owners.iloc[idx]
            selected_siren = str(row_sel["siren"] or "").strip()
            query_target = selected_siren if selected_siren and selected_siren != "nan" else str(row_sel["denomination"])

        if query_target:
            results = fetch_company_info_api_gouv(query_target)
            if not results:
                st.warning(f"Aucun résultat trouvé sur l'API Recherche d'Entreprises pour `{query_target}`.")
            else:
                comp = results[0]
                siren_found = comp.get("siren", "")
                nom_complet = comp.get("nom_complet", "")
                siege = comp.get("siege", {})
                adresse_siege = siege.get("adresse", "Non renseignée")
                activite = comp.get("libelle_activite_principale", comp.get("activite_principale", ""))
                dirigeants = comp.get("dirigeants", [])

                c_info1, c_info2 = st.columns([1, 1])
                with c_info1:
                    st.markdown(f"**🏛️ {nom_complet}** (`SIREN {siren_found}`)")
                    st.caption(f"📍 Siège : {adresse_siege} • Activité : {activite}")
                    st.markdown(
                        f"🔗 [Annuaire des Entreprises (data.gouv.fr)](https://annuaire-entreprises.data.gouv.fr/entreprise/{siren_found}) "
                        f"| [Pappers](https://www.pappers.fr/entreprise/{siren_found})"
                    )
                with c_info2:
                    st.markdown("**👤 Dirigeants / Gérants déclarés (RNE / INSEE) :**")
                    if not dirigeants:
                        st.caption("Aucun dirigeant listé en open data pour cette entité.")
                    else:
                        for d in dirigeants[:6]:
                            if d.get("type_dirigeant") == "personne physique":
                                prenoms = d.get("prenoms", "")
                                nom = d.get("nom", "")
                                qualite = d.get("qualite", "Dirigeant")
                                annee_naiss = d.get("annee_de_naissance", "")
                                naiss_str = f" (né·e en {annee_naiss})" if annee_naiss else ""
                                st.markdown(f"- **{prenoms} {nom}**{naiss_str} — *{qualite}*")
                            else:
                                denom_pm = d.get("denomination", "")
                                siren_pm = d.get("siren", "")
                                qualite = d.get("qualite", "Personne morale dirigeante")
                                st.markdown(f"- 🏢 **{denom_pm}** (`SIREN {siren_pm}`) — *{qualite}*")

                if siren_found:
                    all_bgi_for_siren = set(
                        df_owners[df_owners["siren"].astype(str) == str(siren_found)]["batiment_groupe_id"]
                    )
                    if all_bgi_for_siren:
                        cols_p = [
                            "batiment_groupe_id", "adr", "cp", "nb_log", "dpe", "pct_dpe_fg",
                            "risque_surchauffe_ete", "score_surchauffe_ete", "facteurs_surchauffe",
                            "loyer_max_t2_non_meuble_m2",
                        ]
                        st.dataframe(
                            gdf_base[gdf_base["batiment_groupe_id"].isin(all_bgi_for_siren)][cols_p],
                            width="stretch",
                            height=180,
                        )


with tab_export:
    st.markdown(
        f"""
        **📦 Export instantané de votre sélection ({fmt_int(total_bats)} bâtiments / {fmt_int(total_logs)} logements)**
        - `tableur_batiments_groupe.xlsx` — **1 ligne par bâtiment** (DPE, score et facteurs de surchauffe d'été, exposition Îlot de Chaleur Grand Lyon, plafond d'encadrement des loyers, concentration propriétaire, et vos colonnes de terrain).
        - `tableur_proprietaires_detaille.xlsx` — **1 ligne par couple (bâtiment × propriétaire personne morale)** avec SIREN, forme juridique, adresse du siège et nombre de locaux détenus.
        - `carte_batiments.geojson` — Couche géographique prête à être importée dans **Framacarte / uMap** ou **QGIS**.
        """
    )
    if total_bats > 0:
        if st.button("⚡ Préparer l'archive export_tezeloma.zip", type="primary"):
            with st.spinner("Génération des tableurs Excel et du GeoJSON en cours..."):
                zip_bytes = build_export_zip(gdf_filtered, df_owners)
            st.download_button(
                label=f"📥 Télécharger export_tezeloma.zip ({len(zip_bytes) / (1024*1024):.2f} Mo)",
                data=zip_bytes,
                file_name="export_tezeloma.zip",
                mime="application/zip",
            )


with tab_sources:
    st.markdown(
        """
        <div class="tz-arch-grid">
            <div class="tz-arch-card">
                <h4>1️⃣ Sources Open Data Amont (Build ETL)</h4>
                <p style="margin:0 0 6px 0;"><span class="tz-badge tz-badge-static">Archive S3 CSTB</span> <b>BDNB Millésime 2025-07-a (Dép. 69)</b><br/>
                <code>open-data.s3.fr-par.scw.cloud/.../dep69_csv.zip</code><br/>
                16 tables croisées (IGN BD TOPO, Fichiers Fonciers MAJIC, ADEME DPE, BAN, RNIC, RPLS, QPV, PLU).</p>
                <p style="margin:0;"><span class="tz-badge tz-badge-static">WFS Grand Lyon</span> <b>Data Grand Lyon (OGC WFS 2.0)</b><br/>
                <code>data.grandlyon.com/geoserver/metropole-de-lyon/ows</code><br/>
                Couches spatiales <code>ilots-de-chaleur-urbains</code> (LCZ / ICU) & <code>carencadrmtloyer_2025_2026</code>.</p>
            </div>
            <div class="tz-arch-card">
                <h4>2️⃣ Base Locale Optimisée (Static File DB)</h4>
                <p style="margin:0 0 6px 0;"><span class="tz-badge tz-badge-static">GeoParquet ZSTD</span> <b>Pipeline DuckDB (<code>proto/build_dataset.py</code>)</b><br/>
                Remplace les 350 000 requêtes Postgres + 472 Mo de GeoPackages Dropbox par 2 fichiers locaux générés en <b>5,3 s</b> :</p>
                <ul style="margin:0;padding-left:1.1rem;">
                    <li><code>data/processed/buildings.parquet</code> (<b>10,3 Mo</b> — 32 378 bâtiments, 112 colonnes + géométries EPSG:4326)</li>
                    <li><code>data/processed/building_owners.parquet</code> (<b>1,1 Mo</b> — 47 785 liens bâtiment × propriétaire morale)</li>
                </ul>
            </div>
            <div class="tz-arch-card">
                <h4>3️⃣ Enrichissement Temps Réel & Terrain</h4>
                <p style="margin:0 0 6px 0;"><span class="tz-badge tz-badge-live">API REST Live</span> <b>API Recherche d'Entreprises (data.gouv.fr)</b><br/>
                <code>https://recherche-entreprises.api.gouv.fr/search?q={SIREN}</code><br/>
                Interrogation à la volée (sans clé API) du RNE / INSEE pour identifier les gérants/dirigeants physiques des SCI.</p>
                <p style="margin:0;"><span class="tz-badge tz-badge-field">Terrain (.xlsx / Parquet)</span> <b>Données Militantes & Relevés</b><br/>
                Import <code>.xlsx</code> fusionné sur <code>batiment_groupe_id</code> + persistance locale dans <code>fieldwork_saved.parquet</code>.</p>
            </div>
        </div>
        """,
        unsafe_allow_html=True,
    )

    sources_catalog = pd.DataFrame(
        [
            {
                "Couche / Domaine": "Bâtiments & Emprises",
                "Type": "Static CSV -> GeoParquet",
                "Source / Producteur": "CSTB BDNB 2025-07-a (IGN BD TOPO)",
                "Table / Endpoint": "batiment_groupe.csv + batiment_groupe_bdtopo_bat.csv",
                "Champs clés extraits": "batiment_groupe_id, geom_groupe (EPSG:4326), code_commune_insee, s_geom_groupe, hauteur_mean",
                "Usage dans TeZeLoMa": "Polygones cartographiques, identifiant pivot unique, hauteur",
            },
            {
                "Couche / Domaine": "Adresses Postales",
                "Type": "Static CSV -> GeoParquet",
                "Source / Producteur": "CSTB BDNB 2025-07-a (BAN)",
                "Table / Endpoint": "rel_batiment_groupe_adresse.csv + adresse.csv",
                "Champs clés extraits": "adr (numéro, voie), cp (69001..69009, 69100), nb_adresses",
                "Usage dans TeZeLoMa": "Filtre par arrondissement/commune, recherche et affichage popup",
            },
            {
                "Couche / Domaine": "Logements & Structure",
                "Type": "Static CSV -> GeoParquet",
                "Source / Producteur": "CSTB BDNB 2025-07-a (DGFiP Fichiers Fonciers)",
                "Table / Endpoint": "batiment_groupe_ffo_bat.csv",
                "Champs clés extraits": "nb_log, nb_niveau, annee_construction, mat_mur_txt, mat_toit_txt",
                "Usage dans TeZeLoMa": "Taille de l'immeuble, époque de construction (pour encadrement des loyers)",
            },
            {
                "Couche / Domaine": "DPE & Enveloppe Thermique (Hiver + Été)",
                "Type": "Static CSV -> GeoParquet",
                "Source / Producteur": "CSTB BDNB 2025-07-a (ADEME DPE)",
                "Table / Endpoint": "batiment_groupe_dpe_representatif_logement.csv + dpe_statistique_logement.csv",
                "Champs clés extraits": "classe_bilan_dpe (A-G), nb_dpe_a..g, type_isolation_plancher_haut, u_plancher_haut_deperditif, type_isolation_mur_exterieur, type_fermeture (volets), classe_inertie, traversant, surface_vitree_horizontal (Velux)",
                "Usage dans TeZeLoMa": "Ciblage passoires F/G + Calcul du Score de Surchauffe d'Été (0-100)",
            },
            {
                "Couche / Domaine": "Îlots de Chaleur Urbains (ICU / LCZ)",
                "Type": "WFS GeoJSON -> Spatial Join",
                "Source / Producteur": "Métropole de Lyon (Data Grand Lyon)",
                "Table / Endpoint": "WFS metropole-de-lyon:ilots-de-chaleur-urbains (data/grandlyon/ilots_chaleur_urbains.geojson)",
                "Champs clés extraits": "icu_lcz_lib, icu_expo_jour, icu_expo_nuit, icu_vulnerabilite_jour, icu_vulnerabilite_nuit",
                "Usage dans TeZeLoMa": "Croisement spatial sur centroïde bâtiment + Bonus exposition nocturne dans Score Surchauffe",
            },
            {
                "Couche / Domaine": "Encadrement des Loyers 2025-2026",
                "Type": "WFS GeoJSON -> Spatial Join",
                "Source / Producteur": "Métropole de Lyon (Data Grand Lyon)",
                "Table / Endpoint": "WFS metropole-de-lyon:car_care.carencadrmtloyer_2025_2026 (data/grandlyon/encadrement_loyers.geojson)",
                "Champs clés extraits": "zone_encadrement_loyers (1-4), loyer_ref_t2_non_meuble_m2, loyer_max_t2_non_meuble_m2, loyer_max_t2_meuble_m2",
                "Usage dans TeZeLoMa": "Calcul automatique du loyer plafond légal (€/m²) selon zone IRIS et année de construction",
            },
            {
                "Couche / Domaine": "Propriétaires Personnes Morales (MAJIC)",
                "Type": "Static CSV -> Parquet Normalisé",
                "Source / Producteur": "CSTB BDNB 2025-07-a (DGFiP MAJIC PM)",
                "Table / Endpoint": "rel_batiment_groupe_proprietaire.csv + proprietaire.csv -> building_owners.parquet",
                "Champs clés extraits": "personne_id, siren, forme_juridique (SCI, SA...), denomination, nb_locaux_open_dans_batiment, nb_locaux_open_dans_MAJIC",
                "Usage dans TeZeLoMa": "Concentration par immeuble, multipropriétaires dans le Rhône, export détaillé",
            },
            {
                "Couche / Domaine": "Dirigeants & Gérants de SCI",
                "Type": "Live REST API (JSON)",
                "Source / Producteur": "DINUM / INSEE Sirene / INPI RNE (data.gouv.fr)",
                "Table / Endpoint": "GET https://recherche-entreprises.api.gouv.fr/search?q={SIREN}",
                "Champs clés extraits": "nom_complet, siege.adresse, dirigeants (nom, prenoms, annee_de_naissance, qualite)",
                "Usage dans TeZeLoMa": "Levée d'anonymat en direct dans l'onglet '🔍 Bailleurs & SCI'",
            },
            {
                "Couche / Domaine": "Copropriétés, Parc Social, QPV & PLU",
                "Type": "Static CSV -> GeoParquet",
                "Source / Producteur": "CSTB BDNB 2025-07-a (ANAH RNIC, RPLS, ANCT, GPU PLU)",
                "Table / Endpoint": "batiment_groupe_rnc.csv, _rpls.csv, _qpv.csv, _urbanisme.csv",
                "Champs clés extraits": "immat_copro, nom_copro, est_logement_social_rpls, quartier_qpv, zone_plu_bati_patrimonial, monument_historique",
                "Usage dans TeZeLoMa": "Filtres sociaux/QPV et vérification des contraintes patrimoniales ABF/PLU",
            },
            {
                "Couche / Domaine": "Relevés & Enquêtes de Terrain",
                "Type": "Upload Utilisateur -> Parquet Local",
                "Source / Producteur": "Association TeZeLoMa / Militant·es",
                "Table / Endpoint": "Import .xlsx (clé: batiment_groupe_id) -> data/processed/fieldwork_saved.parquet",
                "Champs clés extraits": "Toutes colonnes personnalisées du tableur importé",
                "Usage dans TeZeLoMa": "Fusion dynamique, génération automatique de filtres dédiés et export combiné",
            },
        ]
    )
    st.dataframe(sources_catalog, width="stretch", height=360, hide_index=True)
