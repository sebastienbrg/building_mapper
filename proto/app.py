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
import ipaddress
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


def enforce_local_network_only() -> None:
    """Reject any request that does not originate directly from localhost or RFC1918 private LAN."""
    headers = getattr(st.context, "headers", None) or {}
    # Block reverse-proxy / tunnel forwarding headers (ngrok, Cloudflare Tunnel, etc.)
    for hdr in ("X-Forwarded-For", "X-Real-Ip", "Forwarded", "CF-Connecting-IP"):
        val = headers.get(hdr) or headers.get(hdr.lower())
        if val:
            first_hop = val.split(",")[0].strip()
            try:
                ip_obj = ipaddress.ip_address(first_hop)
                if not (ip_obj.is_loopback or ip_obj.is_private):
                    st.error("🔒 Accès refusé : cette application est strictement limitée au réseau local (LAN).")
                    st.stop()
            except ValueError:
                st.error("🔒 Accès refusé : en-tête de transfert externe non autorisé.")
                st.stop()

    client_ip = getattr(st.context, "ip_address", None)
    if client_ip:
        try:
            ip_obj = ipaddress.ip_address(str(client_ip).strip())
            if not (ip_obj.is_loopback or ip_obj.is_private):
                st.error(f"🔒 Accès refusé ({client_ip}) : réservé au réseau local (192.168.x.x / localhost).")
                st.stop()
        except ValueError:
            st.error("🔒 Accès refusé : adresse IP non reconnue.")
            st.stop()


enforce_local_network_only()

