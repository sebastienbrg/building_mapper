/**
 * TeZeLoMa — Standalone Static Web App Logic
 * ==========================================
 * Zero-server, zero-Streamlit investigative cartography for thermal slums,
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
  selectedOverheating: new Set(['Élevé', 'Modéré', 'Faible']),
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
  'Élevé': '#ef4444',
  'Modéré': '#f59e0b',
  'Faible': '#38bdf8',
  'Inconnu': '#64748b',
};

/* ==========================================================================
   Initialization
   ========================================================================== */
document.addEventListener('DOMContentLoaded', async () => {
  initMap();
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
      alert("Impossible de charger manifest.json. Assurez-vous d'avoir exécuté proto/chunk_dataset.py.");
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
    const risk = b.risque_surchauffe_ete || 'Faible';
    if (!selectedOverheating.has(risk)) continue;

    // 3b. Overheating score min
    if (minOverheatScore > 0 && Number(b.score_surchauffe_ete || 0) < minOverheatScore) continue;

    // 3c. Uninsulated roof
    if (onlyUninsulatedRoof) {
      const roof = String(b.type_isolation_plancher_haut || '').toLowerCase();
      if (roof && roof !== 'non isole' && roof !== 'nc') continue;
    }

    // 3d. No shutters
    if (onlyNoShutters) {
      const shutters = String(b.type_fermeture || '').toLowerCase();
      if (shutters.includes('volet') || shutters.includes('persienne') || shutters.includes('jalousie')) continue;
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
      let hasMatch = false;
      for (const leg of selectedLegal) {
        if (bLegals.includes(leg)) {
          hasMatch = true;
          break;
        }
      }
      if (!hasMatch) continue;
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
    if (b.risque_surchauffe_ete === 'Élevé') highOverheatCount++;
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
      <div class="legend-item"><span class="legend-color" style="background: #ef4444;"></span><span>Élevé 🔥</span></div>
      <div class="legend-item"><span class="legend-color" style="background: #f59e0b;"></span><span>Modéré</span></div>
      <div class="legend-item"><span class="legend-color" style="background: #38bdf8;"></span><span>Faible</span></div>
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
    state.selectedOverheating = new Set(['Élevé', 'Modéré', 'Faible']);
    state.selectedLegal = new Set(['SCI', 'Bailleur social', 'Société commerciale', 'Personne physique']);
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

  document.getElementById('btn-open-export').addEventListener('click', () => {
    document.getElementById('modal-export').classList.add('open');
  });
  document.getElementById('btn-close-export-modal').addEventListener('click', () => {
    document.getElementById('modal-export').classList.remove('open');
  });
  document.getElementById('btn-close-export-footer').addEventListener('click', () => {
    document.getElementById('modal-export').classList.remove('open');
  });

  // Export actions
  document.getElementById('btn-export-buildings-excel').addEventListener('click', exportFilteredBuildingsExcel);
  document.getElementById('btn-export-owners-excel').addEventListener('click', exportFilteredOwnersExcel);
  document.getElementById('btn-export-geojson').addEventListener('click', exportFilteredGeoJSON);

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
    inputBaseUrl.value = 'https://raw.githubusercontent.com/sebastienbrg/tezeloma-assessment/data-release/data/chunks/';
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
