# TeZeLoMa — Application Autonome & Cartographie d'Enquête

> **Territoires Zéro Logement Mal Adapté (TeZeLoMa / TeZeLoPa)**  
> Outil d'enquête cartographique et d'analyse foncière pour identifier les passoires thermiques (précarité énergétique hivernale), le confort d'été dégradé (surchauffe estivale / îlots de chaleur urbains) et la concentration des bailleurs personnes morales (SCI, foncières, institutionnels).

---

## 🚀 Présentation de l'Application Autonome

L'application fonctionne désormais de façon **100% autonome et côté client** (zéro serveur Python ou Streamlit à l'exécution) :
- **Web App Statique (SPA / PWA)** : hébergeable gratuitement sur GitHub Pages ou Cloudflare Pages ($0/mois).
- **Application Desktop Native (Tauri)** : exécutable autonome sans installation (portable) ou installeur standard (`.exe`, `.deb`, `.dmg`).
- **Cartographie Vectorielle fluide (MapLibre GL JS)** : rendu fluide de dizaines de milliers de bâtiments avec zoom, sélection et infobulles instantanées.
- **Décodage Parquet In-Browser (hyparquet)** : chargement à la demande par code postal ou département avec cache local (IndexedDB / Cache API).
- **Inspection SCI & Dirigeants (API data.gouv.fr)** : recherche directe des dirigeants et actionnaires en un clic.
- **Export & Fusion Terrain (SheetJS + JSZip)** : export Excel complet et fusion de relevés de terrain directement dans le navigateur.

---

## 📂 Structure du Répertoire

```
.
├── app/                      # Application TeZeLoMa autonome et outils
│   ├── static_app/           # Interface web statique (HTML, CSS, JS, vendor)
│   │   ├── index.html        # Application principale (6 onglets de navigation)
│   │   ├── app.js            # Logique réactive, filtrage et appels API
│   │   ├── style.css         # Thème moderne et ergonomie complète
│   │   ├── sw.js             # Service Worker pour fonctionnement hors-ligne
│   │   └── vendor/           # Bibliothèques embarquées (MapLibre, Hyparquet, SheetJS, JSZip)
│   ├── run_static.py         # Serveur HTTP local léger sans dépendance
│   ├── chunk_dataset.py      # Découpage du jeu de données en chunks par code postal
│   ├── build_dataset.py      # Pipeline ETL DuckDB + GeoParquet (BDNB + ICU + Loyers)
│   ├── release_data.sh       # Script de publication des données sur GitHub Releases
│   ├── requirements.txt      # Dépendances Python pour l'ETL et les tests Playwright
│   └── test_all_tabs.py      # Suite de tests Playwright couvrant tous les onglets
├── src-tauri/                # Configuration Tauri pour packaging desktop natif
├── data/                     # Données brutes, traitées et chunks par code postal
├── ASSESSMENT_AND_PLAN.md    # Analyse technique initiale et historique du projet
└── STANDALONE_ARCHITECTURE.md # Architecture détaillée de l'application autonome
```

---

## 💻 Démarrage Rapide

### 1. Lancer l'application web localement

Aucune dépendance externe n'est requise pour exécuter l'application web :

```bash
python3 app/run_static.py
```

Puis ouvrez dans votre navigateur :  
👉 **http://localhost:8080/app/static_app/index.html**

### 2. (Optionnel) Reconstruire les données et les chunks

Si vous souhaitez recalculer le jeu de données depuis les sources brutes (BDNB 2025-07-a Rhône & Isère, ICU Lyon & Grenoble, encadrement des loyers) :

```bash
# Installer les dépendances d'ETL
pip install -r app/requirements.txt

# Générer les fichiers Parquet consolidés
python3 app/build_dataset.py

# Découper par code postal pour le web
python3 app/chunk_dataset.py
```

### 3. Exécuter les tests end-to-end (Playwright)

```bash
# Vérifier que le serveur local est actif sur le port 8080
python3 app/test_all_tabs.py
```

---

## 📦 Déploiement Cloud ($0 / mois)

- **GitHub Pages** : Déploiement automatique configuré via `.github/workflows/deploy-pages.yml` lors de chaque push sur la branche `master`.
- **GitHub Releases** : Hébergement des chunks de données par code postal via `./app/release_data.sh v1.0-data`.
- **Desktop Tauri** : Compilation multiplateforme automatisée (Windows, Linux, macOS) via `.github/workflows/build-desktop.yml`.
