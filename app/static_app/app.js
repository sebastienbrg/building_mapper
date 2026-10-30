/**
 * TeZeLoMa — Standalone Web App Logic
 * ====================================
 * Zero-server, client-side investigative cartography for thermal slums,
 * summer overheating, and corporate landlord concentration.
 */

// Enable clean JSON serialization of Parquet BigInt values
if (typeof BigInt !== 'undefined') {
  BigInt.prototype.toJSON = function () {
    return Number(this);
  };
}

// Application State
const state = {
  manifest: null,
  activeTerritory: { mode: 'dep', dep: '69', cp: null, range: [69001, 69009] },
  buildings: [],        // Raw building objects from Parquet
  owners: [],           // Corporate owner records
  ownersByBuilding: new Map(), // batiment_groupe_id -> Array<Owner>
  fieldwork: new Map(), // batiment_groupe_id -> fieldwork row object
  filteredBuildings: [],// Currently active filtered subset
  mapStyleMode: 'dpe',  // 'dpe' | 'overheating' | 'concentration' | 'fieldwork'
  legalMode: 'inclusif',// 'inclusif' | 'exclusif'
  selectedDpes: new Set(['F', 'G']),
  selectedOverheating: new Set(['Critique', 'Élevé', 'Modéré', 'Faible', 'Non renseigné']),
  selectedLegal: new Set(['SCI', 'Bailleur social', 'Société commerciale', 'Personne physique']),
  minPctFg: 0,
  minConcentration: 0,
  minLog: 1,
  bgDimPct: 20,
  maxPolygons: 3000,
  onlyUninsulatedRoof: false,
  onlyNoShutters: false,
  minOverheatScore: 0,
  ownerSearchText: '',
  minPatrimoine: 0,
  filterQpv: false,
  filterSocialOnly: false,
  filterExcludeSocial: false,
  filterRentControl: false,
  map: null,
  selectedBuildingId: null,
  activeTab: 'map',
  dataBaseUrl: '../../data/chunks/', // Local default, can be switched to GitHub Releases URL
};

// DPE Color Palette
const DPE_COLORS = {
  'A': '#00994d',
  'B': '#33cc33',
  'C': '#ccff33',
  'D': '#ffff00',
  'E': '#ffcc00',
  'F': '#ff6600',
  'G': '#cc0000',
  'Inconnu': '#64748b',
};

// Overheating Color Palette
const OVERHEATING_COLORS = {
  'Critique': '#dc2626',
  'Élevé': '#ef4444',
  'Modéré': '#f59e0b',
  'Faible': '#38bdf8',
  'Non renseigné': '#64748b',
  'Inconnu': '#64748b',
};

/* ==========================================================================
   Initialization
   ========================================================================== */
document.addEventListener('DOMContentLoaded', async () => {
  if (typeof window !== 'undefined' && window.location.hostname.endsWith('github.io')) {
    const pathParts = window.location.pathname.split('/').filter(Boolean);
    const repoName = pathParts[0] || 'building_mapper';
    const ownerName = window.location.hostname.split('.')[0] || 'sebastienbrg';
    state.dataBaseUrl = `https://raw.githubusercontent.com/${ownerName}/${repoName}/data-release/data/chunks/`;
    const inputBaseUrl = document.getElementById('input-data-base-url');
    if (inputBaseUrl) inputBaseUrl.value = state.dataBaseUrl;
  }

  initMap();
  initTabs();
  initBuildingsTableControls();
  initLandlordsTabControls();
  initExportTabControls();
  initEventListeners();
  await loadManifest();
  await loadTerritory();
});

/* ==========================================================================
   MapLibre GL Initialization
   ========================================================================== */
function initMap() {
  state.map = new maplibregl.Map({
    container: 'map',
    style: {
      version: 8,
      sources: {
        'osm-tiles': {
          type: 'raster',
          tiles: [
            'https://a.tile.openstreetmap.fr/osmfr/{z}/{x}/{y}.png',
            'https://b.tile.openstreetmap.fr/osmfr/{z}/{x}/{y}.png',
            'https://c.tile.openstreetmap.fr/osmfr/{z}/{x}/{y}.png',
          ],
          tileSize: 256,
          attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a> contributors, &copy; OpenStreetMap France',
        },
      },
      layers: [
        {
          id: 'osm-tiles-layer',
          type: 'raster',
          source: 'osm-tiles',
          minzoom: 0,
          maxzoom: 20,
          paint: {
            'raster-opacity': 0.88,
            'raster-saturation': -0.2,
          },
        },
      ],
    },
    center: [4.8357, 45.7640], // Lyon default
    zoom: 13,
    maxZoom: 19,
  });

  state.map.addControl(new maplibregl.NavigationControl(), 'top-left');
  state.map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-right');

  state.map.on('load', () => {
    // Add empty GeoJSON source for buildings
    state.map.addSource('buildings-source', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
      generateId: true,
    });

    // 1. Building Fill layer (polygons)
    state.map.addLayer({
      id: 'buildings-fill',
      type: 'fill',
      source: 'buildings-source',
      paint: {
        'fill-color': ['get', 'render_color'],
        'fill-opacity': [
          'case',
          ['boolean', ['feature-state', 'hover'], false],
          0.95,
          0.75
        ],
      },
    });

    // 2. Building Stroke layer
    state.map.addLayer({
      id: 'buildings-stroke',
      type: 'line',
      source: 'buildings-source',
      paint: {
        'line-color': '#0f172a',
        'line-width': [
          'case',
          ['boolean', ['feature-state', 'hover'], false],
          2,
          0.8
        ],
        'line-opacity': 0.8,
      },
    });

    // 3. Selection Highlight outline layer
    state.map.addLayer({
      id: 'buildings-selected',
      type: 'line',
      source: 'buildings-source',
      filter: ['==', ['get', 'batiment_groupe_id'], ''],
      paint: {
        'line-color': '#38bdf8',
        'line-width': 3.5,
        'line-opacity': 1,
      },
    });

    // Hover & Click Interactions
    let hoveredId = null;
    state.map.on('mousemove', 'buildings-fill', (e) => {
      if (e.features.length > 0) {
        state.map.getCanvas().style.cursor = 'pointer';
        if (hoveredId !== null) {
          state.map.setFeatureState({ source: 'buildings-source', id: hoveredId }, { hover: false });
        }
        hoveredId = e.features[0].id;
        state.map.setFeatureState({ source: 'buildings-source', id: hoveredId }, { hover: true });
      }
    });

    state.map.on('mouseleave', 'buildings-fill', () => {
      state.map.getCanvas().style.cursor = '';
      if (hoveredId !== null) {
        state.map.setFeatureState({ source: 'buildings-source', id: hoveredId }, { hover: false });
        hoveredId = null;
      }
    });

    state.map.on('click', 'buildings-fill', (e) => {
      if (e.features.length > 0) {
        const feat = e.features[0];
        const bId = feat.properties.batiment_groupe_id;
        inspectBuilding(bId);
      }
    });

    updateLegend();
    setMapDim(state.bgDimPct);
  });
}

/* ==========================================================================
   Manifest & Territory Manager
   ========================================================================== */