# Compact full-bleed layout CSS: maximize map width & height, zero tab jump, clean sidebar spacing
st.markdown(
    """
    <style>
        header[data-testid="stHeader"] {
            background: transparent !important;
            height: 1.2rem !important;
            min-height: 1.2rem !important;
        }
        [data-testid="stAppDeployButton"] {
            display: none !important;
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
        /* Geographical data sources hierarchy & non-technical tooltip tags */
        .tz-tag-legend {
            background: #f8fafc;
            border: 1px solid #cbd5e1;
            border-radius: 6px;
            padding: 0.45rem 0.75rem;
            margin-bottom: 0.65rem;
            font-size: 0.79rem;
            color: #334155;
            display: flex;
            flex-wrap: wrap;
            align-items: center;
            gap: 0.4rem 0.55rem;
        }
        .tz-tag {
            position: relative;
            display: inline-flex;
            align-items: center;
            gap: 0.25rem;
            padding: 0.16rem 0.52rem;
            border-radius: 999px;
            font-size: 0.73rem;
            font-weight: 600;
            cursor: help;
            border: 1px solid transparent;
            white-space: nowrap;
        }
        .tz-tag-etl { background: #ede9fe; color: #5b21b6; border-color: #c4b5fd; }
        .tz-tag-parquet { background: #dbeafe; color: #1e40af; border-color: #93c5fd; }
        .tz-tag-csv { background: #e0f2fe; color: #0369a1; border-color: #7dd3fc; }
        .tz-tag-wfs { background: #fce7f3; color: #9d174d; border-color: #f9a8d4; }
        .tz-tag-api { background: #dcfce7; color: #166534; border-color: #86efac; }
        .tz-tag-xlsx { background: #fef3c7; color: #92400e; border-color: #fcd34d; }
        .tz-tag::after {
            content: attr(data-tooltip);
            position: absolute;
            left: 0;
            top: calc(100% + 6px);
            width: 310px;
            white-space: normal;
            background: #0f172a;
            color: #f8fafc;
            font-size: 0.75rem;
            font-weight: 400;
            line-height: 1.38;
            padding: 0.5rem 0.65rem;
            border-radius: 6px;
            box-shadow: 0 10px 25px rgba(15, 23, 42, 0.28);
            opacity: 0;
            visibility: hidden;
            pointer-events: none;
            transition: opacity 0.14s ease;
            z-index: 9999;
        }
        .tz-tag:hover::after {
            opacity: 1;
            visibility: visible;
        }
        details.tz-geo-section {
            border: 1px solid #cbd5e1;
            border-radius: 8px;
            background: #ffffff;
            margin-bottom: 0.75rem;
            overflow: visible;
        }
        details.tz-geo-section > summary {
            list-style: none;
            cursor: pointer;
            padding: 0.55rem 0.85rem;
            font-size: 0.92rem;
            font-weight: 700;
            display: flex;
            align-items: center;
            justify-content: space-between;
            border-radius: 7px;
            user-select: none;
        }
        details.tz-geo-section > summary::-webkit-details-marker {
            display: none;
        }
        details.tz-geo-france > summary {
            background: #eff6ff;
            color: #1e3a8a;
            border-left: 5px solid #2563eb;
        }
        details.tz-geo-rhone > summary {
            background: #ecfdf5;
            color: #064e3b;
            border-left: 5px solid #059669;
        }
        details.tz-geo-lyon {
            margin: 0.65rem 0 0.2rem 1.25rem;
            border: 2px solid #f59e0b;
            border-left: 6px solid #d97706;
            border-radius: 8px;
            background: #fffbeb;
        }
        details.tz-geo-lyon > summary {
            background: #fef3c7;
            color: #78350f;
            padding: 0.5rem 0.85rem;
            font-size: 0.89rem;
        }
        .tz-geo-body {
            padding: 0.65rem 0.85rem 0.75rem 0.85rem;
            border-top: 1px solid #e2e8f0;
        }
        .tz-src-grid {
            display: grid;
            grid-template-columns: repeat(2, 1fr);
            gap: 0.5rem;
        }
        .tz-src-grid-3 {
            display: grid;
            grid-template-columns: repeat(3, 1fr);
            gap: 0.5rem;
        }
        .tz-src-card {
            background: #f8fafc;
            border: 1px solid #e2e8f0;
            border-radius: 6px;
            padding: 0.5rem 0.68rem;
            font-size: 0.79rem;
            color: #1e293b;
        }
        .tz-src-card-title {
            font-weight: 700;
            font-size: 0.84rem;
            color: #0f172a;
            margin-bottom: 0.22rem;
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 0.4rem;
        }
        .tz-src-tags {
            display: flex;
            flex-wrap: wrap;
            gap: 0.28rem;
            margin-bottom: 0.32rem;
        }
        .tz-src-meta {
            font-size: 0.75rem;
            color: #475569;
            line-height: 1.35;
            margin: 0.12rem 0;
        }
        .tz-src-meta code {
            font-size: 0.72rem;
            background: #e2e8f0;
            padding: 1px 4px;
            border-radius: 3px;
            color: #0f172a;
        }
        .tz-geo-hint {
            font-size: 0.76rem;
            font-weight: 500;
            color: #475569;
            background: rgba(255,255,255,0.75);
            padding: 0.12rem 0.5rem;
            border-radius: 999px;
            border: 1px solid rgba(148,163,184,0.4);
        }
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
def load_buildings(_mtime: float) -> gpd.GeoDataFrame:
    gdf = gpd.read_parquet(BUILDINGS_PARQUET)
    return gdf


@st.cache_data(show_spinner="Chargement de la table des propriétaires (Parquet)...")
def load_owners(_mtime: float) -> pd.DataFrame:
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
gdf_base = load_buildings(BUILDINGS_PARQUET.stat().st_mtime)
df_owners = load_owners(OWNERS_PARQUET.stat().st_mtime)

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
        dept_choice = st.selectbox(
            "Département / Territoire",
            [
                "69 — Rhône (Lyon & Villeurbanne)",
                "38 — Isère (Grenoble & Métropole)",
                "Tous (69 + 38)",
            ],
            index=0,
        )
        if dept_choice.startswith("69"):
            active_depts = ["69"]
            default_cps = [69001, 69007]
        elif dept_choice.startswith("38"):
            active_depts = ["38"]
            default_cps = [38000, 38100]
        else:
            active_depts = ["69", "38"]
            default_cps = [69001, 69007, 38000, 38100]

        dept_sub_cps = sorted(
            gdf_base[gdf_base["departement"].isin(active_depts)]["cp"]
            .dropna()
            .unique()
            .astype(int)
            .tolist()
        )
        default_cps = [c for c in default_cps if c in dept_sub_cps]
        sel_cps = st.multiselect(
            "Code postal (OU)",
            options=dept_sub_cps,
            default=default_cps,
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
mask = gdf_work["departement"].isin(active_depts)

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
total_dept_bats = int(gdf_work["departement"].isin(active_depts).sum())
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
            <div class="tz-kpi-pill">🏢 <b>{fmt_int(total_bats)}</b>/{fmt_int(total_dept_bats)} bât.</div>
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
tab_map, tab_table, tab_landlords, tab_export, tab_sources, tab_potential = st.tabs(
    [
        "🗺️ Carte",
        "📊 Bâtiments",
        "🔍 Bailleurs & SCI",
        "📦 Export ZIP",
        "📚 Sources de données",
        "🔭 Pistes de données",
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
        else f" (sur {fmt_int(total_dept_bats)} bât. dans le territoire sélectionné)"
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
    TAG_DEFS = {
        "etl": (
            "tz-tag-etl",
            "⚙️ Fabriquer les archives de données (Build ETL)",
            "Étape de préparation (script proto/build_dataset.py) qui télécharge les gros fichiers bruts officiels, les nettoie, les relie entre eux et fabrique nos fichiers locaux prêts à l'emploi en 5 secondes.",
        ),
        "parquet": (
            "tz-tag-parquet",
            "🗄️ Fichier de données local (GeoParquet)",
            "Base de données ultra-compacte enregistrée dans un simple fichier sur l'ordinateur (buildings.parquet, 10 Mo). Remplace un serveur lourd (Postgres) et affiche les 32 378 bâtiments instantanément.",
        ),
        "csv": (
            "tz-tag-csv",
            "📦 Archive de tables brutes (CSV Open Data)",
            "Grosse archive publique (505 Mo) publiée deux fois par an par l'État (CSTB), contenant 16 grands tableaux bruts avant leur nettoyage et recoupement.",
        ),
        "wfs": (
            "tz-tag-wfs",
            "🗺️ Carte croisée par GPS (WFS / Jointure spatiale)",
            "Carte publique téléchargée sur Data Grand Lyon. Notre outil repère automatiquement dans quelle zone (îlot de chaleur ou zone de loyers) se situe chaque immeuble grâce à ses coordonnées GPS.",
        ),
        "api": (
            "tz-tag-api",
            "⚡ Interrogation en direct sur Internet (API REST)",
            "Demande envoyée en temps réel aux serveurs officiels de l'État (data.gouv.fr) au moment où vous cliquez sur un bailleur, sans stocker les millions d'entreprises françaises sur l'ordinateur.",
        ),
        "xlsx": (
            "tz-tag-xlsx",
            "📋 Tableur militant fusionné (.xlsx)",
            "Votre propre fichier Excel de suivi terrain importé dans la barre latérale. Ses colonnes sont rattachées automatiquement aux immeubles grâce à l'identifiant batiment_groupe_id.",
        ),
    }

    def tag_html(*keys: str) -> str:
        out = []
        for k in keys:
            cls, label, tip = TAG_DEFS[k]
            out.append(f'<span class="tz-tag {cls}" data-tooltip="{tip}" title="{tip}">{label} ℹ️</span>')
        return "".join(out)

    sources_html = f"""
<div class="tz-tag-legend">
    <b>🏷️ Étiquettes du mode de récupération</b> <span style="color:#64748b;">(survolez une étiquette avec la souris pour lire l'explication non-technique) :</span>
    {tag_html("etl", "parquet", "csv", "wfs", "api", "xlsx")}
</div>

<!-- 1. INDEPENDENT FRANCE-WIDE SECTION -->
<details class="tz-geo-section tz-geo-france" open>
    <summary>
        <span>🇫🇷 Échelle Nationale — France entière <span style="font-weight:400;font-size:0.82rem;">(Section indépendante : sources nationales sans découpage départemental)</span></span>
        <span class="tz-geo-hint">2 sources nationales ▼</span>
    </summary>
    <div class="tz-geo-body">
        <div class="tz-src-grid">
            <div class="tz-src-card">
                <div class="tz-src-card-title">
                    <span>🔍 Annuaire & Dirigeants d'Entreprises / SCI (RNE & INSEE Sirene)</span>
                </div>
                <div class="tz-src-tags">{tag_html("api")}</div>
                <div class="tz-src-meta"><b>Producteur :</b> DINUM / INSEE / INPI (<code>data.gouv.fr</code> — couverture France entière)</div>
                <div class="tz-src-meta"><b>Où on la récupère :</b> <code>GET https://recherche-entreprises.api.gouv.fr/search?q={{SIREN}}</code></div>
                <div class="tz-src-meta"><b>Champs extraits :</b> <code>nom_complet</code>, <code>siren</code>, <code>siege.adresse</code>, <code>libelle_activite_principale</code>, <code>dirigeants</code> (<code>nom</code>, <code>prenoms</code>, <code>annee_de_naissance</code>, <code>qualite</code>)</div>
                <div class="tz-src-meta"><b>Pourquoi à l'échelle France :</b> Une SCI ou foncière qui possède un immeuble à Lyon a souvent son siège social à Paris ou ailleurs en France. L'interrogation nationale en direct lève l'anonymat des gérants partout en France.</div>
            </div>
            <div class="tz-src-card">
                <div class="tz-src-card-title">
                    <span>🏛️ Grands Référentiels Nationaux Amont (IGN, ADEME, DGFiP, ANAH, ANCT)</span>
                </div>
                <div class="tz-src-tags">{tag_html("csv", "etl")}</div>
                <div class="tz-src-meta"><b>Producteurs nationaux :</b> IGN (BD TOPO), ADEME (Observatoire DPE), DGFiP (Fichiers Fonciers & MAJIC), BAN (Adresses), ANAH (RNIC Copropriétés), Ministère du Logement (RPLS), ANCT (Quartiers QPV).</div>
                <div class="tz-src-meta"><b>Où on les récupère :</b> Consolidés à l'échelle nationale par le <b>CSTB</b> dans la <b>Base de Données Nationale des Bâtiments (BDNB)</b>, puis téléchargés sous forme d'archive départementale (voir <b>Département du Rhône 69</b> ci-dessous).</div>
            </div>
        </div>
    </div>
</details>

<!-- 2. DEPARTMENTAL SECTION: RHONE (69) WITH NESTED LYON SUBSECTION -->
<details class="tz-geo-section tz-geo-rhone" open>
    <summary>
        <span>🗺️ Département du Rhône (69) <span style="font-weight:400;font-size:0.82rem;">(Sources départementales + sous-section imbriquée Ville de Lyon)</span></span>
        <span class="tz-geo-hint">6 tables départementales + 1 sous-section locale ▼</span>
    </summary>
    <div class="tz-geo-body">
        <div style="margin-bottom:0.4rem;font-size:0.79rem;color:#064e3b;">
            <b>📦 A. Sources à l'échelle de tout le Département du Rhône (69)</b> — Archive <code>open_data_millesime_2025-07-a_dep69_csv.zip</code> (CSTB BDNB, 505 Mo) compilée dans <code>buildings.parquet</code> (10,3 Mo) et <code>building_owners.parquet</code> (1,1 Mo) :
        </div>
        <div class="tz-src-grid-3">
            <div class="tz-src-card">
                <div class="tz-src-card-title">🏢 1. Bâtiments & Emprises GPS (69)</div>
                <div class="tz-src-tags">{tag_html("csv", "etl", "parquet")}</div>
                <div class="tz-src-meta"><b>Tables :</b> <code>batiment_groupe.csv</code> + <code>_bdtopo_bat.csv</code> (IGN)</div>
                <div class="tz-src-meta"><b>Champs :</b> <code>batiment_groupe_id</code>, <code>geom_groupe</code>, <code>s_geom_groupe</code>, <code>hauteur_mean</code></div>
                <div class="tz-src-meta"><b>Usage :</b> Polygones sur la carte et identifiant pivot unique.</div>
            </div>
            <div class="tz-src-card">
                <div class="tz-src-card-title">🏛️ 2. Propriétaires & Patrimoine 69 (MAJIC)</div>
                <div class="tz-src-tags">{tag_html("csv", "etl", "parquet")}</div>
                <div class="tz-src-meta"><b>Tables :</b> <code>rel_batiment_groupe_proprietaire.csv</code> + <code>proprietaire.csv</code></div>
                <div class="tz-src-meta"><b>Champs :</b> <code>siren</code>, <code>denomination</code>, <code>forme_juridique</code>, <code>nb_locaux_open_dans_MAJIC</code></div>
                <div class="tz-src-meta"><b>Intérêt 69 :</b> Mesure le patrimoine total du bailleur sur <b>tout le Rhône</b> (même hors Lyon).</div>
            </div>
            <div class="tz-src-card">
                <div class="tz-src-card-title">🌡️ 3. DPE Hiver & Enveloppe Été (ADEME 69)</div>
                <div class="tz-src-tags">{tag_html("csv", "etl", "parquet")}</div>
                <div class="tz-src-meta"><b>Tables :</b> <code>_dpe_representatif_logement.csv</code> + <code>_statistique_logement.csv</code></div>
                <div class="tz-src-meta"><b>Champs :</b> <code>classe_bilan_dpe</code> (A–G), <code>type_isolation_plancher_haut</code>, <code>type_fermeture</code> (volets), <code>classe_inertie</code></div>
                <div class="tz-src-meta"><b>Usage :</b> Passoires F/G + Score de Surchauffe d'Été (/100).</div>
            </div>
            <div class="tz-src-card">
                <div class="tz-src-card-title">🚪 4. Logements & Époque (FFO 69)</div>
                <div class="tz-src-tags">{tag_html("csv", "etl", "parquet")}</div>
                <div class="tz-src-meta"><b>Table :</b> <code>batiment_groupe_ffo_bat.csv</code> (DGFiP Fichiers Fonciers)</div>
                <div class="tz-src-meta"><b>Champs :</b> <code>nb_log</code>, <code>nb_niveau</code>, <code>annee_construction</code>, <code>mat_mur_txt</code>, <code>mat_toit_txt</code></div>
                <div class="tz-src-meta"><b>Usage :</b> Taille d'immeuble et époque pour le calcul du loyer plafond.</div>
            </div>
            <div class="tz-src-card">
                <div class="tz-src-card-title">📍 5. Adresses Postales (BAN 69)</div>
                <div class="tz-src-tags">{tag_html("csv", "etl", "parquet")}</div>
                <div class="tz-src-meta"><b>Tables :</b> <code>rel_batiment_groupe_adresse.csv</code> + <code>adresse.csv</code></div>
                <div class="tz-src-meta"><b>Champs :</b> <code>adr</code> (numéro + voie), <code>cp</code> (code postal), <code>nb_adresses</code></div>
                <div class="tz-src-meta"><b>Usage :</b> Recherche par rue et filtre par code postal.</div>
            </div>
            <div class="tz-src-card">
                <div class="tz-src-card-title">⚖️ 6. Copros, Parc Social, QPV & PLU (69)</div>
                <div class="tz-src-tags">{tag_html("csv", "etl", "parquet")}</div>
                <div class="tz-src-meta"><b>Tables :</b> <code>_rnc.csv</code> (ANAH), <code>_rpls.csv</code>, <code>_qpv.csv</code> (ANCT), <code>_urbanisme.csv</code></div>
                <div class="tz-src-meta"><b>Champs :</b> <code>nom_copro</code>, <code>est_logement_social_rpls</code>, <code>quartier_qpv</code>, <code>monument_historique</code></div>
                <div class="tz-src-meta"><b>Usage :</b> Filtres QPV, parc social vs privé et contraintes ABF/PLU.</div>
            </div>
        </div>
        <details class="tz-geo-section tz-geo-lyon">
            <summary>
                <span>↳ 🦁 B. Sous-section imbriquée : Lyon (& Villeurbanne — 69001 à 69009, 69100) <span style="font-weight:400;font-size:0.81rem;">— Cliquer pour déplier les sources spécifiques à Lyon</span></span>
                <span class="tz-geo-hint">3 sources locales spécifiques ▼</span>
            </summary>
            <div class="tz-geo-body" style="background:#fffdf5;">
                <div class="tz-src-grid-3">
                    <div class="tz-src-card" style="border-left:3px solid #d97706;">
                        <div class="tz-src-card-title">☀️ 1. Îlots de Chaleur Urbains (ICU / LCZ)</div>
                        <div class="tz-src-tags">{tag_html("wfs", "etl", "parquet")}</div>
                        <div class="tz-src-meta"><b>Producteur :</b> Métropole de Lyon (<b>Data Grand Lyon</b>)</div>
                        <div class="tz-src-meta"><b>Source :</b> WFS <code>metropole-de-lyon:ilots-de-chaleur-urbains</code> &rarr; <code>ilots_chaleur_urbains.geojson</code> (29 657 zones)</div>
                        <div class="tz-src-meta"><b>Champs :</b> <code>icu_lcz_lib</code>, <code>icu_expo_jour</code>, <code>icu_expo_nuit</code>, <code>icu_vulnerabilite_nuit</code></div>
                        <div class="tz-src-meta"><b>Usage à Lyon :</b> Croisement GPS par rue ; ajoute jusqu'à +15 pts au Score Surchauffe la nuit.</div>
                    </div>
                    <div class="tz-src-card" style="border-left:3px solid #d97706;">
                        <div class="tz-src-card-title">💶 2. Encadrement des Loyers (2025-2026)</div>
                        <div class="tz-src-tags">{tag_html("wfs", "etl", "parquet")}</div>
                        <div class="tz-src-meta"><b>Producteur :</b> Préfecture / Métropole (<b>Data Grand Lyon</b>)</div>
                        <div class="tz-src-meta"><b>Source :</b> WFS <code>car_care.carencadrmtloyer_2025_2026</code> &rarr; <code>encadrement_loyers.geojson</code> (233 IRIS)</div>
                        <div class="tz-src-meta"><b>Champs :</b> <code>zone_encadrement_loyers</code> (1–4), <code>loyer_max_t2_non_meuble_m2</code>, <code>loyer_max_t2_meuble_m2</code></div>
                        <div class="tz-src-meta"><b>Spécifique Lyon :</b> Seules Lyon (1er–9e) & Villeurbanne ont l'encadrement légal des loyers dans le 69.</div>
                    </div>
                    <div class="tz-src-card" style="border-left:3px solid #d97706;">
                        <div class="tz-src-card-title">📋 3. Périmètre & Relevés Militants (.xlsx)</div>
                        <div class="tz-src-tags">{tag_html("xlsx", "parquet")}</div>
                        <div class="tz-src-meta"><b>Producteur :</b> Association / Collectif <b>TeZeLoMa</b></div>
                        <div class="tz-src-meta"><b>Fichiers :</b> Filtrage INSEE <code>69381..69389</code> & <code>69266</code> (32 378 bât.) + <code>fieldwork_saved.parquet</code></div>
                        <div class="tz-src-meta"><b>Champs :</b> Toutes les colonnes personnalisées de votre tableur <code>.xlsx</code> (clé <code>batiment_groupe_id</code>)</div>
                        <div class="tz-src-meta"><b>Usage :</b> Fusion terrain en direct, filtres dédiés et export combiné.</div>
                    </div>
                </div>
            </div>
        </details>
    </div>
</details>

<!-- 3. DEPARTMENTAL SECTION: ISERE (38) WITH NESTED GRENOBLE SUBSECTION -->
<details class="tz-geo-section tz-geo-rhone" open>
    <summary>
        <span>⛰️ Département de l'Isère (38) <span style="font-weight:400;font-size:0.82rem;">(Sources départementales 38 + sous-section imbriquée Ville de Grenoble)</span></span>
        <span class="tz-geo-hint">6 tables départementales + 1 sous-section locale ▼</span>
    </summary>
    <div class="tz-geo-body">
        <div style="margin-bottom:0.4rem;font-size:0.79rem;color:#064e3b;">
            <b>📦 A. Sources à l'échelle du Département de l'Isère (38)</b> — Archive <code>open_data_millesime_2025-07-a_dep38_csv.zip</code> (CSTB BDNB, 611 Mo, SHA-256 vérifié) compilée dans <code>buildings.parquet</code> (31 610 bâtiments) et <code>building_owners.parquet</code> (23 183 liens propriétaires personnes morales) :
        </div>
        <div class="tz-src-grid-3">
            <div class="tz-src-card">
                <div class="tz-src-card-title">🏢 1. Bâtiments & Emprises GPS (38)</div>
                <div class="tz-src-tags">{tag_html("csv", "etl", "parquet")}</div>
                <div class="tz-src-meta"><b>Tables BDNB 38 :</b> <code>batiment_groupe.csv</code> + <code>_bdtopo_bat.csv</code> (IGN)</div>
                <div class="tz-src-meta"><b>Champs :</b> <code>batiment_groupe_id</code>, <code>geom_groupe</code>, <code>hauteur_mean</code></div>
            </div>
            <div class="tz-src-card">
                <div class="tz-src-card-title">🏛️ 2. Propriétaires & Patrimoine 38 (MAJIC)</div>
                <div class="tz-src-tags">{tag_html("csv", "etl", "parquet")}</div>
                <div class="tz-src-meta"><b>Tables BDNB 38 :</b> <code>rel_batiment_groupe_proprietaire.csv</code> + <code>proprietaire.csv</code></div>
                <div class="tz-src-meta"><b>Intérêt 38 :</b> Compte le patrimoine total du bailleur sur <b>toute l'Isère (38)</b> (<code>nb_locaux_open_dans_MAJIC</code>).</div>
            </div>
            <div class="tz-src-card">
                <div class="tz-src-card-title">🌡️ 3. DPE Hiver & Enveloppe Été (ADEME 38)</div>
                <div class="tz-src-tags">{tag_html("csv", "etl", "parquet")}</div>
                <div class="tz-src-meta"><b>Tables BDNB 38 :</b> <code>_dpe_representatif_logement.csv</code> + <code>_statistique_logement.csv</code></div>
                <div class="tz-src-meta"><b>Champs :</b> DPE A–G, isolation toiture/murs, volets (<code>type_fermeture</code>), inertie, traversant.</div>
            </div>
        </div>
        <details class="tz-geo-section tz-geo-lyon" open>
            <summary>
                <span>↳ 🏔️ B. Sous-section imbriquée : Grenoble (& Métropole — 38000, 38100, 38400, 38130...) <span style="font-weight:400;font-size:0.81rem;">— Sources spécifiques à Grenoble</span></span>
                <span class="tz-geo-hint">3 sources locales spécifiques ▼</span>
            </summary>
            <div class="tz-geo-body" style="background:#fffdf5;">
                <div class="tz-src-grid-3">
                    <div class="tz-src-card" style="border-left:3px solid #d97706;">
                        <div class="tz-src-card-title">☀️ 1. Zones Climatiques Locales & ICU (Cerema Grenoble)</div>
                        <div class="tz-src-tags">{tag_html("wfs", "etl", "parquet")}</div>
                        <div class="tz-src-meta"><b>Producteur :</b> <b>Cerema</b> (<code>data.gouv.fr</code> — <code>lcz-spot-2022-grenoble.zip</code>)</div>
                        <div class="tz-src-meta"><b>Fichier :</b> <code>data/grenoble/LCZ_SPOT_2022_Grenoble.shp</code> (93 Mo)</div>
                        <div class="tz-src-meta"><b>Champs :</b> <code>lcz</code> (types urbains 1–10 et végétalisés A–G), <code>ver</code> (% végétation), <code>bur</code> (% bâti) &rarr; convertis en <code>icu_expo_nuit</code> / <code>icu_expo_jour</code>.</div>
                        <div class="tz-src-meta"><b>Usage à Grenoble :</b> Cible les quartiers en cuvette à forte minéralisation nocturne.</div>
                    </div>
                    <div class="tz-src-card" style="border-left:3px solid #d97706;">
                        <div class="tz-src-card-title">💶 2. Zonage & Loyers de Référence Grenoble (L3800)</div>
                        <div class="tz-src-tags">{tag_html("wfs", "etl", "parquet")}</div>
                        <div class="tz-src-meta"><b>Producteur :</b> Observatoire des Loyers / Préfecture 38 (<code>Base_OP_2024_L3800.zip</code>)</div>
                        <div class="tz-src-meta"><b>Fichiers :</b> <code>L3800_zone_cal_2024_1.kml</code> (Zones 1 à 6) + <code>Base_OP_2024_L3800.csv</code></div>
                        <div class="tz-src-meta"><b>Champs :</b> <code>zone_encadrement_loyers</code> (Zones 1–3 Grenoble, Zones 4–6 Métropole), <code>loyer_ref_t2_non_meuble_m2</code>, <code>loyer_max_t2_non_meuble_m2</code> (+20%).</div>
                    </div>
                    <div class="tz-src-card" style="border-left:3px solid #d97706;">
                        <div class="tz-src-card-title">📋 3. Périmètre Grenoble & Métropole (31 610 bât.)</div>
                        <div class="tz-src-tags">{tag_html("xlsx", "parquet")}</div>
                        <div class="tz-src-meta"><b>Communes :</b> Grenoble (<code>38000</code>, <code>38100</code> — 7 349 bât. / 102 399 log.) + 12 communes de la Métropole (Saint-Martin-d'Hères, Échirolles, Fontaine, Meylan, Saint-Égrève...).</div>
                        <div class="tz-src-meta"><b>Usage :</b> Sélectionnez <code>38 — Isère (Grenoble & Métropole)</code> dans le filtre n°1 à gauche !</div>
                    </div>
                </div>
            </div>
        </details>
    </div>
</details>
"""
    clean_sources_html = "\n".join(line.strip() for line in sources_html.splitlines() if line.strip())
    st.markdown(clean_sources_html, unsafe_allow_html=True)


with tab_potential:
    potential_html = f"""
<div class="tz-tag-legend">
    <b>🔭 Explorer & étendre TeZeLoMa</b> <span style="color:#64748b;">— 1) Départements & villes où l'outil est réplicable tel quel • 2) Nouveaux jeux de données à croiser pour les enquêtes militantes :</span>
</div>

<!-- SECTION 1: DEPARTEMENTS & CITIES WITH SIMILAR DATASETS -->
<details class="tz-geo-section tz-geo-france" open>
    <summary>
        <span>🗺️ 1. Départements & Villes disposant de jeux de données similaires <span style="font-weight:400;font-size:0.82rem;">(Où répliquer TeZeLoMa en France ?)</span></span>
        <span class="tz-geo-hint">Socle 100% France + 7 métropoles complètes ▼</span>
    </summary>
    <div class="tz-geo-body">
        <div style="margin-bottom:0.5rem;font-size:0.8rem;color:#1e3a8a;background:#eff6ff;padding:0.45rem 0.7rem;border-radius:6px;border:1px solid #bfdbfe;">
            💡 <b>Bonne nouvelle : 85 % des données de TeZeLoMa existent déjà pour les 96 départements métropolitains !</b> L'archive CSTB BDNB (<code>open_data_millesime_2025-07-a_depXX_csv.zip</code> : DPE, isolation, volets, propriétaires personnes morales MAJIC, copropriétés, QPV) et l'API Recherche d'Entreprises ont exactement la même structure partout en France. Seules les couches <b>Encadrement des loyers</b> et <b>Îlots de chaleur (ICU)</b> dépendent des portails locaux :
        </div>
        <div class="tz-src-grid-3">
            <div class="tz-src-card" style="border-left:3px solid #059669;">
                <div class="tz-src-card-title">🦁 1. Reste de la Métropole de Lyon (69)</div>
                <div class="tz-src-tags">{tag_html("csv", "wfs", "parquet")}</div>
                <div class="tz-src-meta"><b>Communes :</b> Vénissieux (<code>69200</code>), Vaulx-en-Velin (<code>69120</code>), Bron (<code>69500</code>), Saint-Priest (<code>69800</code>), Caluire (<code>69300</code>), Oullins (<code>69600</code>)...</div>
                <div class="tz-src-meta"><b>Déjà téléchargé :</b> Présent dans notre archive <code>dep69_csv.zip</code> ET couvert par notre fichier <code>ilots_chaleur_urbains.geojson</code> (Grand Lyon) !</div>
                <div class="tz-src-meta"><b>Effort :</b> <b>Immédiat (0 téléchargement)</b> — il suffit d'ajouter leurs codes INSEE dans <code>proto/build_dataset.py</code>.</div>
            </div>
            <div class="tz-src-card" style="border-left:3px solid #059669;background:#f0fdf4;">
                <div class="tz-src-card-title">⛰️ 2. Grenoble-Alpes Métropole — Isère (38) ✅ ACTIF</div>
                <div class="tz-src-tags">{tag_html("csv", "wfs", "parquet")}</div>
                <div class="tz-src-meta"><b>Statut :</b> <b>✅ Intégré dans ce prototype (31 610 bâtiments / 23 183 liens bailleurs) !</b></div>
                <div class="tz-src-meta"><b>Données actives :</b> BDNB <code>dep38_csv.zip</code> + LCZ Cerema <code>LCZ_SPOT_2022_Grenoble.shp</code> + Zonage loyers <code>L3800_zone_cal_2024_1.kml</code>.</div>
                <div class="tz-src-meta"><b>Comment l'utiliser :</b> Choisissez <b>38 — Isère (Grenoble & Métropole)</b> dans le panneau de gauche.</div>
            </div>
            <div class="tz-src-card" style="border-left:3px solid #2563eb;">
                <div class="tz-src-card-title">🗼 3. Paris (75) & Seine-Saint-Denis (93)</div>
                <div class="tz-src-tags">{tag_html("csv", "wfs")}</div>
                <div class="tz-src-meta"><b>BDNB Dépt. 75 / 93 :</b> <code>dep75_csv.zip</code>, <code>dep93_csv.zip</code> (Plaine Commune & Est Ensemble)</div>
                <div class="tz-src-meta"><b>Encadrement des loyers :</b> Open Data DRIHL / <code>opendata.paris.fr</code> (zones et loyers de référence).</div>
                <div class="tz-src-meta"><b>Îlots de chaleur :</b> <b>APUR</b> & <b>Institut Paris Région</b> (LCZ + aléa surchauffe diurne/nocturne en Open Data).</div>
            </div>
            <div class="tz-src-card" style="border-left:3px solid #2563eb;">
                <div class="tz-src-card-title">🧱 4. Lille & Métropole Européenne (59 — Nord)</div>
                <div class="tz-src-tags">{tag_html("csv", "wfs")}</div>
                <div class="tz-src-meta"><b>BDNB Dépt. 59 :</b> <code>open_data_millesime_2025-07-a_dep59_csv.zip</code> (Lille, Hellemmes, Lomme, Roubaix, Tourcoing)</div>
                <div class="tz-src-meta"><b>Encadrement des loyers :</b> Open Data <code>opendata.lillemetropole.fr</code> (zonage officiel MEL).</div>
                <div class="tz-src-meta"><b>Îlots de chaleur :</b> Carte LCZ & îlots de chaleur de la MEL en Open Data WFS/GeoJSON.</div>
            </div>
            <div class="tz-src-card" style="border-left:3px solid #2563eb;">
                <div class="tz-src-card-title">🍷 5. Bordeaux Métropole (33) & Montpellier (34)</div>
                <div class="tz-src-tags">{tag_html("csv", "wfs")}</div>
                <div class="tz-src-meta"><b>BDNB Dépt. 33 & 34 :</b> <code>dep33_csv.zip</code> (Gironde) & <code>dep34_csv.zip</code> (Hérault)</div>
                <div class="tz-src-meta"><b>Encadrement des loyers :</b> Portails <code>opendata.bordeaux-metropole.fr</code> et <code>data.montpellier3m.fr</code>.</div>
                <div class="tz-src-meta"><b>Îlots de chaleur :</b> Thermographie aérienne & cartes LCZ publiées par Bordeaux Métropole (a'urba) et Montpellier 3M.</div>
            </div>
            <div class="tz-src-card" style="border-left:3px solid #2563eb;">
                <div class="tz-src-card-title">🌊 6. Pays Basque (64) & Autres grandes villes (13, 31, 42, 44, 67)</div>
                <div class="tz-src-tags">{tag_html("csv", "wfs")}</div>
                <div class="tz-src-meta"><b>Pays Basque (64) :</b> Encadrement des loyers actif depuis <b>novembre 2024</b> (24 communes : Bayonne, Biarritz, Anglet...).</div>
                <div class="tz-src-meta"><b>Marseille (13), Saint-Étienne (42), Toulouse (31), Nantes (44), Strasbourg (67) :</b> BDNB complète + <b>Cartographie nationale LCZ du Cerema</b> (<code>data.cerema.fr</code>, couvrant 85 aires urbaines françaises !).</div>
            </div>
        </div>
    </div>
</details>

<!-- SECTION 2: OTHER TYPES OF DATASETS WORTH LOOKING AT -->
<details class="tz-geo-section tz-geo-rhone" open>
    <summary>
        <span>💡 2. Autres types de jeux de données à croiser <span style="font-weight:400;font-size:0.82rem;">(Nouvelles pistes pour renforcer les enquêtes sur les passoires & les bailleurs)</span></span>
        <span class="tz-geo-hint">6 pistes d'enrichissement à fort impact ▼</span>
    </summary>
    <div class="tz-geo-body">
        <div class="tz-src-grid-3">
            <div class="tz-src-card" style="border-top:3px solid #dc2626;">
                <div class="tz-src-card-title">🏖️ 1. Meublés Touristiques (Airbnb) & Fuite des Passoires G</div>
                <div class="tz-src-tags">{tag_html("csv", "wfs")}</div>
                <div class="tz-src-meta"><b>Sources :</b> <b>InsideAirbnb Lyon</b> (<code>insideairbnb.com/get-the-data</code>) + Registre des numéros d'enregistrement meublés de tourisme (Ville de Lyon).</div>
                <div class="tz-src-meta"><b>Pourquoi c'est stratégique :</b> Depuis l'interdiction de louer les DPE G (janvier 2025), de nombreux multipropriétaires basculent leurs passoires en Airbnb pour contourner la loi. Le croisement GPS + bailleur permet de les démasquer.</div>
            </div>
            <div class="tz-src-card" style="border-top:3px solid #d97706;">
                <div class="tz-src-card-title">🏚️ 2. Logements Vacants Longue Durée (Base LOVAC) & Péril</div>
                <div class="tz-src-tags">{tag_html("csv", "etl")}</div>
                <div class="tz-src-meta"><b>Sources :</b> Base <b>LOVAC</b> (DGFiP / Cerema sur <code>data.gouv.fr</code>) + Arrêtés de mise en sécurité / insalubrité (Ville de Lyon, Métropole & ARS).</div>
                <div class="tz-src-meta"><b>Pourquoi c'est stratégique :</b> Repérer les immeubles où une SCI laisse délibérément des logements vides depuis plus de 2 ans (rétention spéculative) ou cumule passoires thermiques et arrêtés de péril.</div>
            </div>
            <div class="tz-src-card" style="border-top:3px solid #7c3aed;">
                <div class="tz-src-card-title">💶 3. Prix d'Achat & Spéculation Immobilière (DVF / DVF+)</div>
                <div class="tz-src-tags">{tag_html("csv", "parquet")}</div>
                <div class="tz-src-meta"><b>Sources :</b> <b>Demandes de Valeurs Foncières (DVF Etalab / DGFiP)</b> — <code>app.dvf.etalab.gouv.fr</code> (toutes les ventes immobilières depuis 2014).</div>
                <div class="tz-src-meta"><b>Pourquoi c'est stratégique :</b> Savoir exactement <b>quand et à quel prix</b> une SCI ou un marchand de biens a racheté un immeuble entier de passoires F/G, et détecter les opérations d'achat-revente à la découpe.</div>
            </div>
            <div class="tz-src-card" style="border-top:3px solid #0284c7;">
                <div class="tz-src-card-title">🔊 4. Bruit Nocturne & Pollution de l'Air (Double peine d'été)</div>
                <div class="tz-src-tags">{tag_html("wfs", "parquet")}</div>
                <div class="tz-src-meta"><b>Sources :</b> <b>Cartes de Bruit Stratégiques (CBS)</b> sur <b>Data Grand Lyon</b> (niveau sonore nocturne <code>Ln</code> en dB) + <b>Atmo Auvergne-Rhône-Alpes</b> (NO2, PM2.5).</div>
                <div class="tz-src-meta"><b>Pourquoi c'est stratégique :</b> En été, le seul moyen de rafraîchir un logement la nuit est d'ouvrir les fenêtres. Si l'immeuble donne sur un axe très bruyant la nuit (> 65 dB), ouvrir les fenêtres est impossible : le logement devient un piège thermique absolu.</div>
            </div>
            <div class="tz-src-card" style="border-top:3px solid #059669;">
                <div class="tz-src-card-title">🌳 5. Canopée Fine, Refuges Climatiques & Carroyage Social INSEE</div>
                <div class="tz-src-tags">{tag_html("wfs", "csv")}</div>
                <div class="tz-src-meta"><b>Sources :</b> Couches <code>arbres-alignement</code>, <code>parcs-jardins</code> & <code>lieux-frais</code> (<b>Data Grand Lyon</b>) + <b>INSEE Filosofi</b> (carreaux de 200 m × 200 m).</div>
                <div class="tz-src-meta"><b>Pourquoi c'est stratégique :</b> Croiser les immeubles en surchauffe critique avec le taux de pauvreté, la part des personnes âgées isolées (> 75 ans) et l'éloignement aux îlots de fraîcheur pour cibler le porte-à-porte.</div>
            </div>
            <div class="tz-src-card" style="border-top:3px solid #4f46e5;">
                <div class="tz-src-card-title">🕵️ 6. Bénéficiaires Effectifs (Holdings) & Aides ANAH perçues</div>
                <div class="tz-src-tags">{tag_html("api", "csv")}</div>
                <div class="tz-src-meta"><b>Sources :</b> <b>Registre des Bénéficiaires Effectifs (INPI RBE / Pappers API)</b> + Open Data <b>ANAH / Éco-rénovons Lyon</b> (subventions de travaux).</div>
                <div class="tz-src-meta"><b>Pourquoi c'est stratégique :</b> Remonter les montages de sociétés écrans (SCI détenue par une holding SAS) jusqu'aux actionnaires physiques réels, et vérifier si un bailleur a touché des aides publiques sans rénover.</div>
            </div>
        </div>
    </div>
</details>
"""
    clean_potential_html = "\n".join(line.strip() for line in potential_html.splitlines() if line.strip())
    st.markdown(clean_potential_html, unsafe_allow_html=True)