async function loadManifest() {
  try {
    showLoading('Chargement du catalogue des données...');
    const res = await fetch(`${state.dataBaseUrl}manifest.json`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.manifest = await res.json();
    populatePostalCodesSelect();
    populateChunkModalTable();
  } catch (err) {
    console.error('Failed to load manifest.json:', err);
    // Attempt fallback relative path if run from different context
    try {
      const res = await fetch('manifest.json');
      state.manifest = await res.json();
      state.dataBaseUrl = './';
      populatePostalCodesSelect();
      populateChunkModalTable();
    } catch (e2) {
      alert("Impossible de charger manifest.json. Assurez-vous d'avoir exécuté app/chunk_dataset.py.");
    }
  } finally {
    hideLoading();
  }
}

function populatePostalCodesSelect() {
  const select = document.getElementById('select-cp');
  if (!select || !state.manifest) return;
  select.innerHTML = '<option value="">Sélectionner un code postal...</option>';

  const sortedChunks = [...state.manifest.chunks].sort((a, b) => a.cp - b.cp);
  for (const c of sortedChunks) {
    const opt = document.createElement('option');
    opt.value = c.cp;
    opt.textContent = `${c.cp} — ${c.communes.slice(0, 2).join(', ')} (${c.buildings_count.toLocaleString()} bât.)`;
    select.appendChild(opt);
  }
}

function populateChunkModalTable() {
  const tbody = document.getElementById('chunk-table-body');
  if (!tbody || !state.manifest) return;
  tbody.innerHTML = '';

  for (const c of state.manifest.chunks) {
    const tr = document.createElement('tr');
    const sizeKb = Math.round(c.total_size_bytes / 1024);
    tr.innerHTML = `
      <td><strong>${c.cp}</strong> (${c.departement})</td>
      <td>${c.communes.join(', ')}</td>
      <td>${c.buildings_count.toLocaleString()}</td>
      <td>${c.owners_count.toLocaleString()}</td>
      <td>${sizeKb >= 1024 ? (sizeKb / 1024).toFixed(1) + ' Mo' : sizeKb + ' Ko'}</td>
      <td><span class="status-badge status-cached">Disponible</span></td>
    `;
    tbody.appendChild(tr);
  }
}

/* ==========================================================================
   Loading Data Chunks (Parquet Reading & Caching)
   ========================================================================== */
async function fetchWithCache(filename) {
  const url = `${state.dataBaseUrl}${filename}`;
  // Use Cache API if supported
  if ('caches' in window) {
    try {
      const cache = await caches.open('tezeloma-data-v1');
      const cachedResponse = await cache.match(url);
      if (cachedResponse) {
        return await cachedResponse.arrayBuffer();
      }
      const netResponse = await fetch(url);
      if (!netResponse.ok) throw new Error(`HTTP ${netResponse.status} for ${url}`);
      cache.put(url, netResponse.clone());
      return await netResponse.arrayBuffer();
    } catch (e) {
      console.warn('Cache API error, falling back to direct fetch:', e);
    }
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return await res.arrayBuffer();
}

async function readParquetBuffer(buffer) {
  return new Promise((resolve, reject) => {
    try {
      window.hyparquet.parquetRead({
        file: buffer,
        compressors: window.hyparquet.compressors,
        rowFormat: 'object',
        onComplete: (rows) => resolve(rows),
      });
    } catch (err) {
      reject(err);
    }
  });
}

async function loadTerritory() {
  if (!state.manifest) return;
  showLoading('Téléchargement et décompression des données...');

  const mode = state.activeTerritory.mode;
  let targetChunks = [];
  let bundleFile = null;

  if (mode === 'dep') {
    const dep = state.activeTerritory.dep;
    const depMeta = state.manifest.departments[dep];
    if (depMeta) {
      bundleFile = {
        buildings: depMeta.buildings_file,
        owners: depMeta.owners_file,
        bbox: depMeta.bbox,
        center: depMeta.center,
        label: depMeta.label,
        sizeMb: (depMeta.buildings_size_bytes / 1048576).toFixed(1),
      };
    }
  } else if (mode === 'cp') {
    const cp = state.activeTerritory.cp;
    targetChunks = state.manifest.chunks.filter(c => c.cp === cp);
  } else if (mode === 'range') {
    const [start, end] = state.activeTerritory.range;
    targetChunks = state.manifest.chunks.filter(c => c.cp >= start && c.cp <= end);
  }

  try {
    let allBuildings = [];
    let allOwners = [];
    let combinedBbox = null;

    if (bundleFile) {
      // Load department bundle directly
      document.getElementById('territory-status-text').textContent = bundleFile.label;
      document.getElementById('territory-size-text').textContent = `~${bundleFile.sizeMb} Mo`;

      const [bBuf, oBuf] = await Promise.all([
        fetchWithCache(bundleFile.buildings),
        fetchWithCache(bundleFile.owners),
      ]);
      allBuildings = await readParquetBuffer(bBuf);
      allOwners = await readParquetBuffer(oBuf);
      combinedBbox = bundleFile.bbox;
    } else if (targetChunks.length > 0) {
      const totalBytes = targetChunks.reduce((acc, c) => acc + c.total_size_bytes, 0);
      const totalMb = (totalBytes / 1048576).toFixed(1);
      const cpLabels = targetChunks.map(c => c.cp).join(', ');
      document.getElementById('territory-status-text').textContent = `CP: ${cpLabels}`;
      document.getElementById('territory-size-text').textContent = `~${totalMb} Mo (${targetChunks.length} chunks)`;

      // Fetch chunks in parallel
      const promises = targetChunks.map(async (c) => {
        const [bBuf, oBuf] = await Promise.all([
          fetchWithCache(c.buildings_file),
          fetchWithCache(c.owners_file),
        ]);
        const bRows = await readParquetBuffer(bBuf);
        const oRows = await readParquetBuffer(oBuf);
        return { bRows, oRows, bbox: c.bbox };
      });

      const results = await Promise.all(promises);
      for (const res of results) {
        allBuildings.push(...res.bRows);
        allOwners.push(...res.oRows);
        if (!combinedBbox) {
          combinedBbox = [...res.bbox];
        } else {
          combinedBbox[0] = Math.min(combinedBbox[0], res.bbox[0]);
          combinedBbox[1] = Math.min(combinedBbox[1], res.bbox[1]);
          combinedBbox[2] = Math.max(combinedBbox[2], res.bbox[2]);
          combinedBbox[3] = Math.max(combinedBbox[3], res.bbox[3]);
        }
      }
    } else {
      alert("Aucun code postal trouvé pour cette sélection.");
      hideLoading();
      return;
    }

    state.buildings = allBuildings;
    state.owners = allOwners;

    // Index corporate owners by building id for instant lookup
    state.ownersByBuilding.clear();
    for (const o of allOwners) {
      const bId = o.batiment_groupe_id;
      if (!state.ownersByBuilding.has(bId)) {
        state.ownersByBuilding.set(bId, []);
      }
      state.ownersByBuilding.get(bId).push(o);
    }

    // Apply filtering & update map
    applyFilters();

    // Fly map to bbox
    if (combinedBbox && state.map) {
      state.map.fitBounds(
        [[combinedBbox[0], combinedBbox[1]], [combinedBbox[2], combinedBbox[3]]],
        { padding: 50, maxZoom: 16 }
      );
    }

  } catch (err) {
    console.error('Error loading territory chunks:', err);
    alert(`Erreur lors du chargement des données: ${err.message}`);
  } finally {
    hideLoading();
  }
}

/* ==========================================================================
   Real-Time Client-Side Filtering
   ========================================================================== */
function applyFilters() {
  if (!state.buildings || state.buildings.length === 0) return;

  const {
    selectedDpes,
    selectedOverheating,
    selectedLegal,
    legalMode,
    minPctFg,
    minConcentration,
    minLog,
    onlyUninsulatedRoof,
    onlyNoShutters,
    minOverheatScore,
    ownerSearchText,
    minPatrimoine,
    filterQpv,
    filterSocialOnly,
    filterExcludeSocial,
    filterRentControl,
    fieldwork,
    maxPolygons,
  } = state;

  const searchLower = (ownerSearchText || '').toLowerCase().trim();
  const filtered = [];

  for (let i = 0; i < state.buildings.length; i++) {
    const b = state.buildings[i];

    // 1. DPE filter
    const dpe = b.dpe || 'Inconnu';
    if (!selectedDpes.has(dpe)) continue;

    // 2. Slum % filter (pct_dpe_fg)
    const pctFg = Number(b.pct_dpe_fg || 0);
    if (pctFg < minPctFg) continue;

    // 3. Overheating risk filter
    const rawRisk = b.risque_surchauffe_ete;
    const risk = (!rawRisk || rawRisk === 'NC' || rawRisk === 'Inconnu') ? 'Non renseigné' : rawRisk;
    if (!selectedOverheating.has(risk)) continue;

    // 3b. Overheating score min
    if (minOverheatScore > 0 && Number(b.score_surchauffe_ete || 0) < minOverheatScore) continue;

    // 3c. Uninsulated roof
    if (onlyUninsulatedRoof) {
      const roof = String(b.type_isolation_plancher_haut || '').toLowerCase();
      if (!roof.includes('non isol')) continue;
    }

    // 3d. No shutters
    if (onlyNoShutters) {
      const shutters = String(b.type_fermeture || '').toLowerCase();
      if (!shutters.includes('sans fermeture') && !shutters.includes('absence')) continue;
    }

    // 4. Landlord Concentration filter
    const conc = Number(b.concentration_prop_max_num || 0);
    if (conc < minConcentration) continue;

    // 4b. Min Patrimoine
    if (minPatrimoine > 0 && Number(b.max_patrimoine_majic_bailleur || 0) < minPatrimoine) continue;

    // 4c. Owner Name / SIREN text search
    if (searchLower) {
      const denom = String(b.concentration_prop_max_denomination || '').toLowerCase();
      const siren = String(b.siren_principal || '').toLowerCase();
      let match = denom.includes(searchLower) || siren.includes(searchLower);
      if (!match) {
        const bOwners = state.ownersByBuilding.get(b.batiment_groupe_id) || [];
        for (let oIdx = 0; oIdx < bOwners.length; oIdx++) {
          const o = bOwners[oIdx];
          if (String(o.denomination || '').toLowerCase().includes(searchLower) ||
              String(o.siren || '').includes(searchLower)) {
            match = true;
            break;
          }
        }
      }
      if (!match) continue;
    }

    // 5. Min Dwellings filter
    const nbLog = Number(b.nb_log || 0);
    if (nbLog < minLog) continue;

    // 6. Legal Forms filter
    if (selectedLegal.size < 4) {
      const bLegals = String(b.formes_juridiques || '');
      if (legalMode === 'exclusif') {
        const parts = bLegals.split(',').map(s => s.trim()).filter(Boolean);
        if (parts.length === 0 || !parts.every(p => selectedLegal.has(p))) continue;
      } else {
        let hasMatch = false;
        for (const leg of selectedLegal) {
          if (bLegals.includes(leg)) {
            hasMatch = true;
            break;
          }
        }
        if (!hasMatch) continue;
      }
    }

    // 7. Urbanisme & Social
    if (filterQpv && (!b.quartier_qpv || b.quartier_qpv === 'None')) continue;
    if (filterSocialOnly && !b.est_logement_social_rpls) continue;
    if (filterExcludeSocial && b.est_logement_social_rpls) continue;
    if (filterRentControl && Number(b.zone_encadrement_loyers || 0) <= 0) continue;

    // Color computation based on mapStyleMode
    let renderColor = DPE_COLORS[dpe] || DPE_COLORS['Inconnu'];
    if (state.mapStyleMode === 'overheating') {
      renderColor = OVERHEATING_COLORS[risk] || OVERHEATING_COLORS['Faible'];
    } else if (state.mapStyleMode === 'concentration') {
      renderColor = conc >= 80 ? '#ef4444' : conc >= 50 ? '#f59e0b' : conc >= 20 ? '#38bdf8' : '#64748b';
    } else if (state.mapStyleMode === 'fieldwork') {
      const isField = fieldwork.has(b.batiment_groupe_id);
      renderColor = isField ? '#a855f7' : 'rgba(100, 116, 139, 0.4)';
    }

    // Attach computed property for MapLibre GPU shader
    b.render_color = renderColor;
    filtered.push(b);
  }

  state.filteredBuildings = filtered;
  updateKPIs(filtered);

  // Apply max polygons limit to map display
  const mapBuildings = (maxPolygons && maxPolygons < filtered.length)
    ? filtered.slice(0, maxPolygons)
    : filtered;
  updateMapSource(mapBuildings);

  // Synchronize active view
  if (state.activeTab === 'buildings') {
    renderBuildingsTable();
  } else if (state.activeTab === 'landlords') {
    renderLandlordsTab();
  }
  updateExportTab();
}

function updateKPIs(filtered) {
  const totalBuildings = filtered.length;
  let totalDwellings = 0;
  let fgCount = 0;
  let highOverheatCount = 0;

  for (let i = 0; i < filtered.length; i++) {
    const b = filtered[i];
    totalDwellings += Number(b.nb_log || 0);
    const dpe = b.dpe;
    if (dpe === 'F' || dpe === 'G') fgCount++;
    if (b.risque_surchauffe_ete === 'Critique' || b.risque_surchauffe_ete === 'Élevé') highOverheatCount++;
  }

  document.getElementById('kpi-buildings').textContent = totalBuildings.toLocaleString();
  document.getElementById('kpi-dwellings').textContent = totalDwellings.toLocaleString();
  document.getElementById('kpi-slums').textContent = totalBuildings > 0 
    ? `${Math.round((fgCount / totalBuildings) * 100)}%` 
    : '0%';
  document.getElementById('kpi-overheating').textContent = totalBuildings > 0 
    ? `${Math.round((highOverheatCount / totalBuildings) * 100)}%` 
    : '0%';
  document.getElementById('export-count').textContent = totalBuildings.toLocaleString();
}

function updateMapSource(buildings) {
  if (!state.map) return;
  const source = state.map.getSource('buildings-source');
  if (!source) return;

  const features = [];
  for (let i = 0; i < buildings.length; i++) {
    const b = buildings[i];
    if (b.geometry) {
      features.push({
        type: 'Feature',
        id: i,
        geometry: b.geometry,
        properties: {
          batiment_groupe_id: b.batiment_groupe_id,
          adr: b.adr,
          cp: Number(b.cp || 0),
          dpe: b.dpe,
          render_color: b.render_color,
        },
      });
    }
  }

  source.setData({
    type: 'FeatureCollection',
    features: features,
  });
}

function setMapDim(dimPct) {
  if (!state.map || !state.map.getLayer('osm-tiles-layer')) return;
  const opacity = Math.max(0.1, 1.0 - (dimPct / 100) * 0.85);
  const saturation = -Math.min(1.0, (dimPct / 100) * 1.2);
  state.map.setPaintProperty('osm-tiles-layer', 'raster-opacity', opacity);
  state.map.setPaintProperty('osm-tiles-layer', 'raster-saturation', saturation);
}

function updateLegend() {
  const title = document.getElementById('legend-title');
  const items = document.getElementById('legend-items');
  if (!title || !items) return;

  items.innerHTML = '';
  if (state.mapStyleMode === 'dpe') {
    title.textContent = 'Diagnostic Énergétique (DPE)';
    const classes = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
    for (const c of classes) {
      items.innerHTML += `
        <div class="legend-item">
          <span class="legend-color" style="background: ${DPE_COLORS[c]};"></span>
          <span>${c}</span>
        </div>
      `;
    }
  } else if (state.mapStyleMode === 'overheating') {
    title.textContent = 'Risque de Surchauffe Estivale';
    items.innerHTML = `
      <div class="legend-item"><span class="legend-color" style="background: #991b1b;"></span><span>Critique 🔥🔥</span></div>
      <div class="legend-item"><span class="legend-color" style="background: #ef4444;"></span><span>Élevé 🔥</span></div>
      <div class="legend-item"><span class="legend-color" style="background: #f59e0b;"></span><span>Modéré</span></div>
      <div class="legend-item"><span class="legend-color" style="background: #38bdf8;"></span><span>Faible</span></div>
      <div class="legend-item"><span class="legend-color" style="background: #64748b;"></span><span>Non renseigné</span></div>
    `;
  } else if (state.mapStyleMode === 'concentration') {
    title.textContent = 'Concentration Foncière (Principal Propriétaire)';
    items.innerHTML = `
      <div class="legend-item"><span class="legend-color" style="background: #ef4444;"></span><span>≥ 80%</span></div>
      <div class="legend-item"><span class="legend-color" style="background: #f59e0b;"></span><span>50–80%</span></div>
      <div class="legend-item"><span class="legend-color" style="background: #38bdf8;"></span><span>20–50%</span></div>
      <div class="legend-item"><span class="legend-color" style="background: #64748b;"></span><span>&lt; 20%</span></div>
    `;
  } else if (state.mapStyleMode === 'fieldwork') {
    title.textContent = 'Enquête de Terrain';
    items.innerHTML = `
      <div class="legend-item"><span class="legend-color" style="background: #a855f7;"></span><span>Visité / Enquêté</span></div>
      <div class="legend-item"><span class="legend-color" style="background: rgba(100, 116, 139, 0.4);"></span><span>Non visité</span></div>
    `;
  }
}

/* ==========================================================================
   Building Inspector & Live INSEE/RNE Sirene Lookup
   ========================================================================== */
function inspectBuilding(batimentGroupeId) {
  state.selectedBuildingId = batimentGroupeId;
  const b = state.buildings.find(item => item.batiment_groupe_id === batimentGroupeId);
  if (!b) return;

  // Highlight on map
  state.map.setFilter('buildings-selected', ['==', ['get', 'batiment_groupe_id'], batimentGroupeId]);

  // Fill Drawer Header
  document.getElementById('drawer-address').textContent = b.adr || 'Adresse inconnue';
  document.getElementById('drawer-commune').textContent = `${b.cp || ''} ${b.libelle_commune_insee || ''}`;

  // Fill DPE Card
  const dpe = b.dpe || 'NC';
  const badge = document.getElementById('drawer-dpe-badge');
  badge.textContent = dpe;
  badge.style.background = DPE_COLORS[dpe] || DPE_COLORS['Inconnu'];

  document.getElementById('drawer-conso').textContent = b.conso_ep_m2 ? Math.round(b.conso_ep_m2) : '—';
  document.getElementById('drawer-ges').textContent = b.classe_ges || '—';
  document.getElementById('drawer-nb-log').textContent = b.nb_log || '1';
  document.getElementById('drawer-nb-niveaux').textContent = b.nb_niveau || '—';
  document.getElementById('drawer-annee').textContent = b.annee_construction || 'Non renseignée';

  // Fill Overheating Card
  const score = Number(b.score_surchauffe_ete || 0);
  const risk = b.risque_surchauffe_ete || 'Faible';
  const scoreEl = document.getElementById('drawer-overheating-score');
  scoreEl.textContent = `${score} / 100 (${risk})`;
  scoreEl.style.color = OVERHEATING_COLORS[risk] || '#38bdf8';

  const barEl = document.getElementById('drawer-overheating-bar');
  barEl.style.width = `${Math.min(100, Math.max(5, score))}%`;
  barEl.style.background = OVERHEATING_COLORS[risk] || '#38bdf8';

  const factors = b.facteurs_surchauffe ? b.facteurs_surchauffe.split(' | ').join('<br>• ') : 'Aucun facteur critique détecté';
  document.getElementById('drawer-overheating-factors').innerHTML = `• ${factors}`;

  // Fill Corporate Owners List
  const owners = state.ownersByBuilding.get(batimentGroupeId) || [];
  const ownersListEl = document.getElementById('drawer-owners-list');
  if (owners.length === 0) {
    ownersListEl.innerHTML = '<p style="font-size: 0.8rem; color: var(--text-muted);">Aucun propriétaire personne morale enregistré dans le fichier foncier MAJIC.</p>';
  } else {
    ownersListEl.innerHTML = '';
    for (const o of owners) {
      const item = document.createElement('div');
      item.className = 'owner-item';
      item.innerHTML = `
        <div class="owner-header">
          <span class="owner-name">${o.denomination || 'Dénomination inconnue'}</span>
          <span class="owner-type">${o.forme_juridique || 'Personne Morale'}</span>
        </div>
        <div class="owner-meta">
          SIREN : <code>${o.siren || 'NC'}</code> | Locaux possédés dans l'immeuble : <strong>${o.nb_locaux_open_dans_batiment || 1}</strong>
        </div>
        ${o.siren ? `
          <div style="margin-top: 0.35rem;">
            <button class="btn btn-secondary btn-sm btn-lookup-siren" data-siren="${o.siren}" style="font-size: 0.7rem; padding: 0.2rem 0.45rem;">
              🔍 Voir Dirigeants (INSEE/RNE)
            </button>
            <div class="siren-results" id="siren-res-${o.siren}" style="display: none; margin-top: 0.35rem; font-size: 0.74rem; background: rgba(0,0,0,0.3); padding: 0.4rem; border-radius: 4px;"></div>
          </div>
        ` : ''}
      `;
      ownersListEl.appendChild(item);
    }

    // Attach Siren lookup handlers
    ownersListEl.querySelectorAll('.btn-lookup-siren').forEach(btn => {
      btn.addEventListener('click', () => lookupSiren(btn.getAttribute('data-siren')));
    });
  }

  // Open Drawer
  document.getElementById('building-drawer').classList.add('open');
}

// Live French Government Business Directory API Lookup
async function lookupSiren(siren) {
  const resDiv = document.getElementById(`siren-res-${siren}`);
  if (!resDiv) return;
  resDiv.style.display = 'block';
  resDiv.innerHTML = '<span class="spinner" style="display:inline-block; width:12px; height:12px;"></span> Recherche au Registre National des Entreprises (RNE)...';

  try {
    const res = await fetch(`https://recherche-entreprises.api.gouv.fr/search?q=${siren}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data.results || data.results.length === 0) {
      resDiv.innerHTML = 'Aucune fiche trouvée au RNE pour ce numéro SIREN.';
      return;
    }
    const company = data.results[0];
    const dirigeants = company.dirigeants || [];
    let dirigeantsHtml = '<em>Aucun dirigeant nominatif renseigné</em>';
    if (dirigeants.length > 0) {
      dirigeantsHtml = dirigeants.map(d => `<strong>${d.prenoms || ''} ${d.nom || ''}</strong> (${d.qualite || 'Dirigeant'})`).join('<br>');
    }

    resDiv.innerHTML = `
      <div style="margin-bottom: 0.25rem; color: #4ade80;"><strong>${company.nom_complet || ''}</strong></div>
      <div style="color: var(--text-muted); margin-bottom: 0.25rem;">Siège : ${company.siege?.adresse || 'Non renseigné'}</div>
      <div>Dirigeant(s) :<br>${dirigeantsHtml}</div>
    `;
  } catch (err) {
    resDiv.innerHTML = `Erreur lors de la requête RNE : ${err.message}`;
  }
}

/* ==========================================================================
   Fieldwork Excel Upload & Merge
   ========================================================================== */
function initFieldworkDropzone() {
  const dropzone = document.getElementById('fieldwork-dropzone');
  const fileInput = document.getElementById('fieldwork-file-input');

  dropzone.addEventListener('click', () => fileInput.click());

  dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.classList.add('dragover');
  });

  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));

  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
    if (e.dataTransfer.files.length > 0) {
      handleFieldworkFile(e.dataTransfer.files[0]);
    }
  });

  fileInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
      handleFieldworkFile(e.target.files[0]);
    }
  });

  document.getElementById('btn-clear-fieldwork').addEventListener('click', () => {
    state.fieldwork.clear();
    document.getElementById('fieldwork-info').style.display = 'none';
    document.getElementById('fieldwork-badge').style.display = 'none';
    document.getElementById('btn-style-fieldwork').style.display = 'none';
    fileInput.value = '';
    applyFilters();
  });
}

async function handleFieldworkFile(file) {
  showLoading(`Lecture du fichier terrain ${file.name}...`);
  try {
    const arrayBuffer = await file.arrayBuffer();
    const workbook = XLSX.read(arrayBuffer, { type: 'array' });
    const firstSheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[firstSheetName];
    const jsonRows = XLSX.utils.sheet_to_json(sheet);

    if (jsonRows.length === 0) {
      alert("Le fichier Excel est vide.");
      hideLoading();
      return;
    }

    // Look for batiment_groupe_id column
    const sample = jsonRows[0];
    const idKey = Object.keys(sample).find(k => k.toLowerCase().includes('batiment_groupe_id') || k.toLowerCase() === 'id');
    if (!idKey) {
      alert("Colonne 'batiment_groupe_id' introuvable dans le fichier Excel.");
      hideLoading();
      return;
    }

    state.fieldwork.clear();
    let matchCount = 0;
    const buildingIds = new Set(state.buildings.map(b => b.batiment_groupe_id));

    for (const row of jsonRows) {
      const bId = String(row[idKey]);
      state.fieldwork.set(bId, row);
      if (buildingIds.has(bId)) matchCount++;
    }

    document.getElementById('fieldwork-info').style.display = 'block';
    document.getElementById('fieldwork-filename').textContent = file.name;
    document.getElementById('fieldwork-stats').textContent = 
      `${jsonRows.length.toLocaleString()} lignes lues — ${matchCount.toLocaleString()} bâtiments correspondants sur le territoire chargé.`;

    const badge = document.getElementById('fieldwork-badge');
    badge.textContent = `${matchCount} liés`;
    badge.style.display = 'inline-block';
    badge.className = 'status-badge status-cached';

    // Reveal fieldwork style switcher
    document.getElementById('btn-style-fieldwork').style.display = 'inline-block';

    applyFilters();
  } catch (err) {
    console.error('Error parsing fieldwork file:', err);
    alert(`Erreur lors de la lecture du tableur: ${err.message}`);
  } finally {
    hideLoading();
  }
}

/* ==========================================================================
   Exports (Excel & GeoJSON)
   ========================================================================== */
function exportFilteredBuildingsExcel() {
  if (state.filteredBuildings.length === 0) return;
  showLoading('Génération du tableur Excel des bâtiments...');

  setTimeout(() => {
    // Strip geometry before exporting to Excel
    const rows = state.filteredBuildings.map(b => {
      const copy = { ...b };
      delete copy.geometry;
      delete copy.render_color;
      return copy;
    });

    const worksheet = XLSX.utils.json_to_sheet(rows);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Batiments_Filtres');
    XLSX.writeFile(workbook, `tezeloma_batiments_export_${new Date().toISOString().slice(0, 10)}.xlsx`);
    hideLoading();
    closeAllModals();
  }, 100);
}

function exportFilteredOwnersExcel() {
  if (state.filteredBuildings.length === 0) return;
  showLoading('Génération du tableur des bailleurs...');

  setTimeout(() => {
    const bIdSet = new Set(state.filteredBuildings.map(b => b.batiment_groupe_id));
    const matchedOwners = state.owners.filter(o => bIdSet.has(o.batiment_groupe_id));

    const worksheet = XLSX.utils.json_to_sheet(matchedOwners);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Bailleurs_Filtres');
    XLSX.writeFile(workbook, `tezeloma_bailleurs_export_${new Date().toISOString().slice(0, 10)}.xlsx`);
    hideLoading();
    closeAllModals();
  }, 100);
}

function exportFilteredGeoJSON() {
  if (state.filteredBuildings.length === 0) return;
  showLoading('Export GeoJSON...');

  setTimeout(() => {
    const features = state.filteredBuildings.map(b => ({
      type: 'Feature',
      geometry: b.geometry,
      properties: { ...b, geometry: undefined },
    }));

    const geojson = {
      type: 'FeatureCollection',
      name: 'TeZeLoMa_Export',
      crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:OGC:1.3:CRS84' } },
      features: features,
    };

    const blob = new Blob([JSON.stringify(geojson)], { type: 'application/geo+json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `tezeloma_carte_export_${new Date().toISOString().slice(0, 10)}.geojson`;
    a.click();
    URL.revokeObjectURL(url);
    hideLoading();
    closeAllModals();
  }, 100);
}

/* ==========================================================================
   Navigation Tabs Management
   ========================================================================== */
function initTabs() {
  document.querySelectorAll('.nav-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      const tabId = btn.getAttribute('data-tab');
      switchTab(tabId);
    });
  });

  const headerExportBtn = document.getElementById('btn-header-export');
  if (headerExportBtn) {
    headerExportBtn.addEventListener('click', () => {
      switchTab('export');
    });
  }
}

function switchTab(tabId) {
  state.activeTab = tabId;

  // Update navigation tab highlights
  document.querySelectorAll('.nav-tab').forEach(b => {
    b.classList.toggle('active', b.getAttribute('data-tab') === tabId);
  });

  // Update visible pane
  document.querySelectorAll('.tab-pane').forEach(p => {
    p.classList.toggle('active', p.id === `pane-${tabId}`);
  });

  // Pane-specific activations
  if (tabId === 'map') {
    if (state.map) {
      setTimeout(() => state.map.resize(), 50);
    }
  } else if (tabId === 'buildings') {
    renderBuildingsTable();
  } else if (tabId === 'landlords') {
    renderLandlordsTab();
  } else if (tabId === 'export') {
    updateExportTab();
  }
}

/* ==========================================================================
   Tab 2: Buildings Data Table Logic
   ========================================================================== */
let buildingsTableRenderLimit = 200;
let buildingsSortCol = null;
let buildingsSortDir = null; // 'asc' | 'desc' | null
let currentBuildingsDisplayRows = [];
let currentBuildingsMatchingSet = new Set();
let currentBuildingsColumns = [];

const BASE_BUILDINGS_TABLE_COLUMNS = [
  {
    key: 'batiment_groupe_id',
    label: 'ID BDNB',
    type: 'text',
    render: (b) => `<code>${escapeHtml(b.batiment_groupe_id || '')}</code>`,
  },
  {
    key: 'adr',
    label: 'Adresse',
    type: 'text',
    render: (b) => `<strong>${escapeHtml(b.adr || 'Adresse inconnue')}</strong>`,
  },
  {
    key: 'cp',
    label: 'CP',
    type: 'text',
    render: (b) => escapeHtml(b.cp != null ? String(b.cp) : ''),
  },
  {
    key: 'nb_log',
    label: 'Logements',
    type: 'number',
    render: (b) => escapeHtml(b.nb_log != null ? String(b.nb_log) : '1'),
  },
  {
    key: 'dpe',
    label: 'DPE',
    type: 'text',
    render: (b) => {
      const dpe = b.dpe || 'NC';
      const dpeColor = DPE_COLORS[dpe] || DPE_COLORS['Inconnu'];
      return `<span class="badge-dpe" style="background: ${dpeColor};">${escapeHtml(dpe)}</span>`;
    },
  },
  {
    key: 'nb_dpe_fg',
    label: 'Nb DPE F/G',
    type: 'number',
    render: (b) => (b.nb_dpe_fg != null ? String(b.nb_dpe_fg) : '—'),
  },
  {
    key: 'pct_dpe_fg',
    label: '% F/G',
    type: 'number',
    render: (b) => (b.pct_dpe_fg != null ? Math.round(Number(b.pct_dpe_fg)) + '%' : '0%'),
  },
  {
    key: 'risque_surchauffe_ete',
    label: 'Risque Été',
    type: 'risk',
    render: (b) => {
      const risk = b.risque_surchauffe_ete || 'Non renseigné';
      if (risk === 'Critique') {
        return `<span class="badge-risk" style="background: rgba(153, 27, 27, 0.45); color: #fca5a5; border: 1px solid #ef4444;">🔥 Critique</span>`;
      }
      const riskColor = OVERHEATING_COLORS[risk] || '#64748b';
      return `<span class="badge-risk" style="background: ${riskColor}22; color: ${riskColor}; border: 1px solid ${riskColor}55;">${escapeHtml(risk)}</span>`;
    },
  },
  {
    key: 'score_surchauffe_ete',
    label: 'Score (/100)',
    type: 'number',
    render: (b) => `<strong>${b.score_surchauffe_ete != null ? b.score_surchauffe_ete : 0}</strong>`,
  },
  {
    key: 'facteurs_surchauffe',
    label: 'Facteurs',
    type: 'text',
    render: (b) => `<span style="max-width: 200px; display: inline-block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${escapeHtml(b.facteurs_surchauffe || '')}">${escapeHtml(b.facteurs_surchauffe || '—')}</span>`,
  },
  {
    key: 'icu_expo_nuit',
    label: 'ICU Nuit',
    type: 'text',
    render: (b) => escapeHtml(b.icu_expo_nuit != null ? String(b.icu_expo_nuit) : '—'),
  },
  {
    key: 'type_isolation_plancher_haut',
    label: 'Isolation Toit',
    type: 'text',
    render: (b) => escapeHtml(b.type_isolation_plancher_haut || '—'),
  },
  {
    key: 'type_isolation_mur_exterieur',
    label: 'Isolation Mur',
    type: 'text',
    render: (b) => escapeHtml(b.type_isolation_mur_exterieur || '—'),
  },
  {
    key: 'type_fermeture',
    label: 'Volets',
    type: 'text',
    render: (b) => escapeHtml(b.type_fermeture || '—'),
  },
  {
    key: 'classe_inertie',
    label: 'Inertie',
    type: 'text',
    render: (b) => escapeHtml(b.classe_inertie || '—'),
  },
  {
    key: 'concentration_prop_max_denomination',
    label: 'Principal Bailleur',
    type: 'text',
    render: (b) => `<strong>${escapeHtml(b.concentration_prop_max_denomination || '—')}</strong>`,
  },
  {
    key: 'siren_principal',
    label: 'SIREN',
    type: 'text',
    render: (b) => `<code>${escapeHtml(b.siren_principal || '—')}</code>`,
  },
  {
    key: 'concentration_prop_max_pct',
    label: 'Conc. %',
    type: 'number',
    sortValue: (b) => (b.concentration_prop_max_num != null ? Number(b.concentration_prop_max_num) : (b.concentration_prop_max_pct != null ? Number(b.concentration_prop_max_pct) : null)),
    render: (b) => {
      const val = b.concentration_prop_max_num != null ? b.concentration_prop_max_num : b.concentration_prop_max_pct;
      const conc = val != null ? Math.round(Number(val)) : 0;
      return conc > 0 ? conc + '%' : '—';
    },
  },
  {
    key: 'max_patrimoine_majic_bailleur',
    label: 'Patrimoine Local',
    type: 'number',
    render: (b) => (b.max_patrimoine_majic_bailleur ? Number(b.max_patrimoine_majic_bailleur).toLocaleString('fr-FR') + ' loc.' : '—'),
  },
  {
    key: 'loyer_max_t2_non_meuble_m2',
    label: 'Loyer Max T2 NM',
    type: 'number',
    render: (b) => (b.loyer_max_t2_non_meuble_m2 ? Number(b.loyer_max_t2_non_meuble_m2).toFixed(1) + ' €' : (b.zone_encadrement_loyers ? 'Zoné' : 'Non')),
  },
  {
    key: 'loyer_max_t2_meuble_m2',
    label: 'Loyer Max T2 M',
    type: 'number',
    render: (b) => (b.loyer_max_t2_meuble_m2 ? Number(b.loyer_max_t2_meuble_m2).toFixed(1) + ' €' : (b.zone_encadrement_loyers ? 'Zoné' : 'Non')),
  },
  {
    key: 'est_logement_social_rpls',
    label: 'Parc Social',
    type: 'text',
    render: (b) => (b.est_logement_social_rpls ? '🏛️ Oui' : 'Non'),
  },
  {
    key: 'nom_copro',
    label: 'Copropriété',
    type: 'text',
    render: (b) => {
      let val = b.nom_copro || '—';
      if (typeof val === 'string' && val.startsWith('[') && val.endsWith(']')) {
        try {
          const parsed = JSON.parse(val);
          if (Array.isArray(parsed)) val = parsed.join(', ');
        } catch (_) {}
      }
      return escapeHtml(val);
    },
  },
  {
    key: 'quartier_qpv',
    label: 'Quartier QPV',
    type: 'text',
    render: (b) => escapeHtml(b.quartier_qpv || '—'),
  },
];

function getFieldworkColumns() {
  if (!state.fieldwork || state.fieldwork.size === 0) return [];
  const keys = new Set();
  for (const row of state.fieldwork.values()) {
    for (const k of Object.keys(row)) {
      const lower = k.toLowerCase();
      if (lower !== 'batiment_groupe_id' && lower !== 'id') {
        keys.add(k);
      }
    }
  }
  return Array.from(keys).map(k => ({
    key: `custom_${k}`,
    customKey: k,
    label: k,
    type: 'custom',
    sortValue: (b) => {
      const r = state.fieldwork.get(b.batiment_groupe_id);
      return r ? r[k] : null;
    },
    render: (b) => {
      const r = state.fieldwork.get(b.batiment_groupe_id);
      return escapeHtml(r && r[k] != null ? String(r[k]) : '—');
    }
  }));
}

function getAllBuildingsColumns() {
  const fwCols = getFieldworkColumns();
  const actionCol = {
    key: '_action',
    label: 'Action',
    isAction: true,
    render: (b) => `
      <button class="btn btn-secondary btn-sm btn-table-view" data-bid="${escapeHtml(b.batiment_groupe_id)}" style="font-size: 0.7rem; padding: 0.2rem 0.5rem; white-space: nowrap;">
        🗺️ Voir
      </button>
    `,
  };
  return [...BASE_BUILDINGS_TABLE_COLUMNS, ...fwCols, actionCol];
}

function getBuildingSortValue(b, col) {
  if (col.sortValue) return col.sortValue(b);
  if (col.customKey) {
    const r = state.fieldwork ? state.fieldwork.get(b.batiment_groupe_id) : null;
    return r ? r[col.customKey] : null;
  }
  return b[col.key];
}

function isBlankValue(val) {
  return val === null || val === undefined || val === '' || val === 'NC' || val === '—';
}

function compareBuildingRows(a, b, col, dir) {
  const vA = getBuildingSortValue(a, col);
  const vB = getBuildingSortValue(b, col);
  const blankA = isBlankValue(vA);
  const blankB = isBlankValue(vB);

  if (blankA && blankB) return 0;
  if (blankA) return 1; // blanks always placed at the bottom
  if (blankB) return -1;

  let cmp = 0;
  if (col.type === 'risk') {
    const ranks = { 'Critique': 4, 'Élevé': 3, 'Modéré': 2, 'Faible': 1, 'Non renseigné': 0 };
    const rA = ranks[vA] !== undefined ? ranks[vA] : 0;
    const rB = ranks[vB] !== undefined ? ranks[vB] : 0;
    cmp = rA - rB;
  } else if (col.type === 'number') {
    const nA = Number(vA);
    const nB = Number(vB);
    cmp = (isNaN(nA) ? 0 : nA) - (isNaN(nB) ? 0 : nB);
  } else {
    cmp = String(vA).localeCompare(String(vB), 'fr', { numeric: true, sensitivity: 'base' });
  }

  return dir === 'desc' ? -cmp : cmp;
}

function defaultBuildingSort(a, b) {
  const sDiff = Number(b.score_surchauffe_ete || 0) - Number(a.score_surchauffe_ete || 0);
  if (sDiff !== 0) return sDiff;
  const fgA = a.nb_dpe_fg != null ? Number(a.nb_dpe_fg) : Number(a.nb_log || 0);
  const fgB = b.nb_dpe_fg != null ? Number(b.nb_dpe_fg) : Number(b.nb_log || 0);
  return fgB - fgA;
}

function renderBuildingsTableHeaders() {
  const thead = document.getElementById('table-buildings-head') || document.querySelector('#table-buildings thead');
  if (!thead) return;

  currentBuildingsColumns = getAllBuildingsColumns();
  const tr = document.createElement('tr');

  for (const col of currentBuildingsColumns) {
    const th = document.createElement('th');
    if (col.isAction) {
      th.textContent = col.label;
    } else {
      th.className = 'sortable';
      if (buildingsSortCol === col.key) {
        th.classList.add('sorted-active');
        const icon = buildingsSortDir === 'asc' ? ' ▲' : (buildingsSortDir === 'desc' ? ' ▼' : '');
        th.innerHTML = `${escapeHtml(col.label)}<span class="sort-indicator">${icon}</span>`;
      } else {
        th.textContent = col.label;
      }

      th.addEventListener('click', () => {
        if (buildingsSortCol === col.key) {
          if (buildingsSortDir === 'asc') {
            buildingsSortDir = 'desc';
          } else if (buildingsSortDir === 'desc') {
            buildingsSortCol = null;
            buildingsSortDir = null;
          } else {
            buildingsSortDir = 'asc';
          }
        } else {
          buildingsSortCol = col.key;
          buildingsSortDir = 'asc';
        }
        buildingsTableRenderLimit = 200;
        const container = document.querySelector('#pane-buildings .data-table-container');
        if (container) container.scrollTop = 0;
        renderBuildingsTable();
      });
    }
    tr.appendChild(th);
  }

  thead.innerHTML = '';
  thead.appendChild(tr);
}

function initBuildingsTableControls() {
  const queryInput = document.getElementById('table-search-query');
  const modeSelect = document.getElementById('table-search-mode');
  const container = document.querySelector('#pane-buildings .data-table-container');

  if (queryInput) {
    let timeout = null;
    queryInput.addEventListener('input', () => {
      clearTimeout(timeout);
      timeout = setTimeout(() => {
        buildingsTableRenderLimit = 200;
        if (container) container.scrollTop = 0;
        renderBuildingsTable();
      }, 250);
    });
  }

  if (modeSelect) {
    modeSelect.addEventListener('change', () => {
      buildingsTableRenderLimit = 200;
      if (container) container.scrollTop = 0;
      renderBuildingsTable();
    });
  }

  if (container) {
    container.addEventListener('scroll', () => {
      if (container.scrollTop + container.clientHeight >= container.scrollHeight - 300) {
        if (buildingsTableRenderLimit < currentBuildingsDisplayRows.length) {
          const nextLimit = Math.min(buildingsTableRenderLimit + 200, currentBuildingsDisplayRows.length);
          renderBuildingsBatch(buildingsTableRenderLimit, nextLimit);
          buildingsTableRenderLimit = nextLimit;
        }
      }
    });
  }
}

function renderBuildingsTable() {
  const tbody = document.getElementById('table-buildings-body');
  if (!tbody) return;

  renderBuildingsTableHeaders();

  const query = (document.getElementById('table-search-query')?.value || '').trim().toLowerCase();
  const searchMode = document.getElementById('table-search-mode')?.value || 'filter';

  // Base list
  let list = [...state.filteredBuildings];

  // Apply sorting
  if (buildingsSortCol && buildingsSortDir) {
    const activeCol = currentBuildingsColumns.find(c => c.key === buildingsSortCol);
    if (activeCol) {
      list.sort((a, b) => compareBuildingRows(a, b, activeCol, buildingsSortDir));
    } else {
      list.sort(defaultBuildingSort);
    }
  } else {
    list.sort(defaultBuildingSort);
  }

  const tokens = query ? query.split(/\s+/).filter(Boolean) : [];
  currentBuildingsMatchingSet.clear();

  if (tokens.length > 0) {
    const searchableCols = currentBuildingsColumns.filter(c => !c.isAction);
    for (const b of list) {
      const searchBlob = searchableCols
        .map(col => {
          const val = getBuildingSortValue(b, col);
          return val != null ? String(val) : '';
        })
        .join(' ')
        .toLowerCase();
      const match = tokens.every(tok => searchBlob.includes(tok));
      if (match) currentBuildingsMatchingSet.add(b.batiment_groupe_id);
    }
  }

  let displayRows = [];
  if (tokens.length > 0) {
    if (searchMode === 'filter') {
      displayRows = list.filter(b => currentBuildingsMatchingSet.has(b.batiment_groupe_id));
    } else {
      // Highlight mode: matching rows first
      const matches = list.filter(b => currentBuildingsMatchingSet.has(b.batiment_groupe_id));
      const others = list.filter(b => !currentBuildingsMatchingSet.has(b.batiment_groupe_id));
      displayRows = [...matches, ...others];
    }
  } else {
    displayRows = list;
  }

  currentBuildingsDisplayRows = displayRows;

  // Synthesis metrics (reflect search matches in both filter and highlight modes)
  const statsSource = tokens.length > 0
    ? (searchMode === 'filter' ? displayRows : list.filter(b => currentBuildingsMatchingSet.has(b.batiment_groupe_id)))
    : list;
  const tBats = statsSource.length;
  let tLogs = 0;
  let tFg = 0;
  let tOverheat = 0;
  let tPm = 0;

  for (const b of statsSource) {
    tLogs += Number(b.nb_log || 0);
    tFg += Number(b.nb_dpe_fg != null ? b.nb_dpe_fg : (b.dpe === 'F' || b.dpe === 'G' ? (b.nb_log || 1) : 0));
    if (b.risque_surchauffe_ete === 'Élevé' || b.risque_surchauffe_ete === 'Critique') tOverheat++;
    if (b.concentration_prop_max_denomination && b.concentration_prop_max_denomination !== 'NC') tPm++;
  }

  const elBats = document.getElementById('tbl-kpi-bats');
  const elLogs = document.getElementById('tbl-kpi-logs');
  const elFg = document.getElementById('tbl-kpi-fg');
  const elOverheat = document.getElementById('tbl-kpi-overheat');
  const elPm = document.getElementById('tbl-kpi-pm');
  const elNote = document.getElementById('table-filter-note');

  if (elBats) elBats.textContent = tBats.toLocaleString('fr-FR');
  if (elLogs) elLogs.textContent = tLogs.toLocaleString('fr-FR');
  if (elFg) elFg.textContent = tFg.toLocaleString('fr-FR');
  if (elOverheat) elOverheat.textContent = tOverheat.toLocaleString('fr-FR');
  if (elPm) elPm.textContent = tPm.toLocaleString('fr-FR');

  if (elNote) {
    if (tokens.length > 0) {
      elNote.innerHTML = ` — <b>${currentBuildingsMatchingSet.size.toLocaleString('fr-FR')} / ${list.length.toLocaleString('fr-FR')}</b> bât. pour « <b>${escapeHtml(query)}</b> »`;
    } else {
      elNote.textContent = ` (sur ${state.buildings.length.toLocaleString('fr-FR')} bât. dans le territoire sélectionné)`;
    }
  }

  // Clear tbody and render initial batch
  tbody.innerHTML = '';
  renderBuildingsBatch(0, buildingsTableRenderLimit);
}

function renderBuildingsBatch(startIndex, endIndex) {
  const tbody = document.getElementById('table-buildings-body');
  if (!tbody) return;

  const slice = currentBuildingsDisplayRows.slice(startIndex, endIndex);
  if (slice.length === 0) return;

  const searchMode = document.getElementById('table-search-mode')?.value || 'filter';
  const hasTokens = currentBuildingsMatchingSet.size > 0;
  const fragment = document.createDocumentFragment();

  for (const b of slice) {
    const isHighlighted = hasTokens && currentBuildingsMatchingSet.has(b.batiment_groupe_id);
    const tr = document.createElement('tr');
    if (isHighlighted && searchMode === 'highlight') {
      tr.className = 'highlight-row';
    }

    let rowHtml = '';
    for (const col of currentBuildingsColumns) {
      rowHtml += `<td>${col.render(b)}</td>`;
    }
    tr.innerHTML = rowHtml;
    fragment.appendChild(tr);
  }

  tbody.appendChild(fragment);

  // Wire newly added view buttons
  tbody.querySelectorAll('.btn-table-view:not([data-wired])').forEach(btn => {
    btn.setAttribute('data-wired', 'true');
    btn.addEventListener('click', () => {
      const bId = btn.getAttribute('data-bid');
      viewBuildingOnMap(bId);
    });
  });
}

function viewBuildingOnMap(bId) {
  switchTab('map');
  const b = state.buildings.find(item => item.batiment_groupe_id === bId);
  if (b && state.map) {
    if (b.geometry) {
      const coords = getGeometryCenter(b.geometry);
      if (coords) {
        state.map.flyTo({ center: coords, zoom: 17, essential: true });
      }
    }
    inspectBuilding(bId);
  }
}

function getGeometryCenter(geom) {
  if (!geom) return null;
  if (geom.type === 'Point') return geom.coordinates;
  if (geom.type === 'Polygon' && geom.coordinates && geom.coordinates[0]) {
    const ring = geom.coordinates[0];
    let sumX = 0, sumY = 0;
    for (const pt of ring) {
      sumX += pt[0];
      sumY += pt[1];
    }
    return [sumX / ring.length, sumY / ring.length];
  }
  if (geom.type === 'MultiPolygon' && geom.coordinates && geom.coordinates[0] && geom.coordinates[0][0]) {
    const ring = geom.coordinates[0][0];
    let sumX = 0, sumY = 0;
    for (const pt of ring) {
      sumX += pt[0];
      sumY += pt[1];
    }
    return [sumX / ring.length, sumY / ring.length];
  }
  return null;
}

/* ==========================================================================
   Tab 3: Corporate Landlords & Live RNE Directory Logic
   ========================================================================== */
let currentLandlordsGrouped = [];
let landlordsSortCol = null;
let landlordsSortDir = null; // 'asc' | 'desc' | null

let currentLandlordOwnedBuildings = [];
let landlordBldgsSortCol = null;
let landlordBldgsSortDir = null; // 'asc' | 'desc' | null

const landlordApiCache = new Map();
let currentLandlordQuerySeq = 0;
let lastInspectedLandlordTarget = null;

const TOP_LANDLORDS_COLUMNS = [
  {
    key: 'siren',
    label: 'SIREN',
    type: 'text',
    sortValue: (g) => g.siren,
    render: (g) => `<code>${escapeHtml(g.siren || 'NC')}</code>`,
  },
  {
    key: 'denomination',
    label: 'Dénomination',
    type: 'text',
    sortValue: (g) => g.denomination,
    render: (g) => `<strong style="max-width: 280px; display: inline-block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; vertical-align: bottom;" title="${escapeHtml(g.denomination)}">${escapeHtml(g.denomination)}</strong>`,
  },
  {
    key: 'forme_juridique',
    label: 'Forme Juridique',
    type: 'text',
    sortValue: (g) => g.forme_juridique,
    render: (g) => `<span style="color: var(--text-secondary); font-size: 0.75rem;">${escapeHtml(g.forme_juridique)}</span>`,
  },
  {
    key: 'buildings_count',
    label: 'Bâtiments (sélection)',
    type: 'number',
    sortValue: (g) => g.buildings.size,
    render: (g) => `<strong>${g.buildings.size.toLocaleString('fr-FR')}</strong>`,
  },
  {
    key: 'locauxCount',
    label: 'Locaux (sélection)',
    type: 'number',
    sortValue: (g) => g.locauxCount,
    render: (g) => `<strong>${g.locauxCount.toLocaleString('fr-FR')}</strong>`,
  },
  {
    key: 'patrimoine_majic',
    label: 'Patrimoine Total (locaux)',
    type: 'number',
    sortValue: (g) => g.patrimoine_majic,
    render: (g) => (g.patrimoine_majic > 0 ? g.patrimoine_majic.toLocaleString('fr-FR') + ' loc.' : '—'),
  },
  {
    key: 'commune_siege',
    label: 'Commune du Siège',
    type: 'text',
    sortValue: (g) => g.commune_siege,
    render: (g) => `<span style="max-width: 170px; display: inline-block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; vertical-align: bottom;" title="${escapeHtml(g.commune_siege || '')}">${escapeHtml(g.commune_siege || '—')}</span>`,
  },
  {
    key: '_action',
    label: 'Action',
    isAction: true,
    render: (g) => `
      <button class="btn btn-secondary btn-sm btn-inspect-row" data-siren="${escapeHtml(g.siren)}" data-denom="${escapeHtml(g.denomination)}" style="font-size: 0.7rem; padding: 0.2rem 0.5rem; white-space: nowrap;">
        🔎 Inspecter
      </button>
    `,
  },
];

const LANDLORD_BUILDINGS_COLUMNS = [
  {
    key: 'batiment_groupe_id',
    label: 'ID BDNB',
    type: 'text',
    render: (b) => `<code>${escapeHtml(b.batiment_groupe_id || '')}</code>`,
  },
  {
    key: 'adr',
    label: 'Adresse',
    type: 'text',
    render: (b) => `<strong>${escapeHtml(b.adr || 'Adresse inconnue')}</strong>`,
  },
  {
    key: 'cp',
    label: 'CP',
    type: 'text',
    render: (b) => escapeHtml(b.cp != null ? String(b.cp) : ''),
  },
  {
    key: 'nb_log',
    label: 'Logements',
    type: 'number',
    render: (b) => escapeHtml(b.nb_log != null ? String(b.nb_log) : '1'),
  },
  {
    key: 'dpe',
    label: 'DPE',
    type: 'text',
    render: (b) => {
      const dpe = b.dpe || 'NC';
      const dpeColor = DPE_COLORS[dpe] || DPE_COLORS['Inconnu'];
      return `<span class="badge-dpe" style="background: ${dpeColor};">${escapeHtml(dpe)}</span>`;
    },
  },
  {
    key: 'pct_dpe_fg',
    label: '% F/G',
    type: 'number',
    render: (b) => (b.pct_dpe_fg != null ? Math.round(Number(b.pct_dpe_fg)) + '%' : '0%'),
  },
  {
    key: 'risque_surchauffe_ete',
    label: 'Risque Été',
    type: 'risk',
    render: (b) => {
      const risk = b.risque_surchauffe_ete || 'Non renseigné';
      if (risk === 'Critique') {
        return `<span class="badge-risk" style="background: rgba(153, 27, 27, 0.45); color: #fca5a5; border: 1px solid #ef4444;">🔥 Critique</span>`;
      }
      const riskColor = OVERHEATING_COLORS[risk] || '#64748b';
      return `<span class="badge-risk" style="background: ${riskColor}22; color: ${riskColor}; border: 1px solid ${riskColor}55;">${escapeHtml(risk)}</span>`;
    },
  },
  {
    key: 'score_surchauffe_ete',
    label: 'Score (/100)',
    type: 'number',
    render: (b) => `<strong>${b.score_surchauffe_ete != null ? b.score_surchauffe_ete : 0}</strong>`,
  },
  {
    key: 'facteurs_surchauffe',
    label: 'Facteurs',
    type: 'text',
    render: (b) => `<span style="max-width: 200px; display: inline-block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${escapeHtml(b.facteurs_surchauffe || '')}">${escapeHtml(b.facteurs_surchauffe || '—')}</span>`,
  },
  {
    key: 'loyer_max_t2_non_meuble_m2',
    label: 'Loyer Max T2 NM',
    type: 'number',
    render: (b) => (b.loyer_max_t2_non_meuble_m2 ? Number(b.loyer_max_t2_non_meuble_m2).toFixed(1) + ' €' : (b.zone_encadrement_loyers ? 'Zoné' : 'Non')),
  },
  {
    key: '_action',
    label: 'Action',
    isAction: true,
    render: (b) => `
      <button class="btn btn-secondary btn-sm btn-view-landlord-bldg" data-bid="${escapeHtml(b.batiment_groupe_id)}" style="font-size: 0.7rem; padding: 0.2rem 0.5rem; white-space: nowrap;">
        🗺️ Voir
      </button>
    `,
  },
];

function renderTopLandlordsHeaders() {
  const thead = document.querySelector('#table-top-landlords thead');
  if (!thead) return;

  const tr = document.createElement('tr');
  for (const col of TOP_LANDLORDS_COLUMNS) {
    const th = document.createElement('th');
    if (col.isAction) {
      th.textContent = col.label;
    } else {
      th.className = 'sortable';
      if (landlordsSortCol === col.key) {
        th.classList.add('sorted-active');
        const icon = landlordsSortDir === 'asc' ? ' ▲' : (landlordsSortDir === 'desc' ? ' ▼' : '');
        th.innerHTML = `${escapeHtml(col.label)}<span class="sort-indicator">${icon}</span>`;
      } else {
        th.textContent = col.label;
      }
      th.addEventListener('click', () => {
        if (landlordsSortCol === col.key) {
          if (landlordsSortDir === 'asc') landlordsSortDir = 'desc';
          else if (landlordsSortDir === 'desc') {
            landlordsSortCol = null;
            landlordsSortDir = null;
          } else landlordsSortDir = 'asc';
        } else {
          landlordsSortCol = col.key;
          landlordsSortDir = 'asc';
        }
        renderTopLandlordsTableRows();
      });
    }
    tr.appendChild(th);
  }
  thead.innerHTML = '';
  thead.appendChild(tr);
}

function renderTopLandlordsTableRows() {
  const tbody = document.getElementById('table-landlords-body');
  if (!tbody) return;

  renderTopLandlordsHeaders();

  let list = [...currentLandlordsGrouped];
  if (landlordsSortCol && landlordsSortDir) {
    const activeCol = TOP_LANDLORDS_COLUMNS.find(c => c.key === landlordsSortCol);
    if (activeCol) {
      list.sort((a, b) => {
        const vA = activeCol.sortValue(a);
        const vB = activeCol.sortValue(b);
        const blankA = isBlankValue(vA);
        const blankB = isBlankValue(vB);
        if (blankA && blankB) return 0;
        if (blankA) return 1;
        if (blankB) return -1;
        let cmp = 0;
        if (activeCol.type === 'number') {
          cmp = Number(vA || 0) - Number(vB || 0);
        } else {
          cmp = String(vA).localeCompare(String(vB), 'fr', { numeric: true, sensitivity: 'base' });
        }
        return landlordsSortDir === 'desc' ? -cmp : cmp;
      });
    }
  } else {
    // Default sort: locauxCount desc, then buildings.size desc
    list.sort((a, b) => {
      if (b.locauxCount !== a.locauxCount) return b.locauxCount - a.locauxCount;
      return b.buildings.size - a.buildings.size;
    });
  }

  tbody.innerHTML = '';
  if (list.length === 0) {
    tbody.innerHTML = `<tr><td colspan="${TOP_LANDLORDS_COLUMNS.length}" style="text-align: center; color: var(--text-muted); padding: 1.5rem;">Aucun propriétaire personne morale dans la sélection active.</td></tr>`;
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const g of list.slice(0, 100)) {
    const tr = document.createElement('tr');
    let rowHtml = '';
    for (const col of TOP_LANDLORDS_COLUMNS) {
      rowHtml += `<td>${col.render(g)}</td>`;
    }
    tr.innerHTML = rowHtml;
    fragment.appendChild(tr);
  }
  tbody.appendChild(fragment);

  // Wire Row Buttons
  tbody.querySelectorAll('.btn-inspect-row').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.getAttribute('data-siren') || btn.getAttribute('data-denom');
      const select = document.getElementById('select-landlord-to-inspect');
      const inputManual = document.getElementById('input-manual-siren');
      if (inputManual) inputManual.value = '';
      if (select) select.value = target;
      inspectLandlordTarget(target);
    });
  });
}

function renderLandlordsTab() {
  const tbody = document.getElementById('table-landlords-body');
  const select = document.getElementById('select-landlord-to-inspect');
  const inputManual = document.getElementById('input-manual-siren');
  if (!tbody) return;

  const bIdSet = new Set(state.filteredBuildings.map(b => b.batiment_groupe_id));
  const matchedOwners = state.owners.filter(o => bIdSet.has(o.batiment_groupe_id) && o.denomination);

  const groups = new Map();
  for (const o of matchedOwners) {
    const key = (o.siren || o.denomination).trim();
    if (!groups.has(key)) {
      groups.set(key, {
        siren: o.siren ? String(o.siren).trim() : '',
        denomination: o.denomination,
        forme_juridique: o.forme_juridique || 'Personne Morale',
        commune_siege: o.libelle_commune_proprietaire || '',
        patrimoine_majic: Number(o.nb_locaux_open_dans_MAJIC || o.max_patrimoine_majic_bailleur || 0),
        buildings: new Set(),
        locauxCount: 0,
      });
    }
    const g = groups.get(key);
    g.buildings.add(o.batiment_groupe_id);
    g.locauxCount += Number(o.nb_locaux_open_dans_batiment || 1);
    const majic = Number(o.nb_locaux_open_dans_MAJIC || o.max_patrimoine_majic_bailleur || 0);
    if (majic > g.patrimoine_majic) g.patrimoine_majic = majic;
    if (!g.commune_siege && o.libelle_commune_proprietaire) {
      g.commune_siege = o.libelle_commune_proprietaire;
    }
  }

  currentLandlordsGrouped = Array.from(groups.values()).sort((a, b) => {
    if (b.locauxCount !== a.locauxCount) return b.locauxCount - a.locauxCount;
    return b.buildings.size - a.buildings.size;
  });

  renderTopLandlordsTableRows();

  // Populate Select Dropdown
  if (select) {
    select.innerHTML = '';
    for (const g of currentLandlordsGrouped.slice(0, 150)) {
      const opt = document.createElement('option');
      opt.value = g.siren || g.denomination;
      opt.textContent = `${g.denomination} (SIREN: ${g.siren || 'N/A'} — ${g.buildings.size} bât. / ${g.locauxCount} locaux)`;
      select.appendChild(opt);
    }
  }

  // Determine auto-lookup target
  let autoTarget = null;
  const manualVal = (inputManual?.value || '').trim();
  if (manualVal) {
    autoTarget = manualVal;
  } else if (select && select.value) {
    autoTarget = select.value;
  } else if (currentLandlordsGrouped.length > 0) {
    const first = currentLandlordsGrouped[0];
    autoTarget = first.siren || first.denomination;
    if (select) select.value = autoTarget;
  }

  if (autoTarget && autoTarget !== lastInspectedLandlordTarget) {
    inspectLandlordTarget(autoTarget);
  }
}

function initLandlordsTabControls() {
  const select = document.getElementById('select-landlord-to-inspect');
  const inputManual = document.getElementById('input-manual-siren');
  const btnInspect = document.getElementById('btn-inspect-landlord');

  if (select) {
    select.addEventListener('change', () => {
      if (select.value) {
        if (inputManual) inputManual.value = '';
        inspectLandlordTarget(select.value);
      }
    });
  }

  if (btnInspect) {
    btnInspect.addEventListener('click', () => {
      const query = (inputManual?.value || select?.value || '').trim();
      if (!query) {
        alert("Veuillez saisir un nom ou un numéro SIREN à rechercher.");
        return;
      }
      inspectLandlordTarget(query);
    });
  }

  if (inputManual) {
    let manualTimeout = null;
    inputManual.addEventListener('input', () => {
      clearTimeout(manualTimeout);
      const query = inputManual.value.trim();
      manualTimeout = setTimeout(() => {
        if (query) {
          inspectLandlordTarget(query);
        } else if (select && select.value) {
          inspectLandlordTarget(select.value);
        }
      }, 600);
    });

    inputManual.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        clearTimeout(manualTimeout);
        const query = (inputManual.value || select?.value || '').trim();
        if (query) inspectLandlordTarget(query);
      }
    });
  }
}

function renderLandlordBuildingsTableHeaders() {
  const thead = document.querySelector('#table-landlord-buildings thead');
  if (!thead) return;

  const tr = document.createElement('tr');
  for (const col of LANDLORD_BUILDINGS_COLUMNS) {
    const th = document.createElement('th');
    if (col.isAction) {
      th.textContent = col.label;
    } else {
      th.className = 'sortable';
      if (landlordBldgsSortCol === col.key) {
        th.classList.add('sorted-active');
        const icon = landlordBldgsSortDir === 'asc' ? ' ▲' : (landlordBldgsSortDir === 'desc' ? ' ▼' : '');
        th.innerHTML = `${escapeHtml(col.label)}<span class="sort-indicator">${icon}</span>`;
      } else {
        th.textContent = col.label;
      }
      th.addEventListener('click', () => {
        if (landlordBldgsSortCol === col.key) {
          if (landlordBldgsSortDir === 'asc') landlordBldgsSortDir = 'desc';
          else if (landlordBldgsSortDir === 'desc') {
            landlordBldgsSortCol = null;
            landlordBldgsSortDir = null;
          } else landlordBldgsSortDir = 'asc';
        } else {
          landlordBldgsSortCol = col.key;
          landlordBldgsSortDir = 'asc';
        }
        renderLandlordBuildingsTableHeaders();
        renderLandlordBuildingsSubTable();
      });
    }
    tr.appendChild(th);
  }
  thead.innerHTML = '';
  thead.appendChild(tr);
}

function renderLandlordBuildingsSubTable() {
  const bldgsTbody = document.getElementById('table-landlord-buildings-body');
  if (!bldgsTbody) return;

  let list = [...currentLandlordOwnedBuildings];

  if (landlordBldgsSortCol && landlordBldgsSortDir) {
    const activeCol = LANDLORD_BUILDINGS_COLUMNS.find(c => c.key === landlordBldgsSortCol);
    if (activeCol) {
      list.sort((a, b) => compareBuildingRows(a, b, activeCol, landlordBldgsSortDir));
    }
  }

  bldgsTbody.innerHTML = '';
  if (list.length === 0) {
    bldgsTbody.innerHTML = `<tr><td colspan="${LANDLORD_BUILDINGS_COLUMNS.length}" style="text-align: center; color: var(--text-muted); padding: 1rem;">Aucun bâtiment lié directement dans le territoire actuellement chargé.</td></tr>`;
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const b of list) {
    const tr = document.createElement('tr');
    let rowHtml = '';
    for (const col of LANDLORD_BUILDINGS_COLUMNS) {
      rowHtml += `<td>${col.render(b)}</td>`;
    }
    tr.innerHTML = rowHtml;
    fragment.appendChild(tr);
  }
  bldgsTbody.appendChild(fragment);

  bldgsTbody.querySelectorAll('.btn-view-landlord-bldg').forEach(btn => {
    btn.addEventListener('click', () => {
      const bId = btn.getAttribute('data-bid');
      viewBuildingOnMap(bId);
    });
  });
}

async function inspectLandlordTarget(target) {
  const query = (target || '').trim();
  if (!query) return;

  const resultsDiv = document.getElementById('landlord-api-results');
  const compInfoDiv = document.getElementById('landlord-company-info');
  const dirigDiv = document.getElementById('landlord-dirigeants-info');
  const bldgsTbody = document.getElementById('table-landlord-buildings-body');

  if (!resultsDiv) return;
  resultsDiv.style.display = 'flex';
  lastInspectedLandlordTarget = query;

  renderLandlordBuildingsTableHeaders();

  const cacheKey = query.toUpperCase();
  const querySeq = ++currentLandlordQuerySeq;

  if (landlordApiCache.has(cacheKey)) {
    const cachedData = landlordApiCache.get(cacheKey);
    renderLandlordApiResults(cachedData, query);
    return;
  }

  compInfoDiv.innerHTML = '<span class="spinner" style="display:inline-block; width:14px; height:14px;"></span> Interrogation de l\'API Annuaire des Entreprises...';
  dirigDiv.innerHTML = '';
  bldgsTbody.innerHTML = '';

  try {
    const res = await fetch(`https://recherche-entreprises.api.gouv.fr/search?q=${encodeURIComponent(query)}&per_page=1`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    if (querySeq !== currentLandlordQuerySeq) return; // Stale response guard

    landlordApiCache.set(cacheKey, data);
    renderLandlordApiResults(data, query);
  } catch (err) {
    if (querySeq !== currentLandlordQuerySeq) return; // Stale response guard
    compInfoDiv.innerHTML = `<p style="color: #ef4444;">Erreur lors de la requête RNE : ${escapeHtml(err.message)}</p>`;
  }
}

function renderLandlordApiResults(data, query) {
  const compInfoDiv = document.getElementById('landlord-company-info');
  const dirigDiv = document.getElementById('landlord-dirigeants-info');

  if (!data.results || data.results.length === 0) {
    compInfoDiv.innerHTML = `<p style="color: #f59e0b;">Aucune entreprise trouvée au RNE pour « <strong>${escapeHtml(query)}</strong> ».</p>`;
    dirigDiv.innerHTML = '';
    currentLandlordOwnedBuildings = [];
    renderLandlordBuildingsSubTable();
    return;
  }

  const comp = data.results[0];
  const siren = comp.siren || query;
  const nom = comp.nom_complet || query;
  const siege = comp.siege?.adresse || 'Non renseignée';
  const activite = comp.libelle_activite_principale || comp.activite_principale || 'Non renseignée';
  const nature = comp.nature_juridique || '';

  compInfoDiv.innerHTML = `
    <div style="font-size: 0.95rem; font-weight: 700; color: #38bdf8; margin-bottom: 0.2rem;">
      🏛️ ${escapeHtml(nom)} <span style="font-size: 0.78rem; font-weight: 400; color: var(--text-secondary);">(<code>SIREN ${escapeHtml(siren)}</code>${nature ? ` · ${escapeHtml(nature)}` : ''})</span>
    </div>
    <div style="font-size: 0.77rem; color: var(--text-secondary); margin-bottom: 0.25rem; line-height: 1.4;">
      📍 Siège : ${escapeHtml(siege)} &bull; Activité : ${escapeHtml(activite)}
    </div>
    <div style="font-size: 0.76rem;">
      🔗 <a href="https://annuaire-entreprises.data.gouv.fr/entreprise/${escapeHtml(siren)}" target="_blank" style="color: var(--accent-primary); text-decoration: underline;">Annuaire des Entreprises (data.gouv.fr)</a>
      &nbsp;|&nbsp;
      <a href="https://www.pappers.fr/entreprise/${escapeHtml(siren)}" target="_blank" style="color: var(--accent-primary); text-decoration: underline;">Pappers</a>
    </div>
  `;

  const dirigeants = comp.dirigeants || [];
  if (dirigeants.length === 0) {
    dirigDiv.innerHTML = `
      <div style="font-weight: 700; font-size: 0.85rem; color: var(--text-primary); margin-bottom: 0.35rem;">👤 Dirigeants / Gérants déclarés (RNE / INSEE) :</div>
      <p style="font-size: 0.8rem; color: var(--text-muted); font-style: italic;">Aucun dirigeant listé en open data pour cette entité.</p>
    `;
  } else {
    let dHtml = `<div style="font-weight: 700; font-size: 0.85rem; color: var(--text-primary); margin-bottom: 0.35rem;">👤 Dirigeants / Gérants déclarés (RNE / INSEE) :</div><ul style="font-size: 0.8rem; line-height: 1.6; margin-left: 1.25rem;">`;
    for (const d of dirigeants.slice(0, 6)) {
      if (d.type_dirigeant === 'personne physique') {
        const prenom = d.prenoms || '';
        const nomDir = d.nom || '';
        const qualite = d.qualite || 'Dirigeant';
        const naiss = d.annee_de_naissance ? ` (né·e en ${d.annee_de_naissance})` : '';
        dHtml += `<li><strong>${escapeHtml(prenom)} ${escapeHtml(nomDir)}</strong>${naiss} — <em style="color: var(--text-secondary);">${escapeHtml(qualite)}</em></li>`;
      } else {
        const denomPm = d.denomination || 'Personne morale';
        const sirenPm = d.siren || '';
        const qualite = d.qualite || 'Personne morale dirigeante';
        dHtml += `<li>🏢 <strong>${escapeHtml(denomPm)}</strong> (<code>SIREN ${escapeHtml(sirenPm)}</code>) — <em style="color: var(--text-secondary);">${escapeHtml(qualite)}</em></li>`;
      }
    }
    dHtml += `</ul>`;
    dirigDiv.innerHTML = dHtml;
  }

  // Find all buildings owned by this landlord in the whole loaded territory (state.buildings)
  const ownedBIds = new Set();
  for (const o of state.owners) {
    if (siren && o.siren && String(o.siren).trim() === String(siren).trim()) {
      ownedBIds.add(o.batiment_groupe_id);
    } else if (nom && o.denomination && o.denomination.toLowerCase() === nom.toLowerCase()) {
      ownedBIds.add(o.batiment_groupe_id);
    }
  }

  currentLandlordOwnedBuildings = state.buildings.filter(b => ownedBIds.has(b.batiment_groupe_id));
  renderLandlordBuildingsSubTable();
}

/* ==========================================================================
   Tab 4: ZIP & Multi-format Export Logic
   ========================================================================== */
function updateExportTab() {
  const countEl = document.getElementById('export-tab-count');
  if (countEl) countEl.textContent = state.filteredBuildings.length.toLocaleString();
}

function initExportTabControls() {
  const btnZip = document.getElementById('btn-export-full-zip');
  const btnBldgs = document.getElementById('btn-export-tab-bldgs');
  const btnOwners = document.getElementById('btn-export-tab-owners');
  const btnGeojson = document.getElementById('btn-export-tab-geojson');

  if (btnZip) btnZip.addEventListener('click', exportFilteredFullZip);
  if (btnBldgs) btnBldgs.addEventListener('click', exportFilteredBuildingsExcel);
  if (btnOwners) btnOwners.addEventListener('click', exportFilteredOwnersExcel);
  if (btnGeojson) btnGeojson.addEventListener('click', exportFilteredGeoJSON);
}

async function exportFilteredFullZip() {
  if (state.filteredBuildings.length === 0) {
    alert("Aucun bâtiment dans la sélection à exporter.");
    return;
  }

  if (typeof JSZip === 'undefined') {
    alert("La librairie JSZip n'est pas encore disponible.");
    return;
  }

  showLoading("Génération de l'archive complète export_tezeloma.zip...");

  try {
    const zip = new JSZip();
    const dateStr = new Date().toISOString().slice(0, 10);

    // 1. Excel Bâtiments
    const bldgRows = state.filteredBuildings.map(b => {
      const copy = { ...b };
      delete copy.geometry;
      delete copy.render_color;
      return copy;
    });
    const wsBldgs = XLSX.utils.json_to_sheet(bldgRows);
    const wbBldgs = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wbBldgs, wsBldgs, 'Batiments_Filtres');
    const bldgArray = XLSX.write(wbBldgs, { bookType: 'xlsx', type: 'array' });
    zip.file('tableur_batiments_groupe.xlsx', bldgArray);

    // 2. Excel Bailleurs
    const bIdSet = new Set(state.filteredBuildings.map(b => b.batiment_groupe_id));
    const matchedOwners = state.owners.filter(o => bIdSet.has(o.batiment_groupe_id));
    const wsOwners = XLSX.utils.json_to_sheet(matchedOwners);
    const wbOwners = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wbOwners, wsOwners, 'Bailleurs_Filtres');
    const ownersArray = XLSX.write(wbOwners, { bookType: 'xlsx', type: 'array' });
    zip.file('tableur_proprietaires_detaille.xlsx', ownersArray);

    // 3. GeoJSON
    const features = state.filteredBuildings.map(b => ({
      type: 'Feature',
      geometry: b.geometry,
      properties: { ...b, geometry: undefined },
    }));
    const geojson = {
      type: 'FeatureCollection',
      name: 'TeZeLoMa_Export',
      crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:OGC:1.3:CRS84' } },
      features: features,
    };
    zip.file('carte_batiments.geojson', JSON.stringify(geojson, null, 2));

    // 4. README.txt
    const readmeContent = [
      `========================================================================`,
      `TeZeLoMa — Enquête Cartographique Foncier, Climat & Bailleurs`,
      `========================================================================`,
      `Date de génération : ${new Date().toLocaleString('fr-FR')}`,
      `Bâtiments exportés : ${state.filteredBuildings.length.toLocaleString()}`,
      `Bailleurs moraux    : ${matchedOwners.length.toLocaleString()}`,
      `Territoire actif    : Mode ${state.activeTerritory.mode} (${state.activeTerritory.dep || state.activeTerritory.cp || state.activeTerritory.range?.join('-')})`,
      ``,
      `Contenu de cette archive :`,
      `1. tableur_batiments_groupe.xlsx :`,
      `   Tableau complet des bâtiments sélectionnés avec diagnostic DPE, score et facteurs`,
      `   de surchauffe d'été, îlots de chaleur, encadrement des loyers, concentration foncière.`,
      `2. tableur_proprietaires_detaille.xlsx :`,
      `   1 ligne par couple (bâtiment × propriétaire personne morale) avec SIREN, forme juridique`,
      `   et locaux possédés.`,
      `3. carte_batiments.geojson :`,
      `   Couche cartographique prête à être importée directement dans Framacarte, uMap ou QGIS.`,
      ``,
      `Sources consolidées : BDNB (CSTB), ADEME, IGN, DGFiP MAJIC, Data Grand Lyon, Cerema.`,
      `========================================================================`,
    ].join('\n');
    zip.file('README.txt', readmeContent);

    // Generate zip blob
    const content = await zip.generateAsync({
      type: 'blob',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
    });

    const url = URL.createObjectURL(content);
    const a = document.createElement('a');
    a.href = url;
    a.download = `export_tezeloma_${dateStr}.zip`;
    a.click();
    URL.revokeObjectURL(url);

  } catch (err) {
    console.error('Error generating full zip export:', err);
    alert(`Erreur lors de la génération du ZIP: ${err.message}`);
  } finally {
    hideLoading();
  }
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* ==========================================================================
   Address Geocoding Search (BAN API)
   ========================================================================== */
function initAddressSearch() {
  const input = document.getElementById('input-address-search');
  let debounceTimeout = null;

  input.addEventListener('input', (e) => {
    clearTimeout(debounceTimeout);
    const q = e.target.value.trim();
    if (q.length < 4) return;

    debounceTimeout = setTimeout(async () => {
      try {
        const res = await fetch(`https://api-adresse.data.gouv.fr/search/?q=${encodeURIComponent(q)}&limit=1`);
        if (!res.ok) return;
        const data = await res.json();
        if (data.features && data.features.length > 0) {
          const [lon, lat] = data.features[0].geometry.coordinates;
          state.map.flyTo({ center: [lon, lat], zoom: 17, essential: true });
        }
      } catch (err) {
        console.warn('Geocoding error:', err);
      }
    }, 400);
  });
}

/* ==========================================================================
   UI Event Listeners
   ========================================================================== */
function initEventListeners() {
  // Territory mode tabs
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const mode = btn.getAttribute('data-mode');
      state.activeTerritory.mode = mode;

      document.getElementById('tab-dep').style.display = mode === 'dep' ? 'block' : 'none';
      document.getElementById('tab-cp').style.display = mode === 'cp' ? 'block' : 'none';
      document.getElementById('tab-range').style.display = mode === 'range' ? 'block' : 'none';
    });
  });

  // Territory Load Button
  document.getElementById('btn-load-territory').addEventListener('click', () => {
    const mode = state.activeTerritory.mode;
    if (mode === 'dep') {
      state.activeTerritory.dep = document.getElementById('select-dept').value;
    } else if (mode === 'cp') {
      const val = parseInt(document.getElementById('select-cp').value, 10);
      if (!val) { alert("Veuillez sélectionner un code postal."); return; }
      state.activeTerritory.cp = val;
    } else if (mode === 'range') {
      const start = parseInt(document.getElementById('input-range-start').value, 10);
      const end = parseInt(document.getElementById('input-range-end').value, 10);
      if (!start || !end || start > end) { alert("Veuillez entrer une plage de codes postaux valide (ex: 69001 à 69009)."); return; }
      state.activeTerritory.range = [start, end];
    }
    loadTerritory();
  });

  // DPE Filter Pills
  document.querySelectorAll('#filter-dpe .pill-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const dpe = btn.getAttribute('data-dpe');
      if (state.selectedDpes.has(dpe)) {
        state.selectedDpes.delete(dpe);
        btn.classList.remove('active');
      } else {
        state.selectedDpes.add(dpe);
        btn.classList.add('active');
      }
      applyFilters();
    });
  });

  // Overheating Pills
  document.querySelectorAll('#filter-overheating .pill-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const val = btn.getAttribute('data-val');
      if (state.selectedOverheating.has(val)) {
        state.selectedOverheating.delete(val);
        btn.classList.remove('active');
      } else {
        state.selectedOverheating.add(val);
        btn.classList.add('active');
      }
      applyFilters();
    });
  });

  // Legal Mode toggle (Inclusif <-> Exclusif)
  const legalModeLabel = document.getElementById('label-legal-mode');
  if (legalModeLabel) {
    legalModeLabel.addEventListener('click', () => {
      state.legalMode = state.legalMode === 'inclusif' ? 'exclusif' : 'inclusif';
      legalModeLabel.textContent = state.legalMode === 'inclusif' ? 'Mode Inclusif ⇄' : 'Mode Exclusif ⇄';
      applyFilters();
    });
  }

  // Legal Pills
  document.querySelectorAll('#filter-legal .pill-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const val = btn.getAttribute('data-val');
      if (state.selectedLegal.has(val)) {
        state.selectedLegal.delete(val);
        btn.classList.remove('active');
      } else {
        state.selectedLegal.add(val);
        btn.classList.add('active');
      }
      applyFilters();
    });
  });

  // Sliders
  const pctFgSlider = document.getElementById('filter-pct-fg');
  pctFgSlider.addEventListener('input', (e) => {
    state.minPctFg = parseInt(e.target.value, 10);
    document.getElementById('label-pct-fg').textContent = `${state.minPctFg}%`;
    applyFilters();
  });

  const concSlider = document.getElementById('filter-concentration');
  concSlider.addEventListener('input', (e) => {
    state.minConcentration = parseInt(e.target.value, 10);
    document.getElementById('label-concentration').textContent = `≥ ${state.minConcentration}%`;
    applyFilters();
  });

  const minLogSlider = document.getElementById('filter-min-log');
  minLogSlider.addEventListener('input', (e) => {
    state.minLog = parseInt(e.target.value, 10);
    document.getElementById('label-min-log').textContent = `≥ ${state.minLog}`;
    applyFilters();
  });

  // Map Style Mode buttons & Select
  const colorSelect = document.getElementById('select-color-mode');
  if (colorSelect) {
    colorSelect.addEventListener('change', (e) => {
      state.mapStyleMode = e.target.value;
      document.querySelectorAll('.map-style-btn').forEach(b => {
        b.classList.toggle('active', b.getAttribute('data-style') === state.mapStyleMode);
      });
      updateLegend();
      applyFilters();
    });
  }

  document.querySelectorAll('.map-style-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.map-style-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.mapStyleMode = btn.getAttribute('data-style');
      if (colorSelect) colorSelect.value = state.mapStyleMode;
      updateLegend();
      applyFilters();
    });
  });

  // Background Dimming Slider
  const bgDimSlider = document.getElementById('slider-bg-dim');
  if (bgDimSlider) {
    bgDimSlider.addEventListener('input', (e) => {
      state.bgDimPct = parseInt(e.target.value, 10);
      document.getElementById('label-bg-dim').textContent = `${state.bgDimPct}%`;
      setMapDim(state.bgDimPct);
    });
  }

  // Max Polygons Select
  const maxPolySelect = document.getElementById('select-max-polygons');
  if (maxPolySelect) {
    maxPolySelect.addEventListener('change', (e) => {
      state.maxPolygons = parseInt(e.target.value, 10);
      applyFilters();
    });
  }

  // Roof & Shutters Checkboxes
  const roofChk = document.getElementById('filter-roof-uninsulated');
  if (roofChk) {
    roofChk.addEventListener('change', (e) => {
      state.onlyUninsulatedRoof = e.target.checked;
      applyFilters();
    });
  }

  const shuttersChk = document.getElementById('filter-no-shutters');
  if (shuttersChk) {
    shuttersChk.addEventListener('change', (e) => {
      state.onlyNoShutters = e.target.checked;
      applyFilters();
    });
  }

  // Score Overheat Slider
  const scoreOverheatSlider = document.getElementById('filter-score-overheat');
  if (scoreOverheatSlider) {
    scoreOverheatSlider.addEventListener('input', (e) => {
      state.minOverheatScore = parseInt(e.target.value, 10);
      document.getElementById('label-min-score-overheat').textContent = `≥ ${state.minOverheatScore}`;
      applyFilters();
    });
  }

  // Owner search text input
  let searchTimeout = null;
  const ownerSearchInput = document.getElementById('filter-owner-search');
  if (ownerSearchInput) {
    ownerSearchInput.addEventListener('input', (e) => {
      clearTimeout(searchTimeout);
      searchTimeout = setTimeout(() => {
        state.ownerSearchText = e.target.value;
        applyFilters();
      }, 250);
    });
  }

  // Min Patrimoine Input
  const patrimoineInput = document.getElementById('filter-min-patrimoine');
  if (patrimoineInput) {
    patrimoineInput.addEventListener('input', (e) => {
      state.minPatrimoine = parseInt(e.target.value, 10) || 0;
      applyFilters();
    });
  }

  // Urbanisme & Social Checkboxes
  const qpvChk = document.getElementById('filter-qpv');
  if (qpvChk) {
    qpvChk.addEventListener('change', (e) => {
      state.filterQpv = e.target.checked;
      applyFilters();
    });
  }

  const socialOnlyChk = document.getElementById('filter-social-only');
  if (socialOnlyChk) {
    socialOnlyChk.addEventListener('change', (e) => {
      state.filterSocialOnly = e.target.checked;
      if (state.filterSocialOnly && excludeSocialChk) {
        excludeSocialChk.checked = false;
        state.filterExcludeSocial = false;
      }
      applyFilters();
    });
  }

  const excludeSocialChk = document.getElementById('filter-exclude-social');
  if (excludeSocialChk) {
    excludeSocialChk.addEventListener('change', (e) => {
      state.filterExcludeSocial = e.target.checked;
      if (state.filterExcludeSocial && socialOnlyChk) {
        socialOnlyChk.checked = false;
        state.filterSocialOnly = false;
      }
      applyFilters();
    });
  }

  const rentControlChk = document.getElementById('filter-rent-control');
  if (rentControlChk) {
    rentControlChk.addEventListener('change', (e) => {
      state.filterRentControl = e.target.checked;
      applyFilters();
    });
  }

  // Reset Filters Button
  document.getElementById('btn-reset-filters').addEventListener('click', () => {
    state.selectedDpes = new Set(['F', 'G']);
    state.selectedOverheating = new Set(['Critique', 'Élevé', 'Modéré', 'Faible', 'Non renseigné']);
    state.selectedLegal = new Set(['SCI', 'Bailleur social', 'Société commerciale', 'Personne physique']);
    state.legalMode = 'inclusif';
    if (legalModeLabel) legalModeLabel.textContent = 'Mode Inclusif ⇄';
    state.minPctFg = 0;
    state.minConcentration = 0;
    state.minLog = 1;
    state.onlyUninsulatedRoof = false;
    state.onlyNoShutters = false;
    state.minOverheatScore = 0;
    state.ownerSearchText = '';
    state.minPatrimoine = 0;
    state.filterQpv = false;
    state.filterSocialOnly = false;
    state.filterExcludeSocial = false;
    state.filterRentControl = false;

    pctFgSlider.value = 0;
    concSlider.value = 0;
    minLogSlider.value = 1;
    if (roofChk) roofChk.checked = false;
    if (shuttersChk) shuttersChk.checked = false;
    if (qpvChk) qpvChk.checked = false;
    if (socialOnlyChk) socialOnlyChk.checked = false;
    if (excludeSocialChk) excludeSocialChk.checked = false;
    if (rentControlChk) rentControlChk.checked = false;
    if (scoreOverheatSlider) scoreOverheatSlider.value = 0;
    if (ownerSearchInput) ownerSearchInput.value = '';
    if (patrimoineInput) patrimoineInput.value = 0;

    document.getElementById('label-min-score-overheat').textContent = '≥ 0';
    document.querySelectorAll('#filter-dpe .pill-btn').forEach(btn => {
      const d = btn.getAttribute('data-dpe');
      btn.classList.toggle('active', d === 'F' || d === 'G');
    });
    document.querySelectorAll('#filter-overheating .pill-btn').forEach(btn => btn.classList.add('active'));
    document.querySelectorAll('#filter-legal .pill-btn').forEach(btn => btn.classList.add('active'));

    applyFilters();
  });

  // Drawer Close Button
  document.getElementById('btn-close-drawer').addEventListener('click', () => {
    document.getElementById('building-drawer').classList.remove('open');
    if (state.map) {
      state.map.setFilter('buildings-selected', ['==', ['get', 'batiment_groupe_id'], '']);
    }
  });

  // Modals
  document.getElementById('btn-open-territory-manager').addEventListener('click', () => {
    document.getElementById('modal-territory').classList.add('open');
  });
  document.getElementById('btn-close-territory-modal').addEventListener('click', () => {
    document.getElementById('modal-territory').classList.remove('open');
  });
  document.getElementById('btn-close-territory-footer').addEventListener('click', () => {
    document.getElementById('modal-territory').classList.remove('open');
  });

  const btnOpenExport = document.getElementById('btn-open-export');
  if (btnOpenExport) {
    btnOpenExport.addEventListener('click', () => {
      document.getElementById('modal-export').classList.add('open');
    });
  }
  const btnCloseExportModal = document.getElementById('btn-close-export-modal');
  if (btnCloseExportModal) {
    btnCloseExportModal.addEventListener('click', () => {
      document.getElementById('modal-export').classList.remove('open');
    });
  }
  const btnCloseExportFooter = document.getElementById('btn-close-export-footer');
  if (btnCloseExportFooter) {
    btnCloseExportFooter.addEventListener('click', () => {
      document.getElementById('modal-export').classList.remove('open');
    });
  }

  // Export actions
  const btnExportBldgs = document.getElementById('btn-export-buildings-excel');
  if (btnExportBldgs) btnExportBldgs.addEventListener('click', exportFilteredBuildingsExcel);
  const btnExportOwners = document.getElementById('btn-export-owners-excel');
  if (btnExportOwners) btnExportOwners.addEventListener('click', exportFilteredOwnersExcel);
  const btnExportGeo = document.getElementById('btn-export-geojson');
  if (btnExportGeo) btnExportGeo.addEventListener('click', exportFilteredGeoJSON);

  // Data Base URL Configuration
  const inputBaseUrl = document.getElementById('input-data-base-url');
  document.getElementById('btn-save-data-url').addEventListener('click', async () => {
    let url = inputBaseUrl.value.trim();
    if (!url.endsWith('/')) url += '/';
    state.dataBaseUrl = url;
    await loadManifest();
    await loadTerritory();
    alert(`Source de données mise à jour: ${url}`);
  });

  document.getElementById('link-source-local').addEventListener('click', (e) => {
    e.preventDefault();
    inputBaseUrl.value = '../../data/chunks/';
    document.getElementById('btn-save-data-url').click();
  });

  document.getElementById('link-source-github').addEventListener('click', (e) => {
    e.preventDefault();
    inputBaseUrl.value = 'https://raw.githubusercontent.com/sebastienbrg/building_mapper/data-release/data/chunks/';
    document.getElementById('btn-save-data-url').click();
  });

  // Clear Cache Button
  document.getElementById('btn-clear-cache').addEventListener('click', async () => {
    if ('caches' in window) {
      await caches.delete('tezeloma-data-v1');
      alert("Le cache local des chunks Parquet a été vidé avec succès.");
    }
  });

  initFieldworkDropzone();
  initAddressSearch();
}

function closeAllModals() {
  document.querySelectorAll('.modal-overlay').forEach(m => m.classList.remove('open'));
}

function showLoading(msg) {
  const el = document.getElementById('loading-indicator');
  if (el) {
    document.getElementById('loading-text').textContent = msg || 'Chargement...';
    el.classList.add('active');
  }
}

function hideLoading() {
  const el = document.getElementById('loading-indicator');
  if (el) el.classList.remove('active');
}
