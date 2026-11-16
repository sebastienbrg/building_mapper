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
const DEP_DISPLAY = { '69': '69 — Rhône (Lyon)', '38': '38 — Isère (Grenoble)', '44': '44 — Loire-Atlantique (Nantes)', '76': '76 — Seine-Maritime (Rouen)', '34': '34 — Hérault (Montpellier)' };
const DEP_SHORT = { '69': 'Rhône (69)', '38': 'Isère (38)', '44': 'Loire-Atlantique (44)', '76': 'Seine-Maritime (76)', '34': 'Hérault (34)' };
const DEP_CONTEXT = { '69': 'Rhône (Lyon & Métropole)', '38': 'Isère (Grenoble & Métropole)', '44': 'Loire-Atlantique (Nantes)', '76': 'Seine-Maritime (Rouen)', '34': 'Hérault (Montpellier)' };
const state = {
  manifest: null,
  activeTerritory: { mode: 'chunks', chunkIds: [], dep: '69', cp: null, range: [69001, 69009] },
  territorySelectionMode: true,
  postalZonesGeoJson: null,
  pendingSelectedChunks: new Set(),
  locallyCachedChunkIds: new Set(),
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
  // Sociological Filter Catalog & Profiles State
  activeProfileId: 'essential',
  activeFilterIds: new Set([
    'dpe', 'pct_dpe_fg', 'nb_log', 'risque_surchauffe_ete',
    'owner_search', 'legal_category', 'concentration_pct', 'min_patrimoine_majic'
  ]),
  customProfiles: [],
  catalogCategoryFilter: 'all',
  catalogSearchQuery: '',
  dynFilters: {},       // filterId -> value state for extended catalog filters
  fieldworkFilters: {}, // customCol -> text/value filter
  map: null,
  selectedBuildingId: null,
  searchedAddressMarkers: [],
  activeTab: 'map',
  openTool: null,
  dataBaseUrl: '../../data/chunks/', // Local default, can be switched to GitHub Releases URL
};
if (typeof window !== 'undefined') {
  window.appState = state;
}

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
   Sociological & Social-Work Filter Categorization & Catalog (55 Indicators)
   ========================================================================== */
const SOCIOLOGICAL_CATEGORIES = [
  {
    id: 'winter',
    icon: '🌡️',
    shortLabel: '1. Précarité Hiver & Factures',
    title: '1. Précarité Énergétique d\'Hiver & Poids des Factures',
    desc: 'Identifier les ménages exposés au froid, aux impayés d\'énergie (« chauffer à l\'électricité ou au fioul dans une passoire ») et aux interdictions légales de louer (DPE G en 2025, F en 2028, E en 2034).',
  },
  {
    id: 'summer',
    icon: '☀️',
    shortLabel: '2. Canicule & Surchauffe Été',
    title: '2. Vulnérabilité Climatique & Surchauffe d\'Été (« Bouilloires »)',
    desc: 'Protéger les publics fragiles face aux canicules en croisant les défauts de l\'enveloppe (combles non isolés, absence de volets, non-traversant, sans balcon) et l\'îlot de chaleur nocturne (ICU).',
  },
  {
    id: 'landlords',
    icon: '🏛️',
    shortLabel: '3. Propriétaires & Rapports de Force',
    title: '3. Structure de Propriété, Multipropriété & Rapports de Force',
    desc: 'Adapter la stratégie d\'accompagnement ou syndicale selon le bailleur : SCI opaque, société foncière, bailleur social, multipropriétaire détenant tout l\'immeuble ou bailleur hors territoire.',
  },
  {
    id: 'social',
    icon: '⚖️',
    shortLabel: '4. Justice Sociale, Loyers & Marché',
    title: '4. Justice Sociale, Loyers, Parc Social & Spéculation',
    desc: 'Croiser les vulnérabilités avec la géographie prioritaire (QPV), le parc social (RPLS, accessibilité PMR), le plafonnement légal des loyers et la pression spéculative du marché (DVF).',
  },
  {
    id: 'copro',
    icon: '🏢',
    shortLabel: '5. Copros, Salubrité & Habitat Indigne',
    title: '5. Copropriétés, Salubrité & Qualité de l\'Habitat',
    desc: 'Repérer les signes techniques d\'habitat dégradé (simple vitrage, absence de VMC causant moisissures, micro-logements/studios) et comprendre la gouvernance de copropriété (RNIC).',
  },
  {
    id: 'morphology',
    icon: '🏗️',
    shortLabel: '6. Morphologie, Époque & Risques',
    title: '6. Morphologie Urbaine, Époque & Risques Sanitaires / ABF',
    desc: 'Cibler par taille de collectif (porte-à-porte), hauteur, époque constructive (avant 1948, Trente Glorieuses 1948-1974), contraintes Monument Historique (ABF), Radon et réseaux de chaleur.',
  },
  {
    id: 'geography',
    icon: '📍',
    shortLabel: '7. Géographie Fine & Terrain (.xlsx)',
    title: '7. Géographie Fine, Quartiers IRIS & Enquête de Terrain (.xlsx)',
    desc: 'Filtrer par commune/arrondissement, îlot statistique INSEE (IRIS), nom de rue, ou statut de visite dans votre tableur militant (.xlsx).',
  },
];

const BUILTIN_PROFILES = [
  {
    id: 'essential',
    icon: '🔥',
    name: 'Essentiel Militant',
    desc: 'Sélection rapide quotidienne : passoires DPE F/G, taille d\'immeuble, risque surchauffe été et concentration bailleur.',
    mapStyleMode: 'dpe',
    filterIds: [
      'dpe', 'pct_dpe_fg', 'nb_log', 'risque_surchauffe_ete',
      'owner_search', 'legal_category', 'concentration_pct', 'min_patrimoine_majic'
    ],
  },
  {
    id: 'winter_poverty',
    icon: '❄️',
    name: 'Précarité Hiver & Factures',
    desc: 'Focus travail social & impayés d\'énergie : passoires G (interdites 2025) et F, chauffage électrique/fioul, consommations réelles Enedis/GRDF, simple vitrage et opposabilité DPE 2021.',
    mapStyleMode: 'dpe',
    filterIds: [
      'dpe', 'pct_dpe_g', 'pct_dpe_fg', 'type_energie_chauffage', 'type_installation_chauffage',
      'conso_elec_res_par_pdl_kwh', 'conso_ep_m2', 'type_vitrage', 'surface_habitable_logement', 'dpe_arrete_2021'
    ],
  },
  {
    id: 'summer_heat',
    icon: '☀️',
    name: 'Canicule & Bouilloires Été',
    desc: 'Focus santé publique & canicule : score et risque de surchauffe, îlot de chaleur nocturne (ICU), combles non isolés, absence de volets, non-traversant, inertie et absence de balcon.',
    mapStyleMode: 'overheating',
    filterIds: [
      'risque_surchauffe_ete', 'score_surchauffe_ete', 'icu_expo_nuit', 'icu_vulnerabilite_nuit',
      'type_isolation_plancher_haut', 'type_fermeture', 'traversant', 'classe_inertie', 'presence_balcon', 'has_clim'
    ],
  },
  {
    id: 'landlords_sci',
    icon: '🦈',
    name: 'Multipropriétaires & SCI',
    desc: 'Focus sociologie urbaine & action syndicale : recherche bailleur/SIREN, SCI & sociétés commerciales, concentration foncière, patrimoine MAJIC, bailleurs distants et ventes DVF.',
    mapStyleMode: 'concentration',
    filterIds: [
      'owner_search', 'legal_category', 'forme_juridique_principale', 'concentration_pct',
      'max_locaux_un_prop', 'min_patrimoine_majic', 'nb_proprietaires_open', 'bailleur_distant', 'dvf_nb_mutations'
    ],
  },
  {
    id: 'social_worker',
    icon: '⚖️',
    name: 'Travail Social, Loyers & QPV',
    desc: 'Focus accès aux droits & accompagnement social : Quartiers Prioritaires (QPV), parc social (RPLS) vs privé, accessibilité PMR/handicap, encadrement des loyers (plafonds T2) et prix DVF.',
    mapStyleMode: 'dpe',
    filterIds: [
      'qpv_mode', 'quartier_qpv_select', 'social_rpls_mode', 'nb_log_sociaux_rpls',
      'pmr_rpls_mode', 'rent_control_mode', 'zone_encadrement_loyers', 'loyer_max_t2_nm', 'dvf_prix_m2_median', 'dpe'
    ],
  },
  {
    id: 'degraded_copro',
    icon: '🏚️',
    name: 'Copros Fragiles & Insalubrité',
    desc: 'Focus habitat dégradé & santé respiratoire : copropriétés RNIC, simple vitrage, absence de VMC (humidité/moisissures), murs/caves non isolés, époque constructive, radon et ABF.',
    mapStyleMode: 'dpe',
    filterIds: [
      'copro_status', 'copro_search', 'nb_lots_copro', 'type_vitrage', 'type_ventilation',
      'type_isolation_mur_exterieur', 'type_isolation_plancher_bas', 'periode_construction_dpe', 'patrimoine_abf', 'alea_radon'
    ],
  },
  {
    id: 'complete',
    icon: '🔬',
    name: 'Tous les filtres (69)',
    desc: 'Affiche l\'intégralité des 69 indicateurs sociologiques, climatiques, fonciers et techniques.',
    mapStyleMode: 'dpe',
    filterIds: [], // populated dynamically with all FILTER_DEFINITIONS ids
  },
];

const CUSTOM_PROFILES_STORAGE_KEY = 'tezeloma_custom_profiles_v1';
const SESSION_STORAGE_KEY = 'tezeloma_session_state_v1';

const FILTER_DEFINITIONS = [
  /* ========================================================================
     1. PRÉCARITÉ ÉNERGÉTIQUE D'HIVER & POIDS DES FACTURES (15 indicateurs)
     ======================================================================== */
  {
    id: 'dpe',
    category: 'winter',
    label: 'Étiquette DPE globale de l\'immeuble',
    column: 'dpe',
    source: 'ADEME / BDNB',
    desc: 'Classe de performance énergétique représentative (A à G). Loi Climat & Résilience : interdiction de louer les G en 2025, F en 2028, E en 2034.',
    controlType: 'dpe_pills',
    options: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'Inconnu'],
    isActive: (s) => s.selectedDpes.size < 8,
    reset: (s) => { s.selectedDpes = new Set(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'Inconnu']); },
    getValue: (s) => Array.from(s.selectedDpes),
    setValue: (s, v) => { if (Array.isArray(v)) s.selectedDpes = new Set(v); },
    matches: (s, b) => s.selectedDpes.has(b.dpe || 'Inconnu'),
  },
  {
    id: 'pct_dpe_fg',
    category: 'winter',
    label: '% de passoires thermiques (DPE F ou G)',
    column: 'pct_dpe_fg',
    source: 'ADEME DPE par lot',
    desc: 'Proportion de logements diagnostiqués F ou G au sein du bâtiment.',
    controlType: 'slider',
    min: 0, max: 100, step: 5, unit: '%',
    isActive: (s) => Number(s.minPctFg || 0) > 0,
    reset: (s) => { s.minPctFg = 0; },
    getValue: (s) => s.minPctFg || 0,
    setValue: (s, v) => { s.minPctFg = Number(v || 0); },
    matches: (s, b) => Number(b.pct_dpe_fg || 0) >= Number(s.minPctFg || 0),
  },
  {
    id: 'nb_dpe_fg',
    category: 'winter',
    label: 'Nombre min. de logements F ou G dans l\'immeuble',
    column: 'nb_dpe_fg',
    source: 'ADEME DPE par lot',
    desc: 'Cibler les grands gisements de passoires thermiques pour des actions collectives ou du porte-à-porte.',
    controlType: 'number_min',
    min: 0, max: 500, step: 1, placeholder: 'Ex: 5 logements F/G',
    isActive: (s) => Number(s.dynFilters.nb_dpe_fg || 0) > 0,
    reset: (s) => { delete s.dynFilters.nb_dpe_fg; },
    getValue: (s) => s.dynFilters.nb_dpe_fg || 0,
    setValue: (s, v) => { s.dynFilters.nb_dpe_fg = Number(v || 0); },
    matches: (s, b) => Number(b.nb_dpe_fg || 0) >= Number(s.dynFilters.nb_dpe_fg || 0),
  },
  {
    id: 'pct_dpe_g',
    category: 'winter',
    label: '% de logements classés G (Interdits à la location 2025)',
    column: 'pct_dpe_g',
    source: 'ADEME DPE par lot',
    desc: 'Part des logements qualifiés d\'indécents énergétiques depuis le 1er janvier 2025 (recours locataire en baisse de loyer / travaux).',
    controlType: 'slider',
    min: 0, max: 100, step: 5, unit: '%',
    isActive: (s) => Number(s.dynFilters.pct_dpe_g || 0) > 0,
    reset: (s) => { delete s.dynFilters.pct_dpe_g; },
    getValue: (s) => s.dynFilters.pct_dpe_g || 0,
    setValue: (s, v) => { s.dynFilters.pct_dpe_g = Number(v || 0); },
    matches: (s, b) => Number(b.pct_dpe_g || 0) >= Number(s.dynFilters.pct_dpe_g || 0),
  },
  {
    id: 'pct_dpe_f',
    category: 'winter',
    label: '% de logements classés F (Interdits à la location 2028)',
    column: 'pct_dpe_f',
    source: 'ADEME DPE par lot',
    desc: 'Part des logements F dont le loyer est gelé (interdiction d\'indexation IRL) et qui seront interdits à la location en 2028.',
    controlType: 'slider',
    min: 0, max: 100, step: 5, unit: '%',
    isActive: (s) => Number(s.dynFilters.pct_dpe_f || 0) > 0,
    reset: (s) => { delete s.dynFilters.pct_dpe_f; },
    getValue: (s) => s.dynFilters.pct_dpe_f || 0,
    setValue: (s, v) => { s.dynFilters.pct_dpe_f = Number(v || 0); },
    matches: (s, b) => Number(b.pct_dpe_f || 0) >= Number(s.dynFilters.pct_dpe_f || 0),
  },
  {
    id: 'pct_dpe_e',
    category: 'winter',
    label: '% de logements classés E (Échéance 2034)',
    column: 'pct_dpe_e',
    source: 'ADEME DPE par lot',
    desc: 'Part des logements E vulnérables à la hausse des prix de l\'énergie et visés par l\'échéance de décence 2034.',
    controlType: 'slider',
    min: 0, max: 100, step: 5, unit: '%',
    isActive: (s) => Number(s.dynFilters.pct_dpe_e || 0) > 0,
    reset: (s) => { delete s.dynFilters.pct_dpe_e; },
    getValue: (s) => s.dynFilters.pct_dpe_e || 0,
    setValue: (s, v) => { s.dynFilters.pct_dpe_e = Number(v || 0); },
    matches: (s, b) => Number(b.pct_dpe_e || 0) >= Number(s.dynFilters.pct_dpe_e || 0),
  },
  {
    id: 'pct_dpe_inconnu',
    category: 'winter',
    label: '% de logements sans DPE connu (Angle mort)',
    column: 'pct_dpe_inconnu',
    source: 'BDNB / ADEME',
    desc: 'Repérer les immeubles où aucun diagnostic officiel n\'a été déposé à l\'ADEME (souvent loués sans DPE ou occupés de longue date).',
    controlType: 'slider',
    min: 0, max: 100, step: 10, unit: '%',
    isActive: (s) => Number(s.dynFilters.pct_dpe_inconnu || 0) > 0,
    reset: (s) => { delete s.dynFilters.pct_dpe_inconnu; },
    getValue: (s) => s.dynFilters.pct_dpe_inconnu || 0,
    setValue: (s, v) => { s.dynFilters.pct_dpe_inconnu = Number(v || 0); },
    matches: (s, b) => Number(b.pct_dpe_inconnu || 0) >= Number(s.dynFilters.pct_dpe_inconnu || 0),
  },
  {
    id: 'classe_ges',
    category: 'winter',
    label: 'Classe d\'émissions de Gaz à Effet de Serre (GES)',
    column: 'classe_ges',
    source: 'ADEME DPE',
    desc: 'Étiquette climat (A à G) reflétant l\'usage d\'énergies fossiles (fioul, gaz) à fort impact carbone.',
    controlType: 'select',
    options: [
      { value: '', label: 'Toutes les classes GES' },
      { value: 'FG', label: 'Passoires climatiques (GES F ou G)' },
      { value: 'G', label: 'Classe GES G uniquement' },
      { value: 'F', label: 'Classe GES F uniquement' },
      { value: 'E', label: 'Classe GES E ou pire (E, F, G)' },
      { value: 'ABC', label: 'Bas carbone (GES A, B ou C)' },
    ],
    isActive: (s) => Boolean(s.dynFilters.classe_ges),
    reset: (s) => { delete s.dynFilters.classe_ges; },
    getValue: (s) => s.dynFilters.classe_ges || '',
    setValue: (s, v) => { s.dynFilters.classe_ges = v || ''; },
    matches: (s, b) => {
      const val = s.dynFilters.classe_ges;
      if (!val) return true;
      const g = String(b.classe_ges || '').toUpperCase();
      if (val === 'FG') return g === 'F' || g === 'G';
      if (val === 'E') return g === 'E' || g === 'F' || g === 'G';
      if (val === 'ABC') return g === 'A' || g === 'B' || g === 'C';
      return g === val;
    },
  },
  {
    id: 'conso_ep_m2',
    category: 'winter',
    label: 'Consommation conventionnelle min. (kWhEP/m²/an)',
    column: 'conso_ep_m2',
    source: 'ADEME DPE',
    desc: 'Identifier les passoires extrêmes (> 420 kWh/m²/an = seuil G, voire > 500 kWh/m²/an).',
    controlType: 'slider',
    min: 0, max: 600, step: 25, unit: ' kWh/m²',
    isActive: (s) => Number(s.dynFilters.conso_ep_m2 || 0) > 0,
    reset: (s) => { delete s.dynFilters.conso_ep_m2; },
    getValue: (s) => s.dynFilters.conso_ep_m2 || 0,
    setValue: (s, v) => { s.dynFilters.conso_ep_m2 = Number(v || 0); },
    matches: (s, b) => Number(b.conso_ep_m2 || 0) >= Number(s.dynFilters.conso_ep_m2 || 0),
  },
  {
    id: 'type_energie_chauffage',
    category: 'winter',
    label: 'Énergie principale de chauffage',
    column: 'type_energie_chauffage',
    source: 'ADEME DPE',
    desc: 'Crucial pour les travailleurs sociaux : le chauffage électrique direct (« grille-pain ») ou au fioul en passoire provoque les impayés les plus lourds.',
    controlType: 'select',
    options: [
      { value: '', label: 'Toutes énergies de chauffage' },
      { value: 'electricite', label: '⚡ Électricité (convecteurs / radiateurs élec.)' },
      { value: 'gaz', label: '🔥 Gaz naturel / GPL' },
      { value: 'fioul', label: '🛢️ Fioul domestique' },
      { value: 'reseau de chaleur', label: '🏭 Réseau de chaleur urbain' },
      { value: 'bois', label: '🪵 Bois / Biomasse' },
    ],
    isActive: (s) => Boolean(s.dynFilters.type_energie_chauffage),
    reset: (s) => { delete s.dynFilters.type_energie_chauffage; },
    getValue: (s) => s.dynFilters.type_energie_chauffage || '',
    setValue: (s, v) => { s.dynFilters.type_energie_chauffage = v || ''; },
    matches: (s, b) => {
      const val = s.dynFilters.type_energie_chauffage;
      if (!val) return true;
      return String(b.type_energie_chauffage || '').toLowerCase().includes(val);
    },
  },
  {
    id: 'type_installation_chauffage',
    category: 'winter',
    label: 'Mode de chauffage (Individuel vs Collectif)',
    column: 'type_installation_chauffage',
    source: 'ADEME DPE',
    desc: 'En chauffage individuel, le ménage subit directement la facture ou se prive de chauffage ; en collectif, le coût passe dans les charges locatives.',
    controlType: 'select',
    options: [
      { value: '', label: 'Tous types d\'installation' },
      { value: 'individuel', label: 'Individuel (risque d\'auto-restriction / coupure)' },
      { value: 'collectif', label: 'Collectif (inclus dans les charges)' },
      { value: 'mixte', label: 'Mixte (collectif + appoint individuel)' },
    ],
    isActive: (s) => Boolean(s.dynFilters.type_installation_chauffage),
    reset: (s) => { delete s.dynFilters.type_installation_chauffage; },
    getValue: (s) => s.dynFilters.type_installation_chauffage || '',
    setValue: (s, v) => { s.dynFilters.type_installation_chauffage = v || ''; },
    matches: (s, b) => {
      const val = s.dynFilters.type_installation_chauffage;
      if (!val) return true;
      return String(b.type_installation_chauffage || '').toLowerCase().includes(val);
    },
  },
  {
    id: 'type_energie_ecs',
    category: 'winter',
    label: 'Énergie de l\'Eau Chaude Sanitaire (ECS)',
    column: 'type_energie_ecs',
    source: 'ADEME DPE',
    desc: 'Un ballon électrique individuel mal isolé représente un poste majeur de facture pour les familles nombreuses.',
    controlType: 'select',
    options: [
      { value: '', label: 'Toutes énergies ECS' },
      { value: 'electricite', label: '⚡ Électricité (ballon / cumul électrique)' },
      { value: 'gaz', label: '🔥 Gaz (chaudière / chauffe-eau gaz)' },
      { value: 'fioul', label: '🛢️ Fioul' },
      { value: 'reseau de chaleur', label: '🏭 Réseau de chaleur' },
    ],
    isActive: (s) => Boolean(s.dynFilters.type_energie_ecs),
    reset: (s) => { delete s.dynFilters.type_energie_ecs; },
    getValue: (s) => s.dynFilters.type_energie_ecs || '',
    setValue: (s, v) => { s.dynFilters.type_energie_ecs = v || ''; },
    matches: (s, b) => {
      const val = s.dynFilters.type_energie_ecs;
      if (!val) return true;
      return String(b.type_energie_ecs || '').toLowerCase().includes(val);
    },
  },
  {
    id: 'conso_elec_res_par_pdl_kwh',
    category: 'winter',
    label: 'Conso. électrique réelle min. par logement (kWh/an Enedis)',
    column: 'conso_elec_res_par_pdl_kwh',
    source: 'Enedis DLE / SDES',
    desc: 'Consommation réelle moyenne mesurée par compteur résidentiel (PDL). Permet de confronter le DPE théorique aux factures réelles.',
    controlType: 'slider',
    min: 0, max: 12000, step: 500, unit: ' kWh/an',
    isActive: (s) => Number(s.dynFilters.conso_elec_res_par_pdl_kwh || 0) > 0,
    reset: (s) => { delete s.dynFilters.conso_elec_res_par_pdl_kwh; },
    getValue: (s) => s.dynFilters.conso_elec_res_par_pdl_kwh || 0,
    setValue: (s, v) => { s.dynFilters.conso_elec_res_par_pdl_kwh = Number(v || 0); },
    matches: (s, b) => Number(b.conso_elec_res_par_pdl_kwh || 0) >= Number(s.dynFilters.conso_elec_res_par_pdl_kwh || 0),
  },
  {
    id: 'conso_gaz_res_par_pdl_kwh',
    category: 'winter',
    label: 'Conso. gaz réelle min. par logement (kWh/an GRDF)',
    column: 'conso_gaz_res_par_pdl_kwh',
    source: 'GRDF DLE / SDES',
    desc: 'Consommation réelle moyenne de gaz par point de livraison résidentiel.',
    controlType: 'slider',
    min: 0, max: 20000, step: 1000, unit: ' kWh/an',
    isActive: (s) => Number(s.dynFilters.conso_gaz_res_par_pdl_kwh || 0) > 0,
    reset: (s) => { delete s.dynFilters.conso_gaz_res_par_pdl_kwh; },
    getValue: (s) => s.dynFilters.conso_gaz_res_par_pdl_kwh || 0,
    setValue: (s, v) => { s.dynFilters.conso_gaz_res_par_pdl_kwh = Number(v || 0); },
    matches: (s, b) => Number(b.conso_gaz_res_par_pdl_kwh || 0) >= Number(s.dynFilters.conso_gaz_res_par_pdl_kwh || 0),
  },
  {
    id: 'dpe_arrete_2021',
    category: 'winter',
    label: 'Opposabilité juridique du DPE (Réforme 2021)',
    column: 'dpe_arrete_2021',
    source: 'ADEME DPE',
    desc: 'Seuls les DPE établis selon l\'arrêté de juillet 2021 sont pleinement opposables devant le juge sans nécessiter de nouveau diagnostic.',
    controlType: 'select',
    options: [
      { value: '', label: 'Tous les DPE (pré et post-2021)' },
      { value: 'true', label: '✅ DPE post-2021 (Juridiquement opposable)' },
      { value: 'false', label: '⚠️ DPE pré-2021 (Ancienne méthode / à refaire)' },
    ],
    isActive: (s) => Boolean(s.dynFilters.dpe_arrete_2021),
    reset: (s) => { delete s.dynFilters.dpe_arrete_2021; },
    getValue: (s) => s.dynFilters.dpe_arrete_2021 || '',
    setValue: (s, v) => { s.dynFilters.dpe_arrete_2021 = v || ''; },
    matches: (s, b) => {
      const val = s.dynFilters.dpe_arrete_2021;
      if (!val) return true;
      if (val === 'true') return b.dpe_arrete_2021 === true || String(b.dpe_arrete_2021).toLowerCase() === 'true';
      if (val === 'false') return b.dpe_arrete_2021 === false || String(b.dpe_arrete_2021).toLowerCase() === 'false';
      return true;
    },
  },

  /* ========================================================================
     2. VULNÉRABILITÉ CLIMATIQUE & SURCHAUFFE D'ÉTÉ (« BOUILLOIRES ») (13)
     ======================================================================== */
  {
    id: 'risque_surchauffe_ete',
    category: 'summer',
    label: 'Niveau de risque de surchauffe estivale',
    column: 'risque_surchauffe_ete',
    source: 'Score Composite TeZeLoMa',
    desc: 'Catégorie de vulnérabilité aux canicules (Critique, Élevé, Modéré, Faible, Non renseigné).',
    controlType: 'overheating_pills',
    options: ['Critique', 'Élevé', 'Modéré', 'Faible', 'Non renseigné'],
    isActive: (s) => s.selectedOverheating.size < 5,
    reset: (s) => { s.selectedOverheating = new Set(['Critique', 'Élevé', 'Modéré', 'Faible', 'Non renseigné']); },
    getValue: (s) => Array.from(s.selectedOverheating),
    setValue: (s, v) => { if (Array.isArray(v)) s.selectedOverheating = new Set(v); },
    matches: (s, b) => {
      const rawRisk = b.risque_surchauffe_ete;
      const risk = (!rawRisk || rawRisk === 'NC' || rawRisk === 'Inconnu') ? 'Non renseigné' : rawRisk;
      return s.selectedOverheating.has(risk);
    },
  },
  {
    id: 'score_surchauffe_ete',
    category: 'summer',
    label: 'Score de vulnérabilité canicule min. (/100)',
    column: 'score_surchauffe_ete',
    source: 'Score Composite TeZeLoMa',
    desc: 'Score sur 100 combinant isolation toiture, volets, inertie, caractère traversant et îlot de chaleur nocturne.',
    controlType: 'slider',
    min: 0, max: 90, step: 5, unit: ' / 100',
    isActive: (s) => Number(s.minOverheatScore || 0) > 0,
    reset: (s) => { s.minOverheatScore = 0; },
    getValue: (s) => s.minOverheatScore || 0,
    setValue: (s, v) => { s.minOverheatScore = Number(v || 0); },
    matches: (s, b) => Number(b.score_surchauffe_ete || 0) >= Number(s.minOverheatScore || 0),
  },
  {
    id: 'icu_expo_nuit',
    category: 'summer',
    label: 'Îlot de Chaleur Urbain Nocturne (ICU Nuit)',
    column: 'icu_expo_nuit',
    source: 'Data Grand Lyon WFS',
    desc: 'L\'absence de rafraîchissement nocturne empêche la récupération physiologique des personnes âgées, nourrissons et malades chroniques.',
    controlType: 'select',
    options: [
      { value: '', label: 'Toutes expositions ICU Nuit' },
      { value: 'fort', label: '🔥 Aléa Fort ou Très Fort la nuit' },
      { value: 'mod', label: '☀️ Aléa Modéré, Fort ou Très Fort' },
      { value: 'faible', label: '🌿 Aléa Faible / Très faible' },
    ],
    isActive: (s) => Boolean(s.dynFilters.icu_expo_nuit),
    reset: (s) => { delete s.dynFilters.icu_expo_nuit; },
    getValue: (s) => s.dynFilters.icu_expo_nuit || '',
    setValue: (s, v) => { s.dynFilters.icu_expo_nuit = v || ''; },
    matches: (s, b) => {
      const val = s.dynFilters.icu_expo_nuit;
      if (!val) return true;
      const icu = String(b.icu_expo_nuit || '').toLowerCase();
      if (val === 'fort') return icu.includes('fort');
      if (val === 'mod') return icu.includes('mod') || icu.includes('fort');
      if (val === 'faible') return icu.includes('faible');
      return true;
    },
  },
  {
    id: 'icu_expo_jour',
    category: 'summer',
    label: 'Îlot de Chaleur Urbain Diurne (ICU Jour)',
    column: 'icu_expo_jour',
    source: 'Data Grand Lyon WFS',
    desc: 'Stress thermique de jour lié à la minéralisation de la rue et au manque de canopée arborée.',
    controlType: 'select',
    options: [
      { value: '', label: 'Toutes expositions ICU Jour' },
      { value: 'fort', label: '🔥 Aléa Fort ou Très Fort le jour' },
      { value: 'mod', label: '☀️ Aléa Modéré, Fort ou Très Fort' },
    ],
    isActive: (s) => Boolean(s.dynFilters.icu_expo_jour),
    reset: (s) => { delete s.dynFilters.icu_expo_jour; },
    getValue: (s) => s.dynFilters.icu_expo_jour || '',
    setValue: (s, v) => { s.dynFilters.icu_expo_jour = v || ''; },
    matches: (s, b) => {
      const val = s.dynFilters.icu_expo_jour;
      if (!val) return true;
      const icu = String(b.icu_expo_jour || '').toLowerCase();
      if (val === 'fort') return icu.includes('fort');
      if (val === 'mod') return icu.includes('mod') || icu.includes('fort');
      return true;
    },
  },
  {
    id: 'icu_vulnerabilite_nuit',
    category: 'summer',
    label: 'Vulnérabilité Globale ICU Nuit (Grand Lyon)',
    column: 'icu_vulnerabilite_nuit',
    source: 'Data Grand Lyon WFS',
    desc: 'Indice synthétique de vulnérabilité nocturne de la Métropole de Lyon.',
    controlType: 'select',
    options: [
      { value: '', label: 'Tous niveaux de vulnérabilité ICU' },
      { value: 'forte', label: 'Forte ou Très forte vulnérabilité' },
      { value: 'moyenne', label: 'Moyenne, Forte ou Très forte' },
    ],
    isActive: (s) => Boolean(s.dynFilters.icu_vulnerabilite_nuit),
    reset: (s) => { delete s.dynFilters.icu_vulnerabilite_nuit; },
    getValue: (s) => s.dynFilters.icu_vulnerabilite_nuit || '',
    setValue: (s, v) => { s.dynFilters.icu_vulnerabilite_nuit = v || ''; },
    matches: (s, b) => {
      const val = s.dynFilters.icu_vulnerabilite_nuit;
      if (!val) return true;
      const vStr = String(b.icu_vulnerabilite_nuit || '').toLowerCase();
      if (val === 'forte') return vStr.includes('forte');
      if (val === 'moyenne') return vStr.includes('moyenne') || vStr.includes('forte');
      return true;
    },
  },
  {
    id: 'type_isolation_plancher_haut',
    category: 'summer',
    label: 'Isolation de la toiture / combles',
    column: 'type_isolation_plancher_haut',
    source: 'ADEME DPE',
    desc: 'Un toit non isolé transforme les logements sous combles en fournaises l\'été et en gouffres thermiques l\'hiver.',
    controlType: 'select',
    options: [
      { value: '', label: 'Tous états d\'isolation toiture' },
      { value: 'non isol', label: '🚨 Toiture / combles NON isolés uniquement' },
      { value: 'isol', label: '✅ Toiture isolée (ITI / ITE / combles)' },
      { value: 'inconnu', label: '❓ Isolation toiture inconnue' },
    ],
    isActive: (s) => Boolean(s.onlyUninsulatedRoof || s.dynFilters.type_isolation_plancher_haut),
    reset: (s) => { s.onlyUninsulatedRoof = false; delete s.dynFilters.type_isolation_plancher_haut; },
    getValue: (s) => s.onlyUninsulatedRoof ? 'non isol' : (s.dynFilters.type_isolation_plancher_haut || ''),
    setValue: (s, v) => {
      s.onlyUninsulatedRoof = (v === 'non isol');
      s.dynFilters.type_isolation_plancher_haut = v || '';
    },
    matches: (s, b) => {
      const val = s.onlyUninsulatedRoof ? 'non isol' : (s.dynFilters.type_isolation_plancher_haut || '');
      if (!val) return true;
      const roof = String(b.type_isolation_plancher_haut || '').toLowerCase();
      if (val === 'non isol') return roof.includes('non isol');
      if (val === 'isol') return roof.includes('isol') && !roof.includes('non isol');
      if (val === 'inconnu') return !roof || roof.includes('inconnu') || roof === 'nc';
      return true;
    },
  },
  {
    id: 'u_plancher_haut_deperditif',
    category: 'summer',
    label: 'Coefficient de déperdition toiture min. U (W/m²K)',
    column: 'u_plancher_haut_deperditif',
    source: 'ADEME DPE',
    desc: 'Plus le coefficient U du plafond est élevé (> 1.5 W/m²K), plus la chaleur traverse directement la toiture.',
    controlType: 'slider',
    min: 0, max: 2.5, step: 0.25, unit: ' W/m²K',
    isActive: (s) => Number(s.dynFilters.u_plancher_haut_deperditif || 0) > 0,
    reset: (s) => { delete s.dynFilters.u_plancher_haut_deperditif; },
    getValue: (s) => s.dynFilters.u_plancher_haut_deperditif || 0,
    setValue: (s, v) => { s.dynFilters.u_plancher_haut_deperditif = Number(v || 0); },
    matches: (s, b) => Number(b.u_plancher_haut_deperditif || 0) >= Number(s.dynFilters.u_plancher_haut_deperditif || 0),
  },
  {
    id: 'type_fermeture',
    category: 'summer',
    label: 'Présence de volets / protections solaires extérieures',
    column: 'type_fermeture',
    source: 'ADEME DPE',
    desc: 'Sans volets extérieurs, le rayonnement solaire entre directement par les vitrages (effet de serre intérieur irréversible).',
    controlType: 'select',
    options: [
      { value: '', label: 'Tous types de fermetures / volets' },
      { value: 'sans', label: '🚨 Sans volets / Sans fermeture extérieure' },
      { value: 'avec', label: '✅ Avec volets roulants, battants ou persiennes' },
    ],
    isActive: (s) => Boolean(s.onlyNoShutters || s.dynFilters.type_fermeture),
    reset: (s) => { s.onlyNoShutters = false; delete s.dynFilters.type_fermeture; },
    getValue: (s) => s.onlyNoShutters ? 'sans' : (s.dynFilters.type_fermeture || ''),
    setValue: (s, v) => {
      s.onlyNoShutters = (v === 'sans');
      s.dynFilters.type_fermeture = v || '';
    },
    matches: (s, b) => {
      const val = s.onlyNoShutters ? 'sans' : (s.dynFilters.type_fermeture || '');
      if (!val) return true;
      const sh = String(b.type_fermeture || '').toLowerCase();
      if (val === 'sans') return sh.includes('sans fermeture') || sh.includes('absence');
      if (val === 'avec') return sh.includes('volet') || sh.includes('persienne') || sh.includes('jalousie');
      return true;
    },
  },
  {
    id: 'traversant',
    category: 'summer',
    label: 'Caractère traversant des logements (Ventilation nocturne)',
    column: 'traversant',
    source: 'ADEME DPE',
    desc: 'Un logement mono-orienté (non traversant) ne permet pas de créer un courant d\'air salvateur la nuit.',
    controlType: 'select',
    options: [
      { value: '', label: 'Tous (traversants et non-traversants)' },
      { value: 'non_traversant', label: '🚨 Non traversants / Mono-orientés' },
      { value: 'traversant', label: '🌬️ Logements traversants' },
    ],
    isActive: (s) => Boolean(s.dynFilters.traversant),
    reset: (s) => { delete s.dynFilters.traversant; },
    getValue: (s) => s.dynFilters.traversant || '',
    setValue: (s, v) => { s.dynFilters.traversant = v || ''; },
    matches: (s, b) => {
      const val = s.dynFilters.traversant;
      if (!val) return true;
      const t = String(b.traversant || '').toLowerCase();
      if (val === 'non_traversant') return t.includes('non') || t.includes('mono') || t.includes('seule') || t === 'false';
      if (val === 'traversant') return (t.includes('traversant') && !t.includes('non')) || t === 'true' || t.includes('plusieurs');
      return true;
    },
  },
  {
    id: 'classe_inertie',
    category: 'summer',
    label: 'Inertie thermique du bâti',
    column: 'classe_inertie',
    source: 'ADEME DPE',
    desc: 'Une inertie légère signifie que les parois montent très rapidement en température dès les premiers jours de vague de chaleur.',
    controlType: 'select',
    options: [
      { value: '', label: 'Toutes classes d\'inertie' },
      { value: 'legere', label: '🚨 Inertie Légère uniquement' },
      { value: 'legere_moyenne', label: '⚠️ Inertie Légère ou Moyenne' },
      { value: 'lourde', label: '🪨 Inertie Lourde ou Très lourde' },
    ],
    isActive: (s) => Boolean(s.dynFilters.classe_inertie),
    reset: (s) => { delete s.dynFilters.classe_inertie; },
    getValue: (s) => s.dynFilters.classe_inertie || '',
    setValue: (s, v) => { s.dynFilters.classe_inertie = v || ''; },
    matches: (s, b) => {
      const val = s.dynFilters.classe_inertie;
      if (!val) return true;
      const iner = String(b.classe_inertie || '').toLowerCase();
      if (val === 'legere') return iner.includes('légère') || iner.includes('legere');
      if (val === 'legere_moyenne') return iner.includes('légère') || iner.includes('legere') || iner.includes('moyenne');
      if (val === 'lourde') return iner.includes('lourde');
      return true;
    },
  },
  {
    id: 'presence_balcon',
    category: 'summer',
    label: 'Présence d\'un balcon ou loggia (Refuge extérieur)',
    column: 'presence_balcon',
    source: 'BDNB / DPE',
    desc: 'En cas de canicule dans un petit logement, l\'absence de balcon prive le ménage de tout espace extérieur pour respirer le soir.',
    controlType: 'select',
    options: [
      { value: '', label: 'Tous (avec ou sans balcon)' },
      { value: 'sans', label: '🚨 Sans balcon recensé' },
      { value: 'avec', label: '🌿 Avec balcon / loggia' },
    ],
    isActive: (s) => Boolean(s.dynFilters.presence_balcon),
    reset: (s) => { delete s.dynFilters.presence_balcon; },
    getValue: (s) => s.dynFilters.presence_balcon || '',
    setValue: (s, v) => { s.dynFilters.presence_balcon = v || ''; },
    matches: (s, b) => {
      const val = s.dynFilters.presence_balcon;
      if (!val) return true;
      const hasB = b.presence_balcon === true || b.presence_balcon === 1 || String(b.presence_balcon).toLowerCase() === 'true' || String(b.presence_balcon).toLowerCase() === 'oui';
      return val === 'avec' ? hasB : !hasB;
    },
  },
  {
    id: 'has_clim',
    category: 'summer',
    label: 'Équipement de climatisation',
    column: 'has_clim',
    source: 'ADEME DPE',
    desc: 'Filtrer les bâtiments dépourvus de système de refroidissement.',
    controlType: 'select',
    options: [
      { value: '', label: 'Tous (climatisés ou non)' },
      { value: 'sans', label: 'Sans climatisation' },
      { value: 'avec', label: 'Avec climatisation déclarée' },
    ],
    isActive: (s) => Boolean(s.dynFilters.has_clim),
    reset: (s) => { delete s.dynFilters.has_clim; },
    getValue: (s) => s.dynFilters.has_clim || '',
    setValue: (s, v) => { s.dynFilters.has_clim = v || ''; },
    matches: (s, b) => {
      const val = s.dynFilters.has_clim;
      if (!val) return true;
      const hc = Boolean(b.has_clim);
      return val === 'avec' ? hc : !hc;
    },
  },
  {
    id: 'facteur_solaire_baie_vitree',
    category: 'summer',
    label: 'Facteur solaire des baies vitrées min. (Sw)',
    column: 'facteur_solaire_baie_vitree',
    source: 'ADEME DPE',
    desc: 'Proportion du flux énergétique solaire transmis à l\'intérieur (0 à 1).',
    controlType: 'slider',
    min: 0, max: 0.8, step: 0.1, unit: ' Sw',
    isActive: (s) => Number(s.dynFilters.facteur_solaire_baie_vitree || 0) > 0,
    reset: (s) => { delete s.dynFilters.facteur_solaire_baie_vitree; },
    getValue: (s) => s.dynFilters.facteur_solaire_baie_vitree || 0,
    setValue: (s, v) => { s.dynFilters.facteur_solaire_baie_vitree = Number(v || 0); },
    matches: (s, b) => Number(b.facteur_solaire_baie_vitree || 0) >= Number(s.dynFilters.facteur_solaire_baie_vitree || 0),
  },

  /* ========================================================================
     3. STRUCTURE DE PROPRIÉTÉ, MULTIPROPRIÉTÉ & RAPPORTS DE FORCE (8)
     ======================================================================== */
  {
    id: 'owner_search',
    category: 'landlords',
    label: 'Recherche par Nom de Bailleur ou N° SIREN',
    column: 'concentration_prop_max_denomination',
    source: 'DGFiP MAJIC / RNE',
    desc: 'Rechercher tous les immeubles où une SCI, foncière ou bailleur donné possède au moins un lot.',
    controlType: 'text',
    placeholder: 'Ex: SCI, Alliade, Foncière, 908120595...',
    isActive: (s) => Boolean((s.ownerSearchText || '').trim()),
    reset: (s) => { s.ownerSearchText = ''; },
    getValue: (s) => s.ownerSearchText || '',
    setValue: (s, v) => { s.ownerSearchText = v || ''; },
    matches: (s, b) => {
      const searchLower = (s.ownerSearchText || '').toLowerCase().trim();
      if (!searchLower) return true;
      const denom = String(b.concentration_prop_max_denomination || '').toLowerCase();
      const siren = String(b.siren_principal || '').toLowerCase();
      if (denom.includes(searchLower) || siren.includes(searchLower)) return true;
      const bOwners = s.ownersByBuilding.get(b.batiment_groupe_id) || [];
      for (let i = 0; i < bOwners.length; i++) {
        const o = bOwners[i];
        if (String(o.denomination || '').toLowerCase().includes(searchLower) ||
            String(o.siren || '').toLowerCase().includes(searchLower)) {
          return true;
        }
      }
      return false;
    },
  },
  {
    id: 'legal_category',
    category: 'landlords',
    label: 'Catégorie juridique de propriétaire (SCI, Société, Social, Physique)',
    column: 'formes_juridiques',
    source: 'DGFiP MAJIC',
    desc: 'Filtrer selon le statut des propriétaires de l\'immeuble (avec bascule Mode Inclusif / Mode Exclusif).',
    controlType: 'legal_pills',
    options: ['SCI', 'Bailleur social', 'Société commerciale', 'Personne physique'],
    isActive: (s) => s.selectedLegal.size < 4,
    reset: (s) => {
      s.selectedLegal = new Set(['SCI', 'Bailleur social', 'Société commerciale', 'Personne physique']);
      s.legalMode = 'inclusif';
    },
    getValue: (s) => ({ selected: Array.from(s.selectedLegal), mode: s.legalMode }),
    setValue: (s, v) => {
      if (v && Array.isArray(v.selected)) s.selectedLegal = new Set(v.selected);
      if (v && v.mode) s.legalMode = v.mode;
    },
    matches: (s, b) => {
      if (s.selectedLegal.size >= 4) return true;
      const bLegals = String(b.formes_juridiques || '');
      if (s.legalMode === 'exclusif') {
        const parts = bLegals.split(',').map(x => x.trim()).filter(Boolean);
        return parts.length > 0 && parts.every(p => s.selectedLegal.has(p));
      }
      for (const leg of s.selectedLegal) {
        if (bLegals.includes(leg)) return true;
      }
      return false;
    },
  },
  {
    id: 'forme_juridique_principale',
    category: 'landlords',
    label: 'Forme juridique détaillée INSEE du bailleur principal',
    column: 'forme_juridique_principale',
    source: 'DGFiP MAJIC / INSEE',
    desc: 'Rechercher une forme juridique précise (ex: SCI, SAS, SARL, SA d\'HLM, OPH, Commune, Association, Assurance...).',
    controlType: 'text',
    placeholder: 'Ex: SCI, SAS, SARL, HLM, Commune...',
    isActive: (s) => Boolean((s.dynFilters.forme_juridique_principale || '').trim()),
    reset: (s) => { delete s.dynFilters.forme_juridique_principale; },
    getValue: (s) => s.dynFilters.forme_juridique_principale || '',
    setValue: (s, v) => { s.dynFilters.forme_juridique_principale = v || ''; },
    matches: (s, b) => {
      const q = (s.dynFilters.forme_juridique_principale || '').toLowerCase().trim();
      if (!q) return true;
      return String(b.forme_juridique_principale || '').toLowerCase().includes(q) ||
             String(b.formes_juridiques || '').toLowerCase().includes(q);
    },
  },
  {
    id: 'concentration_pct',
    category: 'landlords',
    label: 'Concentration foncière min. d\'un seul propriétaire (%)',
    column: 'concentration_prop_max_num',
    source: 'DGFiP MAJIC',
    desc: 'Part des logements de l\'immeuble détenus par le plus gros propriétaire personne morale (100% = monopropriété morale).',
    controlType: 'slider',
    min: 0, max: 100, step: 5, unit: '%',
    isActive: (s) => Number(s.minConcentration || 0) > 0,
    reset: (s) => { s.minConcentration = 0; },
    getValue: (s) => s.minConcentration || 0,
    setValue: (s, v) => { s.minConcentration = Number(v || 0); },
    matches: (s, b) => Number(b.concentration_prop_max_num || 0) >= Number(s.minConcentration || 0),
  },
  {
    id: 'max_locaux_un_prop',
    category: 'landlords',
    label: 'Nombre min. de lots détenus par un même bailleur dans l\'immeuble',
    column: 'max_locaux_un_prop',
    source: 'DGFiP MAJIC',
    desc: 'Permet de repérer où plusieurs locataires ont le même propriétaire au sein d\'un même immeuble pour s\'organiser collectivement.',
    controlType: 'number_min',
    min: 0, max: 500, step: 1, placeholder: 'Ex: 3 lots dans l\'immeuble',
    isActive: (s) => Number(s.dynFilters.max_locaux_un_prop || 0) > 0,
    reset: (s) => { delete s.dynFilters.max_locaux_un_prop; },
    getValue: (s) => s.dynFilters.max_locaux_un_prop || 0,
    setValue: (s, v) => { s.dynFilters.max_locaux_un_prop = Number(v || 0); },
    matches: (s, b) => Number(b.max_locaux_un_prop || 0) >= Number(s.dynFilters.max_locaux_un_prop || 0),
  },
  {
    id: 'min_patrimoine_majic',
    category: 'landlords',
    label: 'Patrimoine départemental min. du bailleur (total locaux MAJIC)',
    column: 'max_patrimoine_majic_bailleur',
    source: 'DGFiP MAJIC',
    desc: 'Nombre total de locaux possédés par le bailleur sur l\'ensemble du département (distingue la petite SCI familiale du grand multipropriétaire).',
    controlType: 'number_min',
    min: 0, max: 50000, step: 5, placeholder: 'Ex: 10, 50, 500 locaux...',
    isActive: (s) => Number(s.minPatrimoine || 0) > 0,
    reset: (s) => { s.minPatrimoine = 0; },
    getValue: (s) => s.minPatrimoine || 0,
    setValue: (s, v) => { s.minPatrimoine = Number(v || 0); },
    matches: (s, b) => Number(b.max_patrimoine_majic_bailleur || 0) >= Number(s.minPatrimoine || 0),
  },
  {
    id: 'nb_proprietaires_open',
    category: 'landlords',
    label: 'Présence et nombre de propriétaires personnes morales',
    column: 'nb_proprietaires_open',
    source: 'DGFiP MAJIC',
    desc: 'Filtrer selon le nombre d\'entités personnes morales (SCI, sociétés, bailleurs) copropriétaires dans l\'immeuble.',
    controlType: 'select',
    options: [
      { value: '', label: 'Tous les immeubles' },
      { value: 'has_pm', label: '🏢 Au moins 1 propriétaire personne morale (≥ 1)' },
      { value: 'mono_pm', label: '🎯 Monopropriété morale (1 seul PM détenant ≥ 80%)' },
      { value: 'multi_pm', label: '🦈 Plusieurs personnes morales dans l\'immeuble (≥ 2)' },
      { value: 'no_pm', label: '👤 Aucun propriétaire personne morale (100% personnes physiques)' },
    ],
    isActive: (s) => Boolean(s.dynFilters.nb_proprietaires_open),
    reset: (s) => { delete s.dynFilters.nb_proprietaires_open; },
    getValue: (s) => s.dynFilters.nb_proprietaires_open || '',
    setValue: (s, v) => { s.dynFilters.nb_proprietaires_open = v || ''; },
    matches: (s, b) => {
      const val = s.dynFilters.nb_proprietaires_open;
      if (!val) return true;
      const nb = Number(b.nb_proprietaires_open || 0);
      const conc = Number(b.concentration_prop_max_num || 0);
      if (val === 'has_pm') return nb >= 1;
      if (val === 'mono_pm') return nb === 1 && conc >= 80;
      if (val === 'multi_pm') return nb >= 2;
      if (val === 'no_pm') return nb === 0;
      return true;
    },
  },
  {
    id: 'bailleur_distant',
    category: 'landlords',
    label: 'Éloignement géographique du siège du bailleur',
    column: 'code_postal_proprietaire_principal',
    source: 'DGFiP MAJIC',
    desc: 'Repérer les immeubles détenus par des sociétés dont le siège social est hors de la commune ou hors du département (fonds parisiens, SCI extérieures).',
    controlType: 'select',
    options: [
      { value: '', label: 'Toutes localisations de siège' },
      { value: 'hors_dep', label: '✈️ Siège social hors du département de l\'immeuble' },
      { value: 'paris_idf', label: '🗼 Siège social à Paris / Île-de-France (75, 92...)' },
      { value: 'local', label: '📍 Siège social dans le même département' },
    ],
    isActive: (s) => Boolean(s.dynFilters.bailleur_distant),
    reset: (s) => { delete s.dynFilters.bailleur_distant; },
    getValue: (s) => s.dynFilters.bailleur_distant || '',
    setValue: (s, v) => { s.dynFilters.bailleur_distant = v || ''; },
    matches: (s, b) => {
      const val = s.dynFilters.bailleur_distant;
      if (!val) return true;
      const cpProp = String(b.code_postal_proprietaire_principal || '').trim();
      if (!cpProp || cpProp === 'None' || cpProp.length < 2) return false;
      const depProp = cpProp.slice(0, 2);
      const depBat = String(b.code_departement_insee || String(b.cp || '').slice(0, 2)).trim();
      if (val === 'hors_dep') return depProp !== depBat;
      if (val === 'paris_idf') return ['75', '77', '78', '91', '92', '93', '94', '95'].includes(depProp);
      if (val === 'local') return depProp === depBat;
      return true;
    },
  },

  /* ========================================================================
     4. JUSTICE SOCIALE, LOYERS, PARC SOCIAL & SPÉCULATION (10 indicateurs)
     ======================================================================== */
  {
    id: 'qpv_mode',
    category: 'social',
    label: 'Géographie Prioritaire de la Ville (Quartiers QPV - ANCT)',
    column: 'quartier_qpv',
    source: 'ANCT / BDNB',
    desc: 'Cibler les Quartiers Prioritaires de la Politique de la Ville où se concentrent les ménages à bas revenus.',
    controlType: 'select',
    options: [
      { value: '', label: 'Tous les quartiers (QPV et hors QPV)' },
      { value: 'only_qpv', label: '🏘️ Uniquement en Quartier Prioritaire (QPV)' },
      { value: 'exclude_qpv', label: 'Hors Quartier Prioritaire (QPV)' },
    ],
    isActive: (s) => Boolean(s.filterQpv || s.dynFilters.qpv_mode),
    reset: (s) => { s.filterQpv = false; delete s.dynFilters.qpv_mode; },
    getValue: (s) => s.filterQpv ? 'only_qpv' : (s.dynFilters.qpv_mode || ''),
    setValue: (s, v) => {
      s.filterQpv = (v === 'only_qpv');
      s.dynFilters.qpv_mode = v || '';
    },
    matches: (s, b) => {
      const val = s.filterQpv ? 'only_qpv' : (s.dynFilters.qpv_mode || '');
      if (!val) return true;
      const inQpv = Boolean(b.quartier_qpv && b.quartier_qpv !== 'None' && b.quartier_qpv !== '—');
      return val === 'only_qpv' ? inQpv : !inQpv;
    },
  },
  {
    id: 'quartier_qpv_select',
    category: 'social',
    label: 'Recherche par nom de Quartier Prioritaire (QPV)',
    column: 'quartier_qpv',
    source: 'ANCT / BDNB',
    desc: 'Filtrer sur un quartier QPV précis (ex: Minguettes, Guillotière, États-Unis, Duchère, Villeneuve, Mistral...).',
    controlType: 'text',
    placeholder: 'Ex: Duchère, États-Unis, Villeneuve, Mistral...',
    isActive: (s) => Boolean((s.dynFilters.quartier_qpv_select || '').trim()),
    reset: (s) => { delete s.dynFilters.quartier_qpv_select; },
    getValue: (s) => s.dynFilters.quartier_qpv_select || '',
    setValue: (s, v) => { s.dynFilters.quartier_qpv_select = v || ''; },
    matches: (s, b) => {
      const q = (s.dynFilters.quartier_qpv_select || '').toLowerCase().trim();
      if (!q) return true;
      return String(b.quartier_qpv || '').toLowerCase().includes(q);
    },
  },
  {
    id: 'social_rpls_mode',
    category: 'social',
    label: 'Statut Parc Social (RPLS) vs Parc Locatif Privé',
    column: 'est_logement_social_rpls',
    source: 'Ministère du Logement (RPLS)',
    desc: 'Isoler le parc social HLM ou au contraire l\'exclure pour cibler uniquement les marchands de sommeil et bailleurs privés.',
    controlType: 'select',
    options: [
      { value: '', label: 'Tout le parc (Privé + Social)' },
      { value: 'exclude_social', label: '🔑 Parc Privé uniquement (Exclure le logement social RPLS)' },
      { value: 'only_social', label: '🏛️ Parc Social uniquement (Répertoire RPLS)' },
    ],
    isActive: (s) => Boolean(s.filterSocialOnly || s.filterExcludeSocial || s.dynFilters.social_rpls_mode),
    reset: (s) => { s.filterSocialOnly = false; s.filterExcludeSocial = false; delete s.dynFilters.social_rpls_mode; },
    getValue: (s) => s.filterSocialOnly ? 'only_social' : (s.filterExcludeSocial ? 'exclude_social' : (s.dynFilters.social_rpls_mode || '')),
    setValue: (s, v) => {
      s.filterSocialOnly = (v === 'only_social');
      s.filterExcludeSocial = (v === 'exclude_social');
      s.dynFilters.social_rpls_mode = v || '';
    },
    matches: (s, b) => {
      const val = s.filterSocialOnly ? 'only_social' : (s.filterExcludeSocial ? 'exclude_social' : (s.dynFilters.social_rpls_mode || ''));
      if (!val) return true;
      const isSoc = Boolean(b.est_logement_social_rpls);
      return val === 'only_social' ? isSoc : !isSoc;
    },
  },
  {
    id: 'nb_log_sociaux_rpls',
    category: 'social',
    label: 'Nombre min. de logements sociaux RPLS dans l\'immeuble',
    column: 'nb_log_sociaux_rpls',
    source: 'RPLS',
    desc: 'Nombre de logements conventionnés RPLS recensés dans le groupe de bâtiment.',
    controlType: 'number_min',
    min: 0, max: 500, step: 1, placeholder: 'Ex: 10 logements sociaux',
    isActive: (s) => Number(s.dynFilters.nb_log_sociaux_rpls || 0) > 0,
    reset: (s) => { delete s.dynFilters.nb_log_sociaux_rpls; },
    getValue: (s) => s.dynFilters.nb_log_sociaux_rpls || 0,
    setValue: (s, v) => { s.dynFilters.nb_log_sociaux_rpls = Number(v || 0); },
    matches: (s, b) => Number(b.nb_log_sociaux_rpls || 0) >= Number(s.dynFilters.nb_log_sociaux_rpls || 0),
  },
  {
    id: 'pmr_rpls_mode',
    category: 'social',
    label: 'Accessibilité Handicap / Mobilité Réduite (PMR RPLS)',
    column: 'nb_log_pmr_rpls',
    source: 'RPLS (accessible_pmr)',
    desc: 'Identifier les résidences sociales disposant (ou dépourvues) de logements adaptés aux Personnes à Mobilité Réduite.',
    controlType: 'select',
    options: [
      { value: '', label: 'Tous les immeubles' },
      { value: 'has_pmr', label: '♿ Immeubles avec logements accessibles PMR (> 0)' },
      { value: 'social_no_pmr', label: '⚠️ Immeubles sociaux sans logement PMR déclaré (= 0)' },
    ],
    isActive: (s) => Boolean(s.dynFilters.pmr_rpls_mode),
    reset: (s) => { delete s.dynFilters.pmr_rpls_mode; },
    getValue: (s) => s.dynFilters.pmr_rpls_mode || '',
    setValue: (s, v) => { s.dynFilters.pmr_rpls_mode = v || ''; },
    matches: (s, b) => {
      const val = s.dynFilters.pmr_rpls_mode;
      if (!val) return true;
      const pmr = Number(b.nb_log_pmr_rpls || 0);
      if (val === 'has_pmr') return pmr > 0;
      if (val === 'social_no_pmr') return Boolean(b.est_logement_social_rpls) && pmr === 0;
      return true;
    },
  },
  {
    id: 'rent_control_mode',
    category: 'social',
    label: 'Périmètre d\'Encadrement des Loyers (Lyon & Villeurbanne)',
    column: 'zone_encadrement_loyers',
    source: 'Préfecture / Data Grand Lyon',
    desc: 'Vérifier si l\'immeuble est couvert par le plafonnement préfectoral des loyers (permet d\'engager une action en diminution de loyer).',
    controlType: 'select',
    options: [
      { value: '', label: 'Tous les immeubles' },
      { value: 'controlled', label: '💶 Soumis à l\'encadrement des loyers uniquement' },
      { value: 'uncontrolled', label: 'Hors zone d\'encadrement des loyers' },
    ],
    isActive: (s) => Boolean(s.filterRentControl || s.dynFilters.rent_control_mode),
    reset: (s) => { s.filterRentControl = false; delete s.dynFilters.rent_control_mode; },
    getValue: (s) => s.filterRentControl ? 'controlled' : (s.dynFilters.rent_control_mode || ''),
    setValue: (s, v) => {
      s.filterRentControl = (v === 'controlled');
      s.dynFilters.rent_control_mode = v || '';
    },
    matches: (s, b) => {
      const val = s.filterRentControl ? 'controlled' : (s.dynFilters.rent_control_mode || '');
      if (!val) return true;
      const hasZone = Number(b.zone_encadrement_loyers || 0) > 0;
      return val === 'controlled' ? hasZone : !hasZone;
    },
  },
  {
    id: 'zone_encadrement_loyers',
    category: 'social',
    label: 'Zone tarifaire d\'encadrement des loyers (Zones 1 à 4)',
    column: 'zone_encadrement_loyers',
    source: 'Préfecture / Data Grand Lyon',
    desc: 'Filtrer par niveau de tension locative (Zone 1 = Presqu\'île/6e/Croix-Rousse ; Zone 4 = quartiers populaires).',
    controlType: 'select',
    options: [
      { value: '', label: 'Toutes les zones (1 à 4)' },
      { value: '1', label: 'Zone 1 (Loyers plafonds les plus élevés)' },
      { value: '2', label: 'Zone 2' },
      { value: '3', label: 'Zone 3' },
      { value: '4', label: 'Zone 4 (Secteurs populaires)' },
    ],
    isActive: (s) => Boolean(s.dynFilters.zone_encadrement_loyers),
    reset: (s) => { delete s.dynFilters.zone_encadrement_loyers; },
    getValue: (s) => s.dynFilters.zone_encadrement_loyers || '',
    setValue: (s, v) => { s.dynFilters.zone_encadrement_loyers = v || ''; },
    matches: (s, b) => {
      const val = s.dynFilters.zone_encadrement_loyers;
      if (!val) return true;
      return String(b.zone_encadrement_loyers || '') === val;
    },
  },
  {
    id: 'loyer_max_t2_nm',
    category: 'social',
    label: 'Loyer plafond légal max. T2 non-meublé (€/m²)',
    column: 'loyer_max_t2_non_meuble_m2',
    source: 'Arrêté Préfectoral 2025-2026',
    desc: 'Filtrer les immeubles dont le loyer plafond autorisé (hors complément) est inférieur ou égal à un seuil en €/m².',
    controlType: 'slider',
    min: 10, max: 22, step: 0.5, unit: ' €/m² max',
    isActive: (s) => Number(s.dynFilters.loyer_max_t2_nm || 0) > 0,
    reset: (s) => { delete s.dynFilters.loyer_max_t2_nm; },
    getValue: (s) => s.dynFilters.loyer_max_t2_nm || 0,
    setValue: (s, v) => { s.dynFilters.loyer_max_t2_nm = Number(v || 0); },
    matches: (s, b) => {
      const maxVal = Number(s.dynFilters.loyer_max_t2_nm || 0);
      if (maxVal <= 0) return true;
      const loy = Number(b.loyer_max_t2_non_meuble_m2 || 0);
      return loy > 0 && loy <= maxVal;
    },
  },
  {
    id: 'dvf_prix_m2_median',
    category: 'social',
    label: 'Prix immobilier médian des ventes (DVF €/m²)',
    column: 'dvf_prix_m2_median',
    source: 'DGFiP DVF Open Data',
    desc: 'Analyser la valeur foncière de l\'immeuble : immeuble décoté de marchand de sommeil vs secteur gentrifié à forte plus-value.',
    controlType: 'select',
    options: [
      { value: '', label: 'Tous niveaux de prix DVF' },
      { value: 'low', label: '📉 Marché décoté / populaire (< 2 500 €/m²)' },
      { value: 'mid', label: '⚖️ Marché intermédiaire (2 500 à 4 500 €/m²)' },
      { value: 'high', label: '📈 Marché cher / gentrifié (> 4 500 €/m²)' },
      { value: 'any_dvf', label: '💶 Toutes ventes DVF renseignées (> 0 €/m²)' },
    ],
    isActive: (s) => Boolean(s.dynFilters.dvf_prix_m2_median),
    reset: (s) => { delete s.dynFilters.dvf_prix_m2_median; },
    getValue: (s) => s.dynFilters.dvf_prix_m2_median || '',
    setValue: (s, v) => { s.dynFilters.dvf_prix_m2_median = v || ''; },
    matches: (s, b) => {
      const val = s.dynFilters.dvf_prix_m2_median;
      if (!val) return true;
      const p = Number(b.dvf_prix_m2_median || 0);
      if (p <= 0) return false;
      if (val === 'low') return p < 2500;
      if (val === 'mid') return p >= 2500 && p <= 4500;
      if (val === 'high') return p > 4500;
      if (val === 'any_dvf') return p > 0;
      return true;
    },
  },
  {
    id: 'dvf_nb_mutations',
    category: 'social',
    label: 'Rotation spéculative (Nb min. de ventes DVF dans l\'immeuble)',
    column: 'dvf_nb_mutations',
    source: 'DGFiP DVF Open Data',
    desc: 'Un nombre élevé de mutations récentes signale une découpe à la saucisse, une forte rotation spéculative ou une fuite des propriétaires face aux travaux.',
    controlType: 'number_min',
    min: 0, max: 200, step: 1, placeholder: 'Ex: 5 ventes récentes',
    isActive: (s) => Number(s.dynFilters.dvf_nb_mutations || 0) > 0,
    reset: (s) => { delete s.dynFilters.dvf_nb_mutations; },
    getValue: (s) => s.dynFilters.dvf_nb_mutations || 0,
    setValue: (s, v) => { s.dynFilters.dvf_nb_mutations = Number(v || 0); },
    matches: (s, b) => Number(b.dvf_nb_mutations || 0) >= Number(s.dynFilters.dvf_nb_mutations || 0),
  },

  /* ========================================================================
     5. COPROPRIÉTÉS, SALUBRITÉ & QUALITÉ DE L'HABITAT (8 indicateurs)
     ======================================================================== */
  {
    id: 'copro_status',
    category: 'copro',
    label: 'Statut Copropriété (RNIC) vs Monopropriété',
    column: 'est_copro_rnc',
    source: 'ANAH RNIC',
    desc: 'En copropriété, les travaux d\'isolation dépendent du vote en AG ; en monopropriété, le bailleur unique décide seul.',
    controlType: 'select',
    options: [
      { value: '', label: 'Tous statuts (Copropriété et Monopropriété)' },
      { value: 'only_copro', label: '🏢 Copropriétés immatriculées RNIC uniquement' },
      { value: 'non_copro', label: '🏠 Hors copropriété RNIC (Monopropriété / Individuel)' },
    ],
    isActive: (s) => Boolean(s.dynFilters.copro_status),
    reset: (s) => { delete s.dynFilters.copro_status; },
    getValue: (s) => s.dynFilters.copro_status || '',
    setValue: (s, v) => { s.dynFilters.copro_status = v || ''; },
    matches: (s, b) => {
      const val = s.dynFilters.copro_status;
      if (!val) return true;
      const isCopro = Boolean(b.est_copro_rnc);
      return val === 'only_copro' ? isCopro : !isCopro;
    },
  },
  {
    id: 'copro_search',
    category: 'copro',
    label: 'Recherche par Nom de Copropriété (RNIC)',
    column: 'nom_copro',
    source: 'ANAH RNIC',
    desc: 'Rechercher une résidence ou un syndicat de copropriétaires par son nom.',
    controlType: 'text',
    placeholder: 'Ex: Le Clos, Les Terrasses, SDC...',
    isActive: (s) => Boolean((s.dynFilters.copro_search || '').trim()),
    reset: (s) => { delete s.dynFilters.copro_search; },
    getValue: (s) => s.dynFilters.copro_search || '',
    setValue: (s, v) => { s.dynFilters.copro_search = v || ''; },
    matches: (s, b) => {
      const q = (s.dynFilters.copro_search || '').toLowerCase().trim();
      if (!q) return true;
      return String(b.nom_copro || '').toLowerCase().includes(q);
    },
  },
  {
    id: 'nb_lots_copro',
    category: 'copro',
    label: 'Taille de la copropriété (Nb min. de lots d\'habitation RNIC)',
    column: 'nb_lots_habitation_copro',
    source: 'ANAH RNIC',
    desc: 'Cibler les grandes copropriétés dégradées ou les petites copropriétés sans syndic professionnel.',
    controlType: 'number_min',
    min: 0, max: 1000, step: 5, placeholder: 'Ex: 20 lots d\'habitation',
    isActive: (s) => Number(s.dynFilters.nb_lots_copro || 0) > 0,
    reset: (s) => { delete s.dynFilters.nb_lots_copro; },
    getValue: (s) => s.dynFilters.nb_lots_copro || 0,
    setValue: (s, v) => { s.dynFilters.nb_lots_copro = Number(v || 0); },
    matches: (s, b) => Number(b.nb_lots_habitation_copro || 0) >= Number(s.dynFilters.nb_lots_copro || 0),
  },
  {
    id: 'type_vitrage',
    category: 'copro',
    label: 'Qualité des fenêtres / Type de vitrage',
    column: 'type_vitrage',
    source: 'ADEME DPE',
    desc: 'Le maintien de simple vitrage est un marqueur classique de sous-investissement chronique du bailleur (parois froides, condensation, bruit).',
    controlType: 'select',
    options: [
      { value: '', label: 'Tous types de vitrages' },
      { value: 'simple', label: '🚨 Simple vitrage (Habitat dégradé / parois froides)' },
      { value: 'double', label: '🪟 Double vitrage' },
      { value: 'triple', label: '✨ Triple vitrage ou survitrage' },
    ],
    isActive: (s) => Boolean(s.dynFilters.type_vitrage),
    reset: (s) => { delete s.dynFilters.type_vitrage; },
    getValue: (s) => s.dynFilters.type_vitrage || '',
    setValue: (s, v) => { s.dynFilters.type_vitrage = v || ''; },
    matches: (s, b) => {
      const val = s.dynFilters.type_vitrage;
      if (!val) return true;
      const vit = String(b.type_vitrage || '').toLowerCase();
      if (val === 'simple') return vit.includes('simple');
      if (val === 'double') return vit.includes('double');
      if (val === 'triple') return vit.includes('triple') || vit.includes('survitrage');
      return true;
    },
  },
  {
    id: 'type_ventilation',
    category: 'copro',
    label: 'Système de ventilation (Risque d\'humidité & moisissures)',
    column: 'type_ventilation',
    source: 'ADEME DPE',
    desc: 'L\'absence de VMC mécanique (ventilation uniquement par ouverture des fenêtres ou grilles naturelles) favorise les moisissures et pathologies respiratoires (asthme).',
    controlType: 'select',
    options: [
      { value: '', label: 'Tous systèmes de ventilation' },
      { value: 'naturelle', label: '🚨 Sans VMC / Ventilation par ouverture des fenêtres ou naturelle' },
      { value: 'vmc', label: '🌀 VMC mécanique (Simple ou Double flux)' },
    ],
    isActive: (s) => Boolean(s.dynFilters.type_ventilation),
    reset: (s) => { delete s.dynFilters.type_ventilation; },
    getValue: (s) => s.dynFilters.type_ventilation || '',
    setValue: (s, v) => { s.dynFilters.type_ventilation = v || ''; },
    matches: (s, b) => {
      const val = s.dynFilters.type_ventilation;
      if (!val) return true;
      const vent = String(b.type_ventilation || '').toLowerCase();
      if (val === 'naturelle') return vent.includes('ouverture') || vent.includes('naturelle') || vent.includes('entrée d\'air');
      if (val === 'vmc') return vent.includes('vmc') || vent.includes('mécanique') || vent.includes('mecanique');
      return true;
    },
  },
  {
    id: 'type_isolation_mur_exterieur',
    category: 'copro',
    label: 'Isolation des murs extérieurs',
    column: 'type_isolation_mur_exterieur',
    source: 'ADEME DPE',
    desc: 'Identifier les façades non isolées (ponts thermiques et humidité de condensation sur les murs froids).',
    controlType: 'select',
    options: [
      { value: '', label: 'Tous états d\'isolation des murs' },
      { value: 'non isol', label: '🚨 Murs extérieurs NON isolés' },
      { value: 'iti', label: 'Isolation par l\'intérieur (ITI)' },
      { value: 'ite', label: 'Isolation par l\'extérieur (ITE)' },
    ],
    isActive: (s) => Boolean(s.dynFilters.type_isolation_mur_exterieur),
    reset: (s) => { delete s.dynFilters.type_isolation_mur_exterieur; },
    getValue: (s) => s.dynFilters.type_isolation_mur_exterieur || '',
    setValue: (s, v) => { s.dynFilters.type_isolation_mur_exterieur = v || ''; },
    matches: (s, b) => {
      const val = s.dynFilters.type_isolation_mur_exterieur;
      if (!val) return true;
      const mur = String(b.type_isolation_mur_exterieur || '').toLowerCase();
      return mur.includes(val);
    },
  },
  {
    id: 'type_isolation_plancher_bas',
    category: 'copro',
    label: 'Isolation du plancher bas (Rez-de-chaussée / caves)',
    column: 'type_isolation_plancher_bas',
    source: 'ADEME DPE',
    desc: 'Un plancher bas non isolé rend les logements de rez-de-chaussée glacials en hiver.',
    controlType: 'select',
    options: [
      { value: '', label: 'Tous états du plancher bas' },
      { value: 'non isol', label: '🚨 Plancher bas NON isolé' },
      { value: 'isol', label: '✅ Plancher bas isolé' },
    ],
    isActive: (s) => Boolean(s.dynFilters.type_isolation_plancher_bas),
    reset: (s) => { delete s.dynFilters.type_isolation_plancher_bas; },
    getValue: (s) => s.dynFilters.type_isolation_plancher_bas || '',
    setValue: (s, v) => { s.dynFilters.type_isolation_plancher_bas = v || ''; },
    matches: (s, b) => {
      const val = s.dynFilters.type_isolation_plancher_bas;
      if (!val) return true;
      const pb = String(b.type_isolation_plancher_bas || '').toLowerCase();
      if (val === 'non isol') return pb.includes('non isol');
      if (val === 'isol') return pb.includes('isol') && !pb.includes('non isol');
      return true;
    },
  },
  {
    id: 'surface_habitable_logement',
    category: 'copro',
    label: 'Surface habitable représentative (Ciblage studios & micro-logements)',
    column: 'surface_habitable_logement',
    source: 'ADEME DPE',
    desc: 'Les très petites surfaces (< 30 m²) concentrent les étudiants, jeunes précaires et travailleurs pauvres et sont structurellement défavorisées au DPE.',
    controlType: 'select',
    options: [
      { value: '', label: 'Toutes surfaces de logement' },
      { value: 'micro', label: '📦 Studios & Micro-logements (< 30 m²)' },
      { value: 'small', label: '🚪 Petits logements T1/T2 (< 45 m²)' },
      { value: 'family', label: '👨‍👩‍👧‍👦 Logements familiaux (≥ 70 m²)' },
    ],
    isActive: (s) => Boolean(s.dynFilters.surface_habitable_logement),
    reset: (s) => { delete s.dynFilters.surface_habitable_logement; },
    getValue: (s) => s.dynFilters.surface_habitable_logement || '',
    setValue: (s, v) => { s.dynFilters.surface_habitable_logement = v || ''; },
    matches: (s, b) => {
      const val = s.dynFilters.surface_habitable_logement;
      if (!val) return true;
      const surf = Number(b.surface_habitable_logement || 0);
      if (surf <= 0) return false;
      if (val === 'micro') return surf < 30;
      if (val === 'small') return surf < 45;
      if (val === 'family') return surf >= 70;
      return true;
    },
  },

  /* ========================================================================
     6. MORPHOLOGIE URBAINE, ÉPOQUE & RISQUES SANITAIRES / ABF (11)
     ======================================================================== */
  {
    id: 'nb_log',
    category: 'morphology',
    label: 'Taille de l\'immeuble (Nombre min. de logements)',
    column: 'nb_log',
    source: 'DGFiP FFO / BDNB',
    desc: 'Cibler l\'habitat collectif (ex: ≥ 10 logements) pour rentabiliser les campagnes de porte-à-porte.',
    controlType: 'slider',
    min: 1, max: 50, step: 1, unit: ' log.',
    isActive: (s) => Number(s.minLog || 1) > 1,
    reset: (s) => { s.minLog = 1; },
    getValue: (s) => s.minLog || 1,
    setValue: (s, v) => { s.minLog = Number(v || 1); },
    matches: (s, b) => Number(b.nb_log || 0) >= Number(s.minLog || 1),
  },
  {
    id: 'nb_niveau',
    category: 'morphology',
    label: 'Hauteur en étages (Nombre min. de niveaux)',
    column: 'nb_niveau',
    source: 'DGFiP FFO',
    desc: 'Filtrer selon le nombre d\'étages (important pour la pénibilité sans ascenseur ou les grands ensembles).',
    controlType: 'slider',
    min: 1, max: 15, step: 1, unit: ' niv.',
    isActive: (s) => Number(s.dynFilters.nb_niveau || 1) > 1,
    reset: (s) => { delete s.dynFilters.nb_niveau; },
    getValue: (s) => s.dynFilters.nb_niveau || 1,
    setValue: (s, v) => { s.dynFilters.nb_niveau = Number(v || 1); },
    matches: (s, b) => Number(b.nb_niveau || 0) >= Number(s.dynFilters.nb_niveau || 1),
  },
  {
    id: 'hauteur_moyenne_m',
    category: 'morphology',
    label: 'Hauteur géométrique IGN min. (mètres)',
    column: 'hauteur_moyenne_m',
    source: 'IGN BD TOPO',
    desc: 'Hauteur mesurée par modélisation 3D IGN.',
    controlType: 'slider',
    min: 0, max: 45, step: 3, unit: ' m',
    isActive: (s) => Number(s.dynFilters.hauteur_moyenne_m || 0) > 0,
    reset: (s) => { delete s.dynFilters.hauteur_moyenne_m; },
    getValue: (s) => s.dynFilters.hauteur_moyenne_m || 0,
    setValue: (s, v) => { s.dynFilters.hauteur_moyenne_m = Number(v || 0); },
    matches: (s, b) => Number(b.hauteur_moyenne_m || 0) >= Number(s.dynFilters.hauteur_moyenne_m || 0),
  },
  {
    id: 'annee_construction',
    category: 'morphology',
    label: 'Année de construction (Plage min / max)',
    column: 'annee_construction',
    source: 'DGFiP FFO',
    desc: 'Filtrer par période historique précise (ex: 1945 à 1974 pour les barres d\'après-guerre non isolées).',
    controlType: 'range_min_max',
    minPlaceholder: 'Année min (ex: 1945)',
    maxPlaceholder: 'Année max (ex: 1974)',
    isActive: (s) => Boolean(s.dynFilters.annee_min || s.dynFilters.annee_max),
    reset: (s) => { delete s.dynFilters.annee_min; delete s.dynFilters.annee_max; },
    getValue: (s) => ({ min: s.dynFilters.annee_min || '', max: s.dynFilters.annee_max || '' }),
    setValue: (s, v) => {
      if (v) {
        s.dynFilters.annee_min = v.min || '';
        s.dynFilters.annee_max = v.max || '';
      }
    },
    matches: (s, b) => {
      const minY = Number(s.dynFilters.annee_min || 0);
      const maxY = Number(s.dynFilters.annee_max || 0);
      if (!minY && !maxY) return true;
      const y = Number(b.annee_construction || 0);
      if (!y) return false;
      if (minY && y < minY) return false;
      if (maxY && y > maxY) return false;
      return true;
    },
  },
  {
    id: 'periode_construction_dpe',
    category: 'morphology',
    label: 'Grande époque constructive (Histoire urbaine)',
    column: 'periode_construction_dpe',
    source: 'ADEME DPE / FFO',
    desc: 'Cibler les grandes vagues constructives : bâti ancien (< 1948), Trente Glorieuses sans réglementation thermique (1948-1974), etc.',
    controlType: 'select',
    options: [
      { value: '', label: 'Toutes époques constructives' },
      { value: 'avant_1948', label: '🏛️ Avant 1948 (Bâti ancien / centre historique)' },
      { value: '1948_1974', label: '🏗️ 1948 – 1974 (Trente Glorieuses / avant 1re RT)' },
      { value: '1975_1989', label: '🧱 1975 – 1989 (Premières réglementations thermiques)' },
      { value: '1990_2005', label: '🏘️ 1990 – 2005' },
      { value: 'apres_2006', label: '✨ Après 2006 (Bâti récent RT2005 / RT2012)' },
    ],
    isActive: (s) => Boolean(s.dynFilters.periode_construction_dpe),
    reset: (s) => { delete s.dynFilters.periode_construction_dpe; },
    getValue: (s) => s.dynFilters.periode_construction_dpe || '',
    setValue: (s, v) => { s.dynFilters.periode_construction_dpe = v || ''; },
    matches: (s, b) => {
      const val = s.dynFilters.periode_construction_dpe;
      if (!val) return true;
      const y = Number(b.annee_construction || 0);
      const p = String(b.periode_construction_dpe || '').toLowerCase();
      if (val === 'avant_1948') return (y > 0 && y < 1948) || p.includes('avant 1948');
      if (val === '1948_1974') return (y >= 1948 && y <= 1974) || p.includes('1948-1974');
      if (val === '1975_1989') return (y >= 1975 && y <= 1989) || p.includes('1975-1977') || p.includes('1978-1982') || p.includes('1983-1988');
      if (val === '1990_2005') return (y >= 1990 && y <= 2005) || p.includes('1989-2000') || p.includes('2001-2005');
      if (val === 'apres_2006') return y >= 2006 || p.includes('2006-2012') || p.includes('2013');
      return true;
    },
  },
  {
    id: 'usage_niveau_1_txt',
    category: 'morphology',
    label: 'Typologie d\'usage (Collectif vs Individuel)',
    column: 'usage_niveau_1_txt',
    source: 'BDNB Synthèse',
    desc: 'Distinguer l\'habitat collectif, l\'habitat individuel pavillonnaire et les immeubles mixtes (commerces en RDC).',
    controlType: 'select',
    options: [
      { value: '', label: 'Toutes typologies d\'usage' },
      { value: 'collectif', label: '🏢 Résidentiel collectif' },
      { value: 'individuel', label: '🏠 Résidentiel individuel' },
      { value: 'tertiaire', label: '🏪 Mixte / Tertiaire' },
    ],
    isActive: (s) => Boolean(s.dynFilters.usage_niveau_1_txt),
    reset: (s) => { delete s.dynFilters.usage_niveau_1_txt; },
    getValue: (s) => s.dynFilters.usage_niveau_1_txt || '',
    setValue: (s, v) => { s.dynFilters.usage_niveau_1_txt = v || ''; },
    matches: (s, b) => {
      const val = s.dynFilters.usage_niveau_1_txt;
      if (!val) return true;
      return String(b.usage_niveau_1_txt || '').toLowerCase().includes(val);
    },
  },
  {
    id: 'mat_mur_txt',
    category: 'morphology',
    label: 'Matériau principal des murs extérieurs',
    column: 'mat_mur_txt',
    source: 'DGFiP FFO',
    desc: 'Pierre, pisé/terre (spécifique région lyonnaise/dauphinoise), béton banché, brique ou bois.',
    controlType: 'select',
    options: [
      { value: '', label: 'Tous matériaux de murs' },
      { value: 'béton', label: '🧱 Béton / Aggloméré' },
      { value: 'pierre', label: '🪨 Pierre / Moellons' },
      { value: 'brique', label: '🧱 Brique' },
      { value: 'bois', label: '🪵 Bois' },
    ],
    isActive: (s) => Boolean(s.dynFilters.mat_mur_txt),
    reset: (s) => { delete s.dynFilters.mat_mur_txt; },
    getValue: (s) => s.dynFilters.mat_mur_txt || '',
    setValue: (s, v) => { s.dynFilters.mat_mur_txt = v || ''; },
    matches: (s, b) => {
      const val = s.dynFilters.mat_mur_txt;
      if (!val) return true;
      return String(b.mat_mur_txt || '').toLowerCase().includes(val);
    },
  },
  {
    id: 'patrimoine_abf',
    category: 'morphology',
    label: 'Périmètre Monument Historique / Architecte des Bâtiments de France (ABF)',
    column: 'dans_perimetre_abf',
    source: 'GPU Urbanisme / BDNB',
    desc: 'Les bailleurs invoquent parfois la contrainte ABF pour justifier l\'absence d\'isolation par l\'extérieur (ITE) ou de volets.',
    controlType: 'select',
    options: [
      { value: '', label: 'Tous secteurs (ABF et hors ABF)' },
      { value: 'in_abf', label: '🏛️ En périmètre protégé ABF / Monument Historique' },
      { value: 'out_abf', label: 'Hors périmètre ABF (aucune contrainte patrimoniale)' },
    ],
    isActive: (s) => Boolean(s.dynFilters.patrimoine_abf),
    reset: (s) => { delete s.dynFilters.patrimoine_abf; },
    getValue: (s) => s.dynFilters.patrimoine_abf || '',
    setValue: (s, v) => { s.dynFilters.patrimoine_abf = v || ''; },
    matches: (s, b) => {
      const val = s.dynFilters.patrimoine_abf;
      if (!val) return true;
      const inAbf = Boolean(b.dans_perimetre_abf);
      return val === 'in_abf' ? inAbf : !inAbf;
    },
  },
  {
    id: 'alea_radon',
    category: 'morphology',
    label: 'Risque sanitaire : Exposition au gaz Radon (IRSN)',
    column: 'alea_radon',
    source: 'IRSN / BDNB',
    desc: 'Gaz radioactif naturel cancérigène qui s\'accumule dans les rez-de-chaussée mal ventilés.',
    controlType: 'select',
    options: [
      { value: '', label: 'Toutes zones Radon' },
      { value: 'moyen_fort', label: '☢️ Potentiel Radon Moyen ou Élevé' },
      { value: 'fort', label: '☢️ Potentiel Radon Élevé (Catégorie 3)' },
    ],
    isActive: (s) => Boolean(s.dynFilters.alea_radon),
    reset: (s) => { delete s.dynFilters.alea_radon; },
    getValue: (s) => s.dynFilters.alea_radon || '',
    setValue: (s, v) => { s.dynFilters.alea_radon = v || ''; },
    matches: (s, b) => {
      const val = s.dynFilters.alea_radon;
      if (!val) return true;
      const r = String(b.alea_radon || '').toLowerCase();
      if (val === 'fort') return r.includes('élevé') || r.includes('eleve') || r.includes('3') || r.includes('fort');
      if (val === 'moyen_fort') return r.includes('moyen') || r.includes('élevé') || r.includes('eleve') || r.includes('2') || r.includes('3');
      return true;
    },
  },
  {
    id: 'alea_argile',
    category: 'morphology',
    label: 'Risque structurel : Retrait-Gonflement des Argiles (Fissures)',
    column: 'alea_argile',
    source: 'BRGM / Géorisques',
    desc: 'Exposition des fondations aux sécheresses provoquant des fissurations structurelles du bâti.',
    controlType: 'select',
    options: [
      { value: '', label: 'Tous niveaux d\'aléa argiles' },
      { value: 'moyen_fort', label: '⚠️ Aléa Argiles Moyen ou Fort' },
      { value: 'fort', label: '🚨 Aléa Argiles Fort' },
    ],
    isActive: (s) => Boolean(s.dynFilters.alea_argile),
    reset: (s) => { delete s.dynFilters.alea_argile; },
    getValue: (s) => s.dynFilters.alea_argile || '',
    setValue: (s, v) => { s.dynFilters.alea_argile = v || ''; },
    matches: (s, b) => {
      const val = s.dynFilters.alea_argile;
      if (!val) return true;
      const a = String(b.alea_argile || '').toLowerCase();
      if (val === 'fort') return a.includes('fort');
      if (val === 'moyen_fort') return a.includes('moyen') || a.includes('fort');
      return true;
    },
  },
  {
    id: 'distance_reseau_chaleur',
    category: 'morphology',
    label: 'Proximité d\'un Réseau de Chaleur Urbain (Décarbonation)',
    column: 'distance_reseau_chaleur',
    source: 'CEREMA / France Chaleur Urbaine',
    desc: 'Identifier les passoires chauffées au gaz ou au fioul situées à moins de 150 m d\'un réseau de chaleur urbain (raccordement subventionnable).',
    controlType: 'select',
    options: [
      { value: '', label: 'Toutes distances aux réseaux de chaleur' },
      { value: 'very_close', label: '🏭 Très proche d\'un réseau de chaleur (≤ 50 m)' },
      { value: 'close', label: '🔥 Raccordable (≤ 150 m ou en périmètre prioritaire)' },
      { value: 'far', label: 'Éloigné des réseaux de chaleur (> 150 m)' },
    ],
    isActive: (s) => Boolean(s.dynFilters.distance_reseau_chaleur),
    reset: (s) => { delete s.dynFilters.distance_reseau_chaleur; },
    getValue: (s) => s.dynFilters.distance_reseau_chaleur || '',
    setValue: (s, v) => { s.dynFilters.distance_reseau_chaleur = v || ''; },
    matches: (s, b) => {
      const val = s.dynFilters.distance_reseau_chaleur;
      if (!val) return true;
      const d = b.distance_reseau_chaleur != null ? Number(b.distance_reseau_chaleur) : 99999;
      const prio = b.rcu_perimetre_prioritaire === true || String(b.rcu_perimetre_prioritaire).toLowerCase() === 'true';
      if (val === 'very_close') return d <= 50;
      if (val === 'close') return d <= 150 || prio;
      if (val === 'far') return d > 150 && !prio;
      return true;
    },
  },

  /* ========================================================================
     7. GÉOGRAPHIE FINE, QUARTIERS IRIS & ENQUÊTE DE TERRAIN (.XLSX) (4)
     ======================================================================== */
  {
    id: 'commune_filter',
    category: 'geography',
    label: 'Commune, Arrondissement ou Code Postal',
    column: 'libelle_commune_insee',
    source: 'INSEE / BAN',
    desc: 'Filtrer sur une commune ou un arrondissement précis au sein du territoire chargé (ex: Lyon 3e, Villeurbanne, Grenoble, 69007...).',
    controlType: 'text',
    placeholder: 'Ex: Lyon 7, Villeurbanne, 69003, Grenoble...',
    isActive: (s) => Boolean((s.dynFilters.commune_filter || '').trim()),
    reset: (s) => { delete s.dynFilters.commune_filter; },
    getValue: (s) => s.dynFilters.commune_filter || '',
    setValue: (s, v) => { s.dynFilters.commune_filter = v || ''; },
    matches: (s, b) => {
      const q = (s.dynFilters.commune_filter || '').toLowerCase().trim();
      if (!q) return true;
      return String(b.libelle_commune_insee || '').toLowerCase().includes(q) ||
             String(b.cp || '').toLowerCase().includes(q) ||
             String(b.code_commune_insee || '').toLowerCase().includes(q);
    },
  },
  {
    id: 'iris_search',
    category: 'geography',
    label: 'Îlot statistique INSEE (Code IRIS)',
    column: 'code_iris',
    source: 'INSEE IRIS',
    desc: 'Cibler un îlot IRIS précis pour croiser avec les statistiques socio-économiques INSEE (taux de pauvreté, familles monoparentales).',
    controlType: 'text',
    placeholder: 'Ex: 693870101, 38185...',
    isActive: (s) => Boolean((s.dynFilters.iris_search || '').trim()),
    reset: (s) => { delete s.dynFilters.iris_search; },
    getValue: (s) => s.dynFilters.iris_search || '',
    setValue: (s, v) => { s.dynFilters.iris_search = v || ''; },
    matches: (s, b) => {
      const q = (s.dynFilters.iris_search || '').toLowerCase().trim();
      if (!q) return true;
      return String(b.code_iris || '').toLowerCase().includes(q);
    },
  },
  {
    id: 'adr_search',
    category: 'geography',
    label: 'Recherche par nom de rue ou adresse',
    column: 'adr',
    source: 'BAN Adresses',
    desc: 'Filtrer tous les bâtiments d\'une rue, avenue ou place donnée.',
    controlType: 'text',
    placeholder: 'Ex: Rue Paul Bert, Cours Berriat, Avenue Jean Jaurès...',
    isActive: (s) => Boolean((s.dynFilters.adr_search || '').trim()),
    reset: (s) => { delete s.dynFilters.adr_search; },
    getValue: (s) => s.dynFilters.adr_search || '',
    setValue: (s, v) => { s.dynFilters.adr_search = v || ''; },
    matches: (s, b) => {
      const q = (s.dynFilters.adr_search || '').toLowerCase().trim();
      if (!q) return true;
      return String(b.adr || '').toLowerCase().includes(q);
    },
  },
  {
    id: 'fieldwork_status',
    category: 'geography',
    label: 'Statut dans l\'enquête de terrain (.xlsx importé)',
    column: 'batiment_groupe_id',
    source: 'Tableur militant (.xlsx)',
    desc: 'Afficher uniquement les immeubles déjà visités (présents dans votre fichier .xlsx) ou ceux restant à enquêter.',
    controlType: 'select',
    options: [
      { value: '', label: 'Tous les immeubles (visités ou non)' },
      { value: 'visited', label: '📋 Déjà enquêtés / présents dans le tableur .xlsx' },
      { value: 'unvisited', label: '🧭 Restant à visiter (absents du tableur .xlsx)' },
    ],
    isActive: (s) => Boolean(s.dynFilters.fieldwork_status),
    reset: (s) => { delete s.dynFilters.fieldwork_status; },
    getValue: (s) => s.dynFilters.fieldwork_status || '',
    setValue: (s, v) => { s.dynFilters.fieldwork_status = v || ''; },
    matches: (s, b) => {
      const val = s.dynFilters.fieldwork_status;
      if (!val) return true;
      const inFw = s.fieldwork && s.fieldwork.has(b.batiment_groupe_id);
      return val === 'visited' ? inFw : !inFw;
    },
  },
];

// Populate 'complete' profile with all filter IDs
const completeProfile = BUILTIN_PROFILES.find(p => p.id === 'complete');
if (completeProfile) {
  completeProfile.filterIds = FILTER_DEFINITIONS.map(f => f.id);
}

/* ==========================================================================
   Sociological Filter System UI & Profile Management
   ========================================================================== */
function initSociologicalFilterSystem() {
  loadCustomProfilesFromStorage();

  const totalCountEl = document.getElementById('total-controls-count');
  const catalogTotalEl = document.getElementById('catalog-total-available');
  if (totalCountEl) totalCountEl.textContent = String(FILTER_DEFINITIONS.length);
  if (catalogTotalEl) catalogTotalEl.textContent = String(FILTER_DEFINITIONS.length);

  renderProfileButtons();
  renderSidebarFilterControls();
  renderCatalogModalContent();
  updateFilterCountsUI();
  updateLoadedDataButtonUI();

  // Top "Données chargées" button in sidebar
  document.getElementById('btn-sidebar-donnees-chargees')?.addEventListener('click', () => {
    const mapTabBtn = document.querySelector('button[data-tab="map"]');
    const wasOnOtherTab = Boolean(mapTabBtn && !mapTabBtn.classList.contains('active'));
    if (wasOnOtherTab) {
      mapTabBtn.click();
    }
    if (state.territorySelectionMode && !wasOnOtherTab) {
      exitTerritorySelectionMode();
    } else {
      enterTerritorySelectionMode();
    }
  });

  // Wire "Choisir les filtres" button
  document.getElementById('btn-open-filter-catalog')?.addEventListener('click', () => {
    renderCatalogModalContent();
    document.getElementById('modal-filter-catalog')?.classList.add('open');
    document.getElementById('input-catalog-search')?.focus();
  });

  document.getElementById('btn-close-filter-catalog')?.addEventListener('click', () => {
    document.getElementById('modal-filter-catalog')?.classList.remove('open');
  });

  document.getElementById('btn-apply-filter-catalog')?.addEventListener('click', () => {
    document.getElementById('modal-filter-catalog')?.classList.remove('open');
    renderSidebarFilterControls();
    applyFilters();
    saveSessionToStorage();
  });

  // Catalog Search input
  document.getElementById('input-catalog-search')?.addEventListener('input', (e) => {
    state.catalogSearchQuery = e.target.value.trim();
    renderCatalogCategoriesGrid();
  });

  // Catalog Select Minimum (active or essential only)

  document.getElementById('btn-catalog-select-none')?.addEventListener('click', () => {
    const visibleFilters = getCatalogVisibleFilters();
    for (const f of visibleFilters) {
      if (!f.isActive(state)) {
        state.activeFilterIds.delete(f.id);
      }
    }
    if (state.activeFilterIds.size === 0) {
      state.activeFilterIds.add('dpe');
    }
    state.activeProfileId = 'custom_selection';
    renderProfileButtons();
    renderCatalogCategoriesGrid();
    renderSidebarFilterControls();
    updateFilterCountsUI();
    saveSessionToStorage();
  });

  // Catalog Expand All / Collapse All
  document.getElementById('btn-catalog-expand-all')?.addEventListener('click', () => {
    const container = document.getElementById('catalog-categories-list');
    if (!container) return;
    if (!state.catalogCategoryFoldState) state.catalogCategoryFoldState = new Map();
    container.querySelectorAll('details.catalog-category-block').forEach(d => {
      d.open = true;
      const catId = d.getAttribute('data-cat-id');
      if (catId) state.catalogCategoryFoldState.set(catId, true);
    });
  });

  document.getElementById('btn-catalog-collapse-all')?.addEventListener('click', () => {
    const container = document.getElementById('catalog-categories-list');
    if (!container) return;
    if (!state.catalogCategoryFoldState) state.catalogCategoryFoldState = new Map();
    container.querySelectorAll('details.catalog-category-block').forEach(d => {
      d.open = false;
      const catId = d.getAttribute('data-cat-id');
      if (catId) state.catalogCategoryFoldState.set(catId, false);
    });
  });

  // Save Profile Modal wiring
  const openSaveProfileModal = () => {
    const countEl = document.getElementById('save-profile-controls-count');
    if (countEl) countEl.textContent = String(state.activeFilterIds.size);
    const nameInput = document.getElementById('input-profile-name');
    const descInput = document.getElementById('input-profile-desc');
    if (nameInput) nameInput.value = '';
    if (descInput) descInput.value = '';
    document.getElementById('modal-save-profile')?.classList.add('open');
    setTimeout(() => nameInput?.focus(), 100);
  };

  document.getElementById('btn-open-save-profile')?.addEventListener('click', openSaveProfileModal);
  document.getElementById('btn-catalog-save-profile')?.addEventListener('click', openSaveProfileModal);
  document.getElementById('btn-close-save-profile')?.addEventListener('click', () => {
    document.getElementById('modal-save-profile')?.classList.remove('open');
  });
  document.getElementById('btn-cancel-save-profile')?.addEventListener('click', () => {
    document.getElementById('modal-save-profile')?.classList.remove('open');
  });
  document.getElementById('btn-confirm-save-profile')?.addEventListener('click', handleConfirmSaveProfile);
}

function loadCustomProfilesFromStorage() {
  try {
    const raw = localStorage.getItem(CUSTOM_PROFILES_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        state.customProfiles = parsed;
      }
    }
  } catch (e) {
    console.warn('Could not load custom profiles from localStorage:', e);
  }
}

function saveCustomProfilesToStorage() {
  try {
    localStorage.setItem(CUSTOM_PROFILES_STORAGE_KEY, JSON.stringify(state.customProfiles));
  } catch (e) {
    console.warn('Could not save custom profiles to localStorage:', e);
  }
}

/* ==========================================================================
   Full Session Persistence (Loaded Data, Profile, Selected Filters & Values)
   ========================================================================== */
let saveSessionDebounceTimer = null;
function scheduleSaveSession(delay = 250) {
  clearTimeout(saveSessionDebounceTimer);
  saveSessionDebounceTimer = setTimeout(() => {
    saveSessionToStorage();
  }, delay);
}

function saveSessionToStorage() {
  clearTimeout(saveSessionDebounceTimer);
  try {
    // 1. Territory & Loaded Data
    const hasLoadedData = Boolean(state.buildings && state.buildings.length > 0);
    const territoryData = {
      hasLoadedData,
      activeTerritory: state.activeTerritory ? {
        mode: state.activeTerritory.mode,
        chunkIds: Array.isArray(state.activeTerritory.chunkIds) ? Array.from(state.activeTerritory.chunkIds) : [],
        dep: state.activeTerritory.dep || '69',
        cp: state.activeTerritory.cp || null,
        range: state.activeTerritory.range || [69001, 69009],
      } : null,
      territorySelectionMode: Boolean(state.territorySelectionMode),
      pendingSelectedChunks: Array.from(state.pendingSelectedChunks || []),
    };

    // 2. Active Profile
    const activeProfileId = state.activeProfileId || 'essential';

    // 3. Selected Filters (IDs of active indicators in sidebar/catalog)
    const activeFilterIds = Array.from(state.activeFilterIds || []);

    // 4. Filter Values (values of all indicators)
    const filterValues = {};
    for (const f of FILTER_DEFINITIONS) {
      try {
        filterValues[f.id] = f.getValue(state);
      } catch (err) {
        console.warn(`Error getting value for filter ${f.id}:`, err);
      }
    }

    // 5. Screen & View State (Tab, Map style, Dimming, Max polygons, Center/Zoom, Inspector)
    let mapViewport = null;
    if (state.map && typeof state.map.getCenter === 'function') {
      try {
        const center = state.map.getCenter();
        const zoom = state.map.getZoom();
        if (center && typeof center.lng === 'number' && typeof center.lat === 'number') {
          mapViewport = {
            center: [Number(center.lng.toFixed(5)), Number(center.lat.toFixed(5))],
            zoom: Number(zoom.toFixed(2)),
          };
        }
      } catch (e) {
        // Map may not be initialized yet
      }
    }

    const tableSearchQuery = document.getElementById('table-search-query')?.value || '';
    const tableSearchMode = document.getElementById('table-search-mode')?.value || 'all';
    const inspectedLandlord = document.getElementById('input-manual-siren')?.value ||
                              document.getElementById('select-landlord-to-inspect')?.value || '';

    const overlay = document.getElementById('map-display-overlay');
    const isOverlayCollapsed = overlay ? overlay.classList.contains('collapsed') : true;

    const screenState = {
      activeTab: state.activeTab || 'map',
      mapStyleMode: state.mapStyleMode || 'dpe',
      bgDimPct: state.bgDimPct !== undefined ? state.bgDimPct : 20,
      maxPolygons: state.maxPolygons || 3000,
      mapDisplayOverlayCollapsed: isOverlayCollapsed,
      selectedBuildingId: state.selectedBuildingId || null,
      mapViewport,
      tableSearchQuery,
      tableSearchMode,
      inspectedLandlord,
    };

    const payload = {
      version: 1,
      savedAt: Date.now(),
      territoryData,
      activeProfileId,
      activeFilterIds,
      filterValues,
      screenState,
      dataBaseUrl: state.dataBaseUrl,
    };

    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(payload));
  } catch (e) {
    console.warn('Could not save session to localStorage:', e);
  }
}

function loadSessionFromStorage() {
  try {
    const raw = localStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      return parsed;
    }
  } catch (e) {
    console.warn('Could not load session from localStorage:', e);
  }
  return null;
}

const MAP_DISPLAY_SETTINGS_STORAGE_KEY = 'tezeloma_map_display_settings_v1';

function saveMapDisplaySettingsToStorage() {
  try {
    const overlay = document.getElementById('map-display-overlay');
    const isCollapsed = overlay ? overlay.classList.contains('collapsed') : true;
    const settings = {
      collapsed: isCollapsed,
      bgDimPct: state.bgDimPct !== undefined ? state.bgDimPct : 20,
      maxPolygons: state.maxPolygons || 3000,
    };
    localStorage.setItem(MAP_DISPLAY_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch (e) {
    console.warn('Could not save map display settings:', e);
  }
}

function loadMapDisplaySettingsFromStorage() {
  try {
    const raw = localStorage.getItem(MAP_DISPLAY_SETTINGS_STORAGE_KEY);
    if (!raw) return { collapsed: true, bgDimPct: 20, maxPolygons: 3000 };
    const parsed = JSON.parse(raw);
    return {
      collapsed: parsed.collapsed !== undefined ? Boolean(parsed.collapsed) : true,
      bgDimPct: typeof parsed.bgDimPct === 'number' ? parsed.bgDimPct : 20,
      maxPolygons: typeof parsed.maxPolygons === 'number' ? parsed.maxPolygons : 3000,
    };
  } catch (e) {
    return { collapsed: true, bgDimPct: 20, maxPolygons: 3000 };
  }
}

function applyMapDisplaySettings(settings) {
  if (!settings) return;
  const overlay = document.getElementById('map-display-overlay');
  const btn = document.getElementById('btn-toggle-display-overlay');
  const isCollapsed = settings.collapsed !== undefined ? Boolean(settings.collapsed) : true;

  if (overlay) {
    if (isCollapsed) {
      overlay.classList.add('collapsed');
      if (btn) btn.textContent = '▸';
    } else {
      overlay.classList.remove('collapsed');
      if (btn) btn.textContent = '▾';
    }
  }

  if (settings.bgDimPct !== undefined) {
    state.bgDimPct = Number(settings.bgDimPct);
    const slider = document.getElementById('slider-bg-dim');
    if (slider) slider.value = String(state.bgDimPct);
    const label = document.getElementById('label-bg-dim');
    if (label) label.textContent = `${state.bgDimPct}%`;
    setMapDim(state.bgDimPct);
  }

  if (settings.maxPolygons !== undefined) {
    state.maxPolygons = Number(settings.maxPolygons);
    const select = document.getElementById('select-max-polygons');
    if (select) select.value = String(state.maxPolygons);
  }
}

function restoreFiltersFromSession(session) {
  if (!session) return;

  // Restore Active Profile ID
  if (session.activeProfileId) {
    state.activeProfileId = session.activeProfileId;
  }

  // Restore Active Filter IDs
  if (Array.isArray(session.activeFilterIds) && session.activeFilterIds.length > 0) {
    state.activeFilterIds = new Set(session.activeFilterIds);
  }

  // Restore Filter Values
  if (session.filterValues && typeof session.filterValues === 'object') {
    for (const f of FILTER_DEFINITIONS) {
      if (session.filterValues[f.id] !== undefined) {
        try {
          f.setValue(state, session.filterValues[f.id]);
        } catch (e) {
          console.warn(`Error restoring value for filter ${f.id}:`, e);
        }
      }
    }
  }
  clearUnselectedFilters();
}

function restoreScreenStateFromSession(session) {
  if (!session || !session.screenState) return;
  const ss = session.screenState;

  // 1. Map style mode
  if (ss.mapStyleMode) {
    state.mapStyleMode = ss.mapStyleMode;
    document.querySelectorAll('.map-style-btn').forEach(b => {
      b.classList.toggle('active', b.getAttribute('data-style') === state.mapStyleMode);
    });
    const colorSelect = document.getElementById('select-color-mode');
    if (colorSelect) colorSelect.value = state.mapStyleMode;
    updateLegend();
  }

  // 2. Background dimming
  if (ss.bgDimPct !== undefined) {
    state.bgDimPct = Number(ss.bgDimPct);
    const bgDimSlider = document.getElementById('slider-bg-dim');
    if (bgDimSlider) bgDimSlider.value = String(state.bgDimPct);
    const bgDimLbl = document.getElementById('label-bg-dim');
    if (bgDimLbl) bgDimLbl.textContent = `${state.bgDimPct}%`;
    setMapDim(state.bgDimPct);
  }

  // 3. Max polygons
  if (ss.maxPolygons) {
    state.maxPolygons = Number(ss.maxPolygons);
    const maxPolySelect = document.getElementById('select-max-polygons');
    if (maxPolySelect) maxPolySelect.value = String(state.maxPolygons);
  }

  // 4. Buildings Table Search
  if (ss.tableSearchQuery) {
    const qInput = document.getElementById('table-search-query');
    if (qInput) qInput.value = ss.tableSearchQuery;
  }
  if (ss.tableSearchMode) {
    const mSelect = document.getElementById('table-search-mode');
    if (mSelect) mSelect.value = ss.tableSearchMode;
  }

  // 5. Active Tab
  if (ss.activeTab && ss.activeTab !== 'map' && ['buildings'].includes(ss.activeTab)) {
    switchTab(ss.activeTab);
  }

  // 6. Map Display Overlay Collapsed State
  if (ss.mapDisplayOverlayCollapsed !== undefined) {
    const overlay = document.getElementById('map-display-overlay');
    const btn = document.getElementById('btn-toggle-display-overlay');
    if (overlay) {
      if (ss.mapDisplayOverlayCollapsed) {
        overlay.classList.add('collapsed');
        if (btn) btn.textContent = '▸';
      } else {
        overlay.classList.remove('collapsed');
        if (btn) btn.textContent = '▾';
      }
    }
  }
}

function getAllProfiles() {
  return [...BUILTIN_PROFILES, ...state.customProfiles];
}

function applyProfile(profileId) {
  const allProfiles = getAllProfiles();
  const prof = allProfiles.find(p => p.id === profileId);
  if (!prof) return;

  state.activeProfileId = prof.id;
  state.activeFilterIds = new Set(prof.filterIds);

  // Clear unselected filters so they never filter data or linger in state
  clearUnselectedFilters();

  // If custom profile has saved filter values, restore them
  if (prof.savedValues && typeof prof.savedValues === 'object') {
    for (const f of FILTER_DEFINITIONS) {
      f.reset(state);
    }
    // Keep default F/G unless savedValues overrides dpe
    for (const [fId, val] of Object.entries(prof.savedValues)) {
      const fDef = FILTER_DEFINITIONS.find(f => f.id === fId);
      if (fDef && fDef.setValue) {
        fDef.setValue(state, val);
      }
    }
  }

  // Switch map coloration if profile recommends one
  if (prof.mapStyleMode) {
    state.mapStyleMode = prof.mapStyleMode;
    const colorSelect = document.getElementById('select-color-mode');
    if (colorSelect) colorSelect.value = state.mapStyleMode;
    document.querySelectorAll('.map-style-btn').forEach(b => {
      b.classList.toggle('active', b.getAttribute('data-style') === state.mapStyleMode);
    });
    updateLegend();
  }

  renderProfileButtons();
  renderSidebarFilterControls();
  renderCatalogModalContent();
  applyFilters();
  saveSessionToStorage();
  showToast(`Profil activé : ${prof.icon} ${prof.name} (${prof.filterIds.length} filtres)`);
}

function deleteCustomProfile(profileId) {
  state.customProfiles = state.customProfiles.filter(p => p.id !== profileId);
  saveCustomProfilesToStorage();
  if (state.activeProfileId === profileId) {
    state.activeProfileId = 'essential';
  }
  renderProfileButtons();
  saveSessionToStorage();
  showToast('Profil personnalisé supprimé.');
}

function handleConfirmSaveProfile() {
  const nameInput = document.getElementById('input-profile-name');
  const descInput = document.getElementById('input-profile-desc');
  const iconSelect = document.getElementById('select-profile-icon');
  const saveValuesChk = document.getElementById('chk-profile-save-values');

  const name = (nameInput?.value || '').trim();
  if (!name) {
    alert('Veuillez donner un nom à votre profil (ex: Permanence ADIL, Passoires G Élec...).');
    nameInput?.focus();
    return;
  }

  const icon = iconSelect?.value || '🎯';
  const desc = (descInput?.value || '').trim() || `Profil personnalisé (${state.activeFilterIds.size} indicateurs)`;
  const shouldSaveValues = Boolean(saveValuesChk?.checked);

  let savedValues = null;
  if (shouldSaveValues) {
    savedValues = {};
    for (const f of FILTER_DEFINITIONS) {
      if (state.activeFilterIds.has(f.id) || f.isActive(state)) {
        savedValues[f.id] = f.getValue(state);
      }
    }
  }

  const newProfile = {
    id: `custom_${Date.now()}`,
    icon,
    name,
    desc,
    isCustom: true,
    mapStyleMode: state.mapStyleMode,
    filterIds: Array.from(state.activeFilterIds),
    savedValues,
  };

  state.customProfiles.push(newProfile);
  saveCustomProfilesToStorage();
  state.activeProfileId = newProfile.id;

  document.getElementById('modal-save-profile')?.classList.remove('open');
  renderProfileButtons();
  renderCatalogModalContent();
  saveSessionToStorage();
  showToast(`Nouveau profil « ${icon} ${name} » enregistré !`);
}

function renderProfileButtons() {
  const containers = [
    document.getElementById('profile-buttons-container'),
    document.getElementById('catalog-profile-buttons'),
  ].filter(Boolean);

  const allProfiles = getAllProfiles();

  for (const container of containers) {
    container.innerHTML = '';
    for (const prof of allProfiles) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `profile-pill-btn${prof.isCustom ? ' custom-profile' : ''}${state.activeProfileId === prof.id ? ' active' : ''}`;
      btn.title = `${prof.name} — ${prof.desc}`;
      btn.setAttribute('data-profile-id', prof.id);

      let inner = `<span>${prof.icon}</span><span>${escapeHtml(prof.name)}</span>`;
      if (prof.isCustom) {
        inner += `<span class="profile-delete-x" data-del-id="${escapeHtml(prof.id)}" title="Supprimer ce profil personnalisé">&times;</span>`;
      }
      btn.innerHTML = inner;

      btn.addEventListener('click', (e) => {
        const delTarget = e.target.closest('.profile-delete-x');
        if (delTarget) {
          e.stopPropagation();
          deleteCustomProfile(prof.id);
          return;
        }
        applyProfile(prof.id);
      });

      container.appendChild(btn);
    }
  }
}

function renderSidebarFilterControls() {
  const stack = document.getElementById('sociological-filters-container');
  if (!stack) return;

  // Remember which category accordions were open/closed
  const openStateByCat = new Map();
  stack.querySelectorAll('details.accordion-item[data-cat-id]').forEach(det => {
    openStateByCat.set(det.getAttribute('data-cat-id'), det.open);
  });

  stack.innerHTML = '';

  for (const cat of SOCIOLOGICAL_CATEGORIES) {
    const catFilters = FILTER_DEFINITIONS.filter(f => f.category === cat.id && state.activeFilterIds.has(f.id));
    if (catFilters.length === 0) continue;

    const activeInCat = catFilters.filter(f => f.isActive(state)).length;
    const details = document.createElement('details');
    details.className = 'accordion-item';
    details.setAttribute('data-cat-id', cat.id);
    details.open = openStateByCat.has(cat.id) ? openStateByCat.get(cat.id) : true;

    const summary = document.createElement('summary');
    summary.className = 'accordion-header';
    summary.innerHTML = `
      <span class="accordion-title-wrap">
        <span>${cat.icon}</span>
        <span>${escapeHtml(cat.shortLabel)}</span>
      </span>
      <span style="display:flex; align-items:center; gap:0.35rem;">
        <span class="cat-active-badge" style="font-size:0.66rem; padding:0.1rem 0.45rem; border-radius:999px; background:${activeInCat > 0 ? '#ffffff' : '#f8fafc'}; color:${activeInCat > 0 ? '#0284c7' : 'var(--text-muted)'}; border: 1px solid ${activeInCat > 0 ? '#38bdf8' : 'var(--border-color)'}; font-weight:700;">
          ${activeInCat > 0 ? `${activeInCat} actif${activeInCat > 1 ? 's' : ''}` : `${catFilters.length}`}
        </span>
        <span class="accordion-chevron">▶</span>
      </span>
    `;
    details.appendChild(summary);

    const body = document.createElement('div');
    body.className = 'accordion-body';

    for (const f of catFilters) {
      const card = buildFilterControlCard(f);
      body.appendChild(card);
    }

    details.appendChild(body);
    stack.appendChild(details);
  }

  updateFilterCountsUI();
}

function buildFilterControlCard(f) {
  const card = document.createElement('div');
  const isAct = f.isActive(state);
  card.className = `dyn-filter-card${isAct ? ' is-filtering' : ''}`;
  card.setAttribute('data-filter-id', f.id);

  // Header with label + value readout (for sliders) + remove button
  const header = document.createElement('div');
  header.className = 'dyn-filter-header';

  let valueBadgeHtml = '';
  if (f.controlType === 'slider') {
    const val = f.getValue(state);
    valueBadgeHtml = `<strong class="dyn-slider-val" id="lbl-val-${f.id}" style="color:var(--accent-primary); font-size:0.75rem; margin-left:auto; margin-right:0.25rem;">≥ ${val}${f.unit || ''}</strong>`;
  }

  header.innerHTML = `
    <span class="dyn-filter-label" title="${escapeHtml(f.desc)} (${escapeHtml(f.source)})">${escapeHtml(f.label)}</span>
    ${valueBadgeHtml}
    <button type="button" class="btn-remove-filter" title="Vider ce filtre (il reste dans le panneau ; le choix des filtres se fait dans le catalogue)">&times;</button>
  `;

  header.querySelector('.btn-remove-filter').addEventListener('click', () => {
    // Empty the filter only; it stays in the panel (selection is managed in the catalog dialog)
    f.reset(state);
    renderSidebarFilterControls();
    applyFilters();
    saveSessionToStorage();
  });

  card.appendChild(header);

  // Control Body
  const ctrlWrap = document.createElement('div');

  if (f.controlType === 'dpe_pills') {
    ctrlWrap.className = 'pill-group';
    ctrlWrap.id = 'filter-dpe';
    for (const dpe of f.options) {
      const btn = document.createElement('button');
      btn.type = 'button';
      const isSelected = state.selectedDpes.has(dpe);
      btn.className = `pill-btn dpe-${dpe.toLowerCase()}${isSelected ? ' active' : ''}`;
      btn.setAttribute('data-dpe', dpe);
      btn.textContent = dpe === 'Inconnu' ? 'NC' : dpe;
      btn.title = dpe === 'Inconnu' ? 'DPE Non connu / Non renseigné' : `Classe DPE ${dpe}`;
      btn.addEventListener('click', () => {
        if (state.selectedDpes.has(dpe)) {
          state.selectedDpes.delete(dpe);
          btn.classList.remove('active');
        } else {
          state.selectedDpes.add(dpe);
          btn.classList.add('active');
        }
        refreshFilterCardActiveState(card, f);
        applyFilters();
      });
      ctrlWrap.appendChild(btn);
    }
  } else if (f.controlType === 'overheating_pills') {
    ctrlWrap.className = 'pill-group';
    ctrlWrap.id = 'filter-overheating';
    const labels = {
      'Critique': 'Critique 🔥🔥',
      'Élevé': 'Élevé 🔥',
      'Modéré': 'Modéré',
      'Faible': 'Faible',
      'Non renseigné': 'NC',
    };
    for (const opt of f.options) {
      const btn = document.createElement('button');
      btn.type = 'button';
      const isSelected = state.selectedOverheating.has(opt);
      btn.className = `pill-btn${isSelected ? ' active' : ''}`;
      btn.setAttribute('data-val', opt);
      btn.textContent = labels[opt] || opt;
      btn.addEventListener('click', () => {
        if (state.selectedOverheating.has(opt)) {
          state.selectedOverheating.delete(opt);
          btn.classList.remove('active');
        } else {
          state.selectedOverheating.add(opt);
          btn.classList.add('active');
        }
        refreshFilterCardActiveState(card, f);
        applyFilters();
      });
      ctrlWrap.appendChild(btn);
    }
  } else if (f.controlType === 'legal_pills') {
    const modeRow = document.createElement('div');
    modeRow.style.cssText = 'display:flex; justify-content:flex-end; margin-bottom:0.3rem;';
    const modeBadge = document.createElement('span');
    modeBadge.id = 'label-legal-mode';
    modeBadge.style.cssText = 'cursor:pointer; color:var(--accent-primary); font-size:0.7rem; font-weight:600;';
    modeBadge.textContent = state.legalMode === 'inclusif' ? 'Mode Inclusif ⇄' : 'Mode Exclusif ⇄';
    modeBadge.title = 'Inclusif : au moins un propriétaire de ce type. Exclusif : uniquement des propriétaires de ce type.';
    modeBadge.addEventListener('click', () => {
      state.legalMode = state.legalMode === 'inclusif' ? 'exclusif' : 'inclusif';
      modeBadge.textContent = state.legalMode === 'inclusif' ? 'Mode Inclusif ⇄' : 'Mode Exclusif ⇄';
      refreshFilterCardActiveState(card, f);
      applyFilters();
    });
    modeRow.appendChild(modeBadge);
    ctrlWrap.appendChild(modeRow);

    const pillsDiv = document.createElement('div');
    pillsDiv.className = 'pill-group';
    pillsDiv.id = 'filter-legal';
    const shortLabels = {
      'SCI': 'SCI',
      'Bailleur social': 'Bailleur Social',
      'Société commerciale': 'Société Comm.',
      'Personne physique': 'Pers. Physique',
    };
    for (const opt of f.options) {
      const btn = document.createElement('button');
      btn.type = 'button';
      const isSelected = state.selectedLegal.has(opt);
      btn.className = `pill-btn${isSelected ? ' active' : ''}`;
      btn.setAttribute('data-val', opt);
      btn.textContent = shortLabels[opt] || opt;
      btn.addEventListener('click', () => {
        if (state.selectedLegal.has(opt)) {
          state.selectedLegal.delete(opt);
          btn.classList.remove('active');
        } else {
          state.selectedLegal.add(opt);
          btn.classList.add('active');
        }
        refreshFilterCardActiveState(card, f);
        applyFilters();
      });
      pillsDiv.appendChild(btn);
    }
    ctrlWrap.appendChild(pillsDiv);
  } else if (f.controlType === 'slider') {
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(f.min);
    input.max = String(f.max);
    input.step = String(f.step);
    input.value = String(f.getValue(state));
    input.addEventListener('input', (e) => {
      const v = Number(e.target.value);
      f.setValue(state, v);
      const lbl = card.querySelector(`#lbl-val-${f.id}`);
      if (lbl) lbl.textContent = `≥ ${v}${f.unit || ''}`;
      refreshFilterCardActiveState(card, f);
      applyFilters();
    });
    ctrlWrap.appendChild(input);
  } else if (f.controlType === 'number_min') {
    const input = document.createElement('input');
    input.type = 'number';
    input.min = String(f.min ?? 0);
    input.max = String(f.max ?? 99999);
    input.step = String(f.step ?? 1);
    input.placeholder = f.placeholder || 'Valeur minimale...';
    const curVal = f.getValue(state);
    input.value = curVal > 0 ? String(curVal) : '';
    input.addEventListener('input', (e) => {
      const v = parseFloat(e.target.value) || 0;
      f.setValue(state, v);
      refreshFilterCardActiveState(card, f);
      applyFilters();
    });
    ctrlWrap.appendChild(input);
  } else if (f.controlType === 'range_min_max') {
    ctrlWrap.className = 'range-inputs';
    const cur = f.getValue(state) || { min: '', max: '' };
    const inMin = document.createElement('input');
    inMin.type = 'number';
    inMin.placeholder = f.minPlaceholder || 'Min';
    inMin.value = cur.min || '';

    const sep = document.createElement('span');
    sep.textContent = 'à';

    const inMax = document.createElement('input');
    inMax.type = 'number';
    inMax.placeholder = f.maxPlaceholder || 'Max';
    inMax.value = cur.max || '';

    const onRangeChange = () => {
      f.setValue(state, { min: inMin.value.trim(), max: inMax.value.trim() });
      refreshFilterCardActiveState(card, f);
      applyFilters();
    };
    inMin.addEventListener('input', onRangeChange);
    inMax.addEventListener('input', onRangeChange);
    ctrlWrap.appendChild(inMin);
    ctrlWrap.appendChild(sep);
    ctrlWrap.appendChild(inMax);
  } else if (f.controlType === 'select') {
    const select = document.createElement('select');
    const curVal = String(f.getValue(state) || '');
    for (const opt of f.options) {
      const o = document.createElement('option');
      o.value = opt.value;
      o.textContent = opt.label;
      if (opt.value === curVal) o.selected = true;
      select.appendChild(o);
    }
    select.addEventListener('change', (e) => {
      f.setValue(state, e.target.value);
      refreshFilterCardActiveState(card, f);
      applyFilters();
    });
    ctrlWrap.appendChild(select);
  } else if (f.controlType === 'text') {
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = f.placeholder || 'Rechercher...';
    input.value = f.getValue(state) || '';
    if (f.id === 'owner_search') input.id = 'filter-owner-search';
    let debounceTimer = null;
    input.addEventListener('input', (e) => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        f.setValue(state, e.target.value);
        refreshFilterCardActiveState(card, f);
        applyFilters();
      }, 200);
    });
    ctrlWrap.appendChild(input);
  }

  card.appendChild(ctrlWrap);
  return card;
}

function refreshFilterCardActiveState(card, f) {
  const isAct = f.isActive(state);
  card.classList.toggle('is-filtering', isAct);
  updateFilterCountsUI();
  scheduleSaveSession();
}

function clearUnselectedFilters() {
  if (!state.activeFilterIds) return;
  for (const f of FILTER_DEFINITIONS) {
    if (!state.activeFilterIds.has(f.id)) {
      f.reset(state);
    }
  }
}

function clearAllFilters() {
  for (const f of FILTER_DEFINITIONS) {
    f.reset(state);
  }
  // Reset DPE pills to select all 8 options so that NO DPE filter is active
  state.selectedDpes = new Set(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'Inconnu']);
  state.fieldworkFilters = {};
  clearUnselectedFilters();
  renderSidebarFilterControls();
  applyFilters();
  saveSessionToStorage();
  showToast('Tous les filtres ont été effacés (aucun filtre actif).');
}

function resetAllSociologicalFilters() {
  clearAllFilters();
}

function updateFilterCountsUI() {
  const activeCount = FILTER_DEFINITIONS.filter(f => state.activeFilterIds.has(f.id) && f.isActive(state)).length;
  const activeBadge = document.getElementById('active-filters-count-badge');
  const clearBtn = document.getElementById('btn-clear-all-filters');

  if (activeBadge) {
    activeBadge.textContent = `${activeCount} actif${activeCount > 1 ? 's' : ''}`;
    activeBadge.className = activeCount > 0 ? 'status-badge status-online' : 'status-badge';
    activeBadge.title = activeCount > 0
      ? `${activeCount} critère${activeCount > 1 ? 's' : ''} filtrant activement les bâtiments`
      : 'Aucun filtre actif';
  }

  if (clearBtn) {
    clearBtn.style.display = activeCount > 0 ? 'inline-flex' : 'none';
  }

  const selCountEl = document.getElementById('selected-controls-count');
  if (selCountEl) selCountEl.textContent = String(state.activeFilterIds.size);

  const catSelCountEl = document.getElementById('catalog-selected-count');
  if (catSelCountEl) catSelCountEl.textContent = String(state.activeFilterIds.size);

  // Update second row on the big "Choisir les filtres" button
  const profNameEl = document.getElementById('sidebar-active-profile-name');
  if (profNameEl) {
    const prof = getAllProfiles().find(p => p.id === state.activeProfileId);
    if (prof && state.activeProfileId !== 'custom_selection') {
      profNameEl.textContent = `${prof.icon} ${prof.name}`;
      profNameEl.classList.remove('no-profile');
    } else {
      profNameEl.textContent = 'no profiles';
      profNameEl.classList.add('no-profile');
    }
  }
}

function updateAllFilterCardMatches() {
  const cards = document.querySelectorAll('.dyn-filter-card');
  const bldgs = state.buildings || [];
  for (const card of cards) {
    const fId = card.getAttribute('data-filter-id');
    const f = FILTER_DEFINITIONS.find(def => def.id === fId);
    if (!f) continue;
    let matchEl = card.querySelector('.dyn-filter-match-count');
    const isAct = state.activeFilterIds.has(f.id) && f.isActive(state);
    card.classList.toggle('is-filtering', isAct);

    if (isAct && bldgs.length > 0) {
      let count = 0;
      for (let i = 0; i < bldgs.length; i++) {
        if (f.matches(state, bldgs[i])) count++;
      }
      if (!matchEl) {
        matchEl = document.createElement('span');
        matchEl.className = 'dyn-filter-match-count';
        const header = card.querySelector('.dyn-filter-header');
        const removeBtn = card.querySelector('.btn-remove-filter');
        if (header && removeBtn) {
          header.insertBefore(matchEl, removeBtn);
        } else if (header) {
          header.appendChild(matchEl);
        }
      }
      matchEl.textContent = `${count.toLocaleString('fr-FR')} bât.`;
      matchEl.title = `${count.toLocaleString('fr-FR')} bâtiments correspondent à ce critère`;
      matchEl.style.display = 'inline-block';
    } else if (matchEl) {
      matchEl.textContent = '';
      matchEl.style.display = 'none';
    }
  }
}

function updateLoadedDataButtonUI() {
  const nameEl = document.getElementById('sidebar-territory-name');
  const countEl = document.getElementById('sidebar-data-count');
  const badgeEl = document.getElementById('sidebar-data-status-badge');
  const bldgCount = state.buildings ? state.buildings.length : 0;

  if (countEl) {
    countEl.textContent = `${bldgCount.toLocaleString('fr-FR')} bât.`;
  }

  if (nameEl) {
    if (state.activeTerritory) {
      if (state.activeTerritory.mode === 'dep') {
        const depName = DEP_DISPLAY[state.activeTerritory.dep] || ('Département ' + state.activeTerritory.dep);
        nameEl.textContent = depName;
      } else if (state.activeTerritory.mode === 'chunks' && state.activeTerritory.chunkIds) {
        const chunkCount = state.activeTerritory.chunkIds.length;
        nameEl.textContent = `${chunkCount} secteur${chunkCount > 1 ? 's' : ''} CP`;
      } else if (state.activeTerritory.mode === 'cp') {
        nameEl.textContent = `CP ${state.activeTerritory.cp}`;
      } else if (state.activeTerritory.mode === 'range') {
        nameEl.textContent = `CP ${state.activeTerritory.range.join(' à ')}`;
      }
    } else {
      nameEl.textContent = '69 — Rhône (Lyon)';
    }
  }

  if (badgeEl) {
    badgeEl.textContent = bldgCount > 0 ? 'Prêt' : 'En attente';
    badgeEl.className = bldgCount > 0 ? 'status-badge status-cached' : 'status-badge status-muted';
  }
}

function resetAllSociologicalFilters() {
  clearAllFilters();
}

/* ==========================================================================
   Filter Catalog Modal Rendering (Browse & Toggle 69 Sociological Indicators)
   ========================================================================== */
function renderCatalogModalContent() {
  renderProfileButtons();
  renderCatalogCategoryTabs();
  renderCatalogCategoriesGrid();
  updateFilterCountsUI();
}

function renderCatalogCategoryTabs() {
  const tabsWrap = document.getElementById('catalog-category-tabs');
  if (!tabsWrap) return;
  tabsWrap.innerHTML = '';

  const allTab = document.createElement('button');
  allTab.type = 'button';
  allTab.className = `catalog-cat-tab${state.catalogCategoryFilter === 'all' ? ' active' : ''}`;
  allTab.textContent = `Toutes les catégories (${FILTER_DEFINITIONS.length})`;
  allTab.addEventListener('click', () => {
    state.catalogCategoryFilter = 'all';
    renderCatalogCategoryTabs();
    renderCatalogCategoriesGrid();
  });
  tabsWrap.appendChild(allTab);

  for (const cat of SOCIOLOGICAL_CATEGORIES) {
    const count = FILTER_DEFINITIONS.filter(f => f.category === cat.id).length;
    const selectedInCat = FILTER_DEFINITIONS.filter(f => f.category === cat.id && state.activeFilterIds.has(f.id)).length;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `catalog-cat-tab${state.catalogCategoryFilter === cat.id ? ' active' : ''}`;
    btn.innerHTML = `${cat.icon} ${escapeHtml(cat.shortLabel)} <span style="opacity:0.75;">(${selectedInCat}/${count})</span>`;
    btn.addEventListener('click', () => {
      state.catalogCategoryFilter = cat.id;
      renderCatalogCategoryTabs();
      renderCatalogCategoriesGrid();
    });
    tabsWrap.appendChild(btn);
  }
}

function getCatalogVisibleFilters() {
  const q = (state.catalogSearchQuery || '').toLowerCase().trim();
  return FILTER_DEFINITIONS.filter(f => {
    if (state.catalogCategoryFilter !== 'all' && f.category !== state.catalogCategoryFilter) {
      return false;
    }
    if (!q) return true;
    return f.label.toLowerCase().includes(q) ||
           f.desc.toLowerCase().includes(q) ||
           f.column.toLowerCase().includes(q) ||
           f.source.toLowerCase().includes(q);
  });
}

function renderCatalogCategoriesGrid() {
  const container = document.getElementById('catalog-categories-list');
  if (!container) return;
  container.innerHTML = '';

  const q = (state.catalogSearchQuery || '').toLowerCase().trim();
  let totalRendered = 0;

  if (!state.catalogCategoryFoldState) {
    state.catalogCategoryFoldState = new Map();
  }

  for (const cat of SOCIOLOGICAL_CATEGORIES) {
    if (state.catalogCategoryFilter !== 'all' && state.catalogCategoryFilter !== cat.id) continue;

    const catFilters = FILTER_DEFINITIONS.filter(f => {
      if (f.category !== cat.id) return false;
      if (!q) return true;
      return f.label.toLowerCase().includes(q) ||
             f.desc.toLowerCase().includes(q) ||
             f.column.toLowerCase().includes(q) ||
             f.source.toLowerCase().includes(q);
    });

    if (catFilters.length === 0) continue;
    totalRendered += catFilters.length;

    const selectedInCat = catFilters.filter(f => state.activeFilterIds.has(f.id)).length;
    const allSelected = catFilters.length > 0 && selectedInCat === catFilters.length;

    // Foldable details element
    const details = document.createElement('details');
    details.className = 'catalog-category-block';
    details.setAttribute('data-cat-id', cat.id);

    // If searching, force open so user immediately sees matches. Otherwise use remembered fold state (default: open)
    const isFolded = state.catalogCategoryFoldState.has(cat.id) ? !state.catalogCategoryFoldState.get(cat.id) : false;
    details.open = q.length > 0 ? true : !isFolded;

    details.addEventListener('toggle', () => {
      state.catalogCategoryFoldState.set(cat.id, details.open);
    });

    const summary = document.createElement('summary');
    summary.className = 'catalog-category-header';
    summary.innerHTML = `
      <div class="cat-header-left">
        <span class="cat-fold-chevron">▶</span>
        <span class="cat-icon">${cat.icon}</span>
        <div class="cat-title-wrap">
          <div class="catalog-category-title">${escapeHtml(cat.title)}</div>
          <div class="catalog-category-desc">${escapeHtml(cat.desc)}</div>
        </div>
      </div>
      <div class="cat-header-right">
        <span class="status-badge ${selectedInCat > 0 ? 'status-cached' : 'status-muted'}">${selectedInCat} / ${catFilters.length} sélectionné${selectedInCat > 1 ? 's' : ''}</span>
      </div>
    `;

    details.appendChild(summary);

    const grid = document.createElement('div');
    grid.className = 'catalog-filters-grid';

    for (const f of catFilters) {
      const isSelected = state.activeFilterIds.has(f.id);
      const isFilteringNow = f.isActive(state);
      const item = document.createElement('div');
      item.className = `catalog-filter-card${isSelected ? ' selected' : ''}`;
      item.innerHTML = `
        <div class="catalog-filter-check-wrap">
          <input type="checkbox" class="catalog-filter-checkbox" ${isSelected ? 'checked' : ''}>
        </div>
        <div class="catalog-filter-info">
          <div class="catalog-filter-name">
            <span class="catalog-filter-label">${escapeHtml(f.label)}</span>
            <span class="catalog-filter-source">${escapeHtml(f.source)}</span>
          </div>
          <div class="catalog-filter-desc">${escapeHtml(f.desc)}</div>
          <div class="catalog-filter-meta">
            <span class="catalog-filter-col"><code>${escapeHtml(f.column)}</code></span>
            ${isFilteringNow ? `<span class="catalog-filter-active-pill">● Actif</span>` : ''}
          </div>
        </div>
      `;

      item.addEventListener('click', (e) => {
        if (e.target.tagName !== 'INPUT') {
          const chk = item.querySelector('.catalog-filter-checkbox');
          chk.checked = !chk.checked;
        }
        const chk = item.querySelector('.catalog-filter-checkbox');
        if (chk.checked) {
          state.activeFilterIds.add(f.id);
          item.classList.add('selected');
        } else {
          f.reset(state);
          state.activeFilterIds.delete(f.id);
          item.classList.remove('selected');
        }
        state.activeProfileId = 'custom_selection';
        renderProfileButtons();
        renderCatalogCategoryTabs();
        renderSidebarFilterControls();
        updateFilterCountsUI();
        saveSessionToStorage();

        // Update summary count and button
        const currentSelectedInCat = catFilters.filter(fi => state.activeFilterIds.has(fi.id)).length;
        const badge = summary.querySelector('.status-badge');
        if (badge) {
          badge.textContent = `${currentSelectedInCat} / ${catFilters.length} sélectionné${currentSelectedInCat > 1 ? 's' : ''}`;
          badge.className = `status-badge ${currentSelectedInCat > 0 ? 'status-cached' : 'status-muted'}`;
        }
        if (toggleBtn) {
          toggleBtn.textContent = currentSelectedInCat === catFilters.length ? 'Tout décocher' : 'Tout cocher';
        }
      });

      grid.appendChild(item);
    }

    details.appendChild(grid);
    container.appendChild(details);
  }

  if (totalRendered === 0) {
    container.innerHTML = `
      <div style="text-align:center; padding:2.5rem; color:var(--text-muted);">
        <p style="font-size: 1.5rem; margin-bottom: 0.5rem;">🔍</p>
        <p>Aucun indicateur ne correspond à votre recherche « <strong>${escapeHtml(state.catalogSearchQuery)}</strong> ».</p>
      </div>
    `;
  }
}

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

  // 1. Read session state from localStorage
  const savedSession = loadSessionFromStorage();
  if (savedSession?.dataBaseUrl) {
    state.dataBaseUrl = savedSession.dataBaseUrl;
    const inputBaseUrl = document.getElementById('input-data-base-url');
    if (inputBaseUrl) inputBaseUrl.value = state.dataBaseUrl;
  }

  // 2. Pre-load custom profiles & restore filter values before controls are generated
  loadCustomProfilesFromStorage();
  if (savedSession) {
    restoreFiltersFromSession(savedSession);
  }

  initSociologicalFilterSystem();
  initMap(savedSession?.screenState?.mapViewport);
  initTabs();
  initBuildingsTableControls();
  initLandlordsTabControls();
  initExportTabControls();
  initSourcesTabControls();
  initEventListeners();
  initLocationPromptControls();

  // 3. Restore screen controls (dimming, max polygons, active map style, active tab)
  if (savedSession) {
    restoreScreenStateFromSession(savedSession);
  } else {
    const displaySettings = loadMapDisplaySettingsFromStorage();
    applyMapDisplaySettings(displaySettings);
  }

  await loadManifest();
  await scanLocalCache();
  await initPostalZonesLayer();

  // 4. Territory & Data restoration
  let dataRestored = false;
  if (savedSession?.territoryData?.hasLoadedData && savedSession.territoryData.activeTerritory) {
    try {
      state.activeTerritory = savedSession.territoryData.activeTerritory;
      if (Array.isArray(savedSession.territoryData.pendingSelectedChunks)) {
        state.pendingSelectedChunks = new Set(savedSession.territoryData.pendingSelectedChunks);
      }
      exitTerritorySelectionMode();
      await loadTerritory({ restoreViewport: savedSession.screenState?.mapViewport });
      dataRestored = Boolean(state.buildings && state.buildings.length > 0);
    } catch (err) {
      console.warn('Failed to restore saved territory data:', err);
      dataRestored = false;
    }
  }

  if (dataRestored) {
    closeLocationPromptModal();

    if (savedSession?.screenState?.selectedBuildingId) {
      try {
        inspectBuilding(savedSession.screenState.selectedBuildingId);
      } catch (e) {
        console.warn('Could not restore inspected building:', e);
      }
    }

    if (savedSession?.screenState?.inspectedLandlord) {
      try {
        inspectLandlordTarget(savedSession.screenState.inspectedLandlord);
      } catch (e) {
        console.warn('Could not restore inspected landlord:', e);
      }
    }

    if (savedSession?.territoryData?.territorySelectionMode) {
      enterTerritorySelectionMode();
    }
  } else {
    if (savedSession?.territoryData?.territorySelectionMode && savedSession.territoryData.pendingSelectedChunks?.length > 0) {
      state.pendingSelectedChunks = new Set(savedSession.territoryData.pendingSelectedChunks);
      closeLocationPromptModal();
      enterTerritorySelectionMode();
    } else {
      enterTerritorySelectionMode();
      showLocationPromptModal();
    }
  }
});

/* ==========================================================================
   MapLibre GL Initialization
   ========================================================================== */
function initMap(initialViewport = null) {
  const center = (initialViewport && Array.isArray(initialViewport.center)) ? initialViewport.center : [4.8357, 45.7640];
  const zoom = (initialViewport && typeof initialViewport.zoom === 'number') ? initialViewport.zoom : 13;
  state.map = new maplibregl.Map({
    container: 'map',
    attributionControl: false,
    preserveDrawingBuffer: true,
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
          id: 'map-background',
          type: 'background',
          paint: {
            'background-color': '#ffffff',
          },
        },
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
    center: center,
    zoom: zoom,
    maxZoom: 19,
  });

  // Keep the canvas in sync with its container (fixes wrong size on first load)
  const mapEl = document.getElementById('map');
  if (mapEl && typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(() => state.map && state.map.resize()).observe(mapEl);
  }
  window.addEventListener('load', () => state.map && state.map.resize());

  // Discrete compact attribution and scale control on bottom right
  state.map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');
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
    tryAttachPostalZones();
  });

  state.map.on('moveend', () => {
    scheduleSaveSession(500);
  });
}

/* ==========================================================================
   Territory Selection Mode & Location Entry Flow
   ========================================================================== */

let zonePopup = null;

async function scanLocalCache() {
  state.locallyCachedChunkIds.clear();
  if ('caches' in window && state.manifest?.chunks) {
    try {
      const cache = await caches.open('tezeloma-data-v2');
      for (const chunk of state.manifest.chunks) {
        const bUrl = `${state.dataBaseUrl}${chunk.buildings_file}`;
        const match = await cache.match(bUrl);
        if (match) {
          state.locallyCachedChunkIds.add(chunk.id);
        }
      }
    } catch (e) {
      console.warn('Cache API scan error:', e);
    }
  }
}

async function initPostalZonesLayer() {
  try {
    const res = await fetch('postal_zones.geojson');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.postalZonesGeoJson = await res.json();
  } catch (err) {
    console.error('Failed to load postal_zones.geojson:', err);
    try {
      const res2 = await fetch(`${state.dataBaseUrl}postal_zones.geojson`);
      state.postalZonesGeoJson = await res2.json();
    } catch (e2) {
      console.warn('Fallback postal zones fetch failed:', e2);
      state.postalZonesGeoJson = buildFallbackPostalZones();
    }
  }

  // Ensure each feature has a stable 0-indexed integer ID for MapLibre setFeatureState
  if (state.postalZonesGeoJson?.features) {
    state.postalZonesGeoJson.features.forEach((feat, idx) => {
      feat.id = idx;
    });
  }

  refreshPostalZonesVisualState();
  tryAttachPostalZones();
}

function buildFallbackPostalZones() {
  if (!state.manifest?.chunks) return { type: 'FeatureCollection', features: [] };
  const features = state.manifest.chunks.map((c, idx) => {
    const minx = c.bbox[0], miny = c.bbox[1], maxx = c.bbox[2], maxy = c.bbox[3];
    return {
      id: idx,
      type: 'Feature',
      properties: {
        id: c.id,
        chunk_id: c.id,
        cp: c.cp,
        nom: c.communes.join(', '),
        codeDepartement: c.departement,
        departementLabel: DEP_SHORT[c.departement] || ('Département ' + c.departement),
        status: 'downloadable',
        buildings_count: c.buildings_count,
        total_size_bytes: c.total_size_bytes,
        total_size_formatted: `${(c.total_size_bytes / 1048576).toFixed(1)} Mo`,
        center: c.center,
        bbox: c.bbox,
      },
      geometry: {
        type: 'Polygon',
        coordinates: [[[minx, miny], [maxx, miny], [maxx, maxy], [minx, maxy], [minx, miny]]]
      }
    };
  });
  return { type: 'FeatureCollection', features };
}

function tryAttachPostalZones() {
  if (!state.map || !state.map.isStyleLoaded() || !state.postalZonesGeoJson) return;
  if (state.map.getSource('postal-zones-source')) return;

  state.map.addSource('postal-zones-source', {
    type: 'geojson',
    data: state.postalZonesGeoJson,
    generateId: true,
  });

  // Postal Zones Fill Layer (with visible hover alpha changes)
  state.map.addLayer({
    id: 'postal-zones-fill',
    type: 'fill',
    source: 'postal-zones-source',
    paint: {
      'fill-color': ['get', 'render_color'],
      'fill-opacity': [
        'case',
        ['boolean', ['feature-state', 'hover'], false],
        [
          'case',
          ['get', 'selected'],
          0.88, // Hovered AND selected: strong, saturated, highly visible
          0.70  // Hovered and unselected: clearly highlighted alpha
        ],
        [
          'case',
          ['get', 'selected'],
          0.55, // Selected (not hovered)
          0.28  // Unselected (idle)
        ]
      ],
    },
  });

  // Postal Zones Stroke Layer (with prominent highlight on hover)
  state.map.addLayer({
    id: 'postal-zones-stroke',
    type: 'line',
    source: 'postal-zones-source',
    paint: {
      'line-color': [
        'case',
        ['boolean', ['feature-state', 'hover'], false],
        [
          'case',
          ['get', 'selected'],
          '#6d28d9',
          '#0369a1'
        ],
        ['get', 'stroke_color']
      ],
      'line-width': [
        'case',
        ['boolean', ['feature-state', 'hover'], false],
        [
          'case',
          ['get', 'selected'],
          4.5,
          3.2
        ],
        [
          'case',
          ['get', 'selected'],
          3.0,
          1.2
        ]
      ],
      'line-opacity': [
        'case',
        ['boolean', ['feature-state', 'hover'], false],
        1.0,
        0.85
      ],
    },
  });

  setupPostalZonesInteractions();
}

let hoveredPostalZoneIds = [];

function clearPostalZoneHover() {
  if (!state.map || hoveredPostalZoneIds.length === 0) return;
  for (const id of hoveredPostalZoneIds) {
    try {
      state.map.setFeatureState({ source: 'postal-zones-source', id }, { hover: false });
    } catch (_) {}
  }
  hoveredPostalZoneIds = [];
  document.querySelectorAll('.sel-chunk-pill.is-hovered').forEach(el => {
    el.classList.remove('is-hovered');
  });
}

function setPostalZoneHoverForChunk(chunkId, currentFeatureId = null) {
  if (!state.map) return;
  clearPostalZoneHover();

  const toHover = new Set();
  if (currentFeatureId !== null && currentFeatureId !== undefined) {
    toHover.add(currentFeatureId);
  }
  if (chunkId && state.postalZonesGeoJson?.features) {
    for (const f of state.postalZonesGeoJson.features) {
      if (f.properties?.chunk_id === chunkId && f.id !== undefined) {
        toHover.add(f.id);
      }
    }
  }

  for (const id of toHover) {
    try {
      state.map.setFeatureState({ source: 'postal-zones-source', id }, { hover: true });
    } catch (_) {}
  }
  hoveredPostalZoneIds = Array.from(toHover);

  if (chunkId) {
    const matchingPill = document.querySelector(`.sel-chunk-pill[data-chunk-id="${chunkId}"]`);
    if (matchingPill) {
      matchingPill.classList.add('is-hovered');
      matchingPill.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }
}

function setupPostalZonesInteractions() {
  if (!state.map) return;

  state.map.on('mousemove', 'postal-zones-fill', (e) => {
    if (!state.territorySelectionMode) return;
    if (e.features && e.features.length > 0) {
      state.map.getCanvas().style.cursor = 'pointer';
      const feat = e.features[0];
      const chunkId = feat.properties?.chunk_id;
      setPostalZoneHoverForChunk(chunkId, feat.id);

      const props = feat.properties;

      let statusLabel = 'Prêt au téléchargement';
      let statusClass = 'status-dl';
      let icon = '☁️';

      if (props.selected) {
        statusLabel = 'Sélectionné pour chargement';
        statusClass = 'status-selected';
        icon = '✅';
      } else if (props.status === 'available_locally') {
        statusLabel = 'Disponible localement (en cache)';
        statusClass = 'status-local';
        icon = '💾';
      } else if (props.status === 'requestable') {
        statusLabel = 'À la demande (BDNB brute existante)';
        statusClass = 'status-req';
        icon = '⏳';
      } else if (props.status === 'unavailable') {
        statusLabel = 'Indisponible';
        statusClass = 'status-unav';
        icon = '🚫';
      }

      const bldgs = props.buildings_count ? `${Number(props.buildings_count).toLocaleString('fr-FR')} bâtiments` : '—';
      const size = props.total_size_formatted || (props.total_size_bytes ? `${(props.total_size_bytes / 1048576).toFixed(1)} Mo` : '—');

      const html = `
        <div class="zone-popup">
          <div class="zone-popup-header">
            <span>${props.nom || 'Zone'}</span>
            <span style="color: var(--accent-primary); font-size: 0.85rem;">${props.cp || ''}</span>
          </div>
          <div class="zone-popup-status ${statusClass}">${icon} ${statusLabel}</div>
          <div class="zone-popup-details">
            <div><strong>Département :</strong> ${props.departementLabel || props.codeDepartement || '—'}</div>
            <div><strong>Bâtiments :</strong> ${bldgs}</div>
            <div><strong>Taille :</strong> ${size}</div>
          </div>
          <div class="zone-popup-hint">
            ${props.status === 'requestable' ? 'ℹ️ Cliquez pour voir la demande' : '👆 Cliquez pour sélectionner / retirer'}
          </div>
        </div>
      `;

      if (!zonePopup) {
        zonePopup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 12 });
      }
      zonePopup.setLngLat(e.lngLat).setHTML(html).addTo(state.map);
    }
  });

  state.map.on('mouseleave', 'postal-zones-fill', () => {
    state.map.getCanvas().style.cursor = '';
    clearPostalZoneHover();
    if (zonePopup) {
      zonePopup.remove();
      zonePopup = null;
    }
  });

  state.map.on('click', 'postal-zones-fill', (e) => {
    if (!state.territorySelectionMode) return;
    if (e.features && e.features.length > 0) {
      onPostalZoneClick(e.features[0]);
    }
  });
}

function findChunkForFeature(props) {
  if (!state.manifest?.chunks) return null;
  if (props.chunk_id) {
    const byId = state.manifest.chunks.find(c => c.id === props.chunk_id);
    if (byId) return byId;
  }
  if (props.cp) {
    const cpNum = Number(props.cp);
    const byCp = state.manifest.chunks.find(c => c.cp === cpNum);
    if (byCp) return byCp;
  }
  return null;
}

function onPostalZoneClick(feat) {
  const props = feat.properties;

  if (props.status === 'requestable') {
    showRequestableModal(props);
    return;
  }

  if (props.status === 'unavailable') {
    showToast('Indisponible : aucune donnée de bâti disponible pour cette zone.');
    return;
  }

  const chunk = findChunkForFeature(props);
  if (!chunk) {
    showToast(`Chunk introuvable pour ${props.nom} (${props.cp})`);
    return;
  }

  toggleChunkSelection(chunk.id);
}

function toggleChunkSelection(chunkId) {
  if (state.pendingSelectedChunks.has(chunkId)) {
    state.pendingSelectedChunks.delete(chunkId);
  } else {
    state.pendingSelectedChunks.add(chunkId);
  }
  refreshPostalZonesVisualState();
  updateTerritorySelectionBar();
  scheduleSaveSession();
}

function refreshPostalZonesVisualState() {
  if (!state.postalZonesGeoJson?.features) return;

  for (const f of state.postalZonesGeoJson.features) {
    const cId = f.properties.chunk_id;
    const isSelected = Boolean(cId && state.pendingSelectedChunks.has(cId));
    f.properties.selected = isSelected;

    const isLocal = Boolean(cId && state.locallyCachedChunkIds.has(cId));
    const isDownloadable = Boolean(cId && state.manifest?.chunks?.some(c => c.id === cId));

    if (isSelected) {
      f.properties.render_color = '#8b5cf6';
      f.properties.stroke_color = '#c084fc';
    } else if (isLocal) {
      f.properties.render_color = '#10b981';
      f.properties.stroke_color = '#059669';
      f.properties.status = 'available_locally';
    } else if (isDownloadable) {
      f.properties.render_color = '#0ea5e9';
      f.properties.stroke_color = '#0284c7';
      f.properties.status = 'downloadable';
    } else if (f.properties.status === 'requestable') {
      f.properties.render_color = '#f59e0b';
      f.properties.stroke_color = '#d97706';
    } else {
      f.properties.render_color = '#64748b';
      f.properties.stroke_color = '#475569';
      f.properties.status = 'unavailable';
    }
  }

  const src = state.map?.getSource('postal-zones-source');
  if (src) {
    src.setData(state.postalZonesGeoJson);
  }
}

function getBoundingBoxForChunkIds(chunkIds) {
  if (!chunkIds || chunkIds.length === 0) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

  for (const cId of chunkIds) {
    const chunk = (state.manifest?.chunks || []).find(c => c.id === cId);
    if (chunk && Array.isArray(chunk.bbox) && chunk.bbox.length === 4) {
      minX = Math.min(minX, chunk.bbox[0]);
      minY = Math.min(minY, chunk.bbox[1]);
      maxX = Math.max(maxX, chunk.bbox[2]);
      maxY = Math.max(maxY, chunk.bbox[3]);
      continue;
    }
    if (state.postalZonesGeoJson?.features) {
      const feat = state.postalZonesGeoJson.features.find(f => f.properties?.chunk_id === cId || f.properties?.id === cId);
      if (feat?.properties?.bbox && Array.isArray(feat.properties.bbox) && feat.properties.bbox.length === 4) {
        minX = Math.min(minX, feat.properties.bbox[0]);
        minY = Math.min(minY, feat.properties.bbox[1]);
        maxX = Math.max(maxX, feat.properties.bbox[2]);
        maxY = Math.max(maxY, feat.properties.bbox[3]);
      }
    }
  }

  if (minX !== Infinity && minY !== Infinity && maxX !== -Infinity && maxY !== -Infinity) {
    return [[minX, minY], [maxX, maxY]];
  }
  return null;
}

function getLoadedChunkIds() {
  if (!state.buildings || state.buildings.length === 0 || !state.activeTerritory) return [];
  const mode = state.activeTerritory.mode;
  if (mode === 'chunks' && Array.isArray(state.activeTerritory.chunkIds) && state.activeTerritory.chunkIds.length > 0) {
    return state.activeTerritory.chunkIds;
  }
  const chunks = state.manifest?.chunks || [];
  if (mode === 'dep' && state.activeTerritory.dep) {
    return chunks.filter(c => c.departement === state.activeTerritory.dep).map(c => c.id);
  }
  if (mode === 'cp' && state.activeTerritory.cp) {
    return chunks.filter(c => c.cp === Number(state.activeTerritory.cp)).map(c => c.id);
  }
  if (mode === 'range' && Array.isArray(state.activeTerritory.range)) {
    const [start, end] = state.activeTerritory.range;
    return chunks.filter(c => c.cp >= start && c.cp <= end).map(c => c.id);
  }
  return [];
}

function getAllAvailableChunkIds() {
  if (state.manifest?.chunks && state.manifest.chunks.length > 0) {
    return state.manifest.chunks.map(c => c.id);
  }
  if (state.postalZonesGeoJson?.features && state.postalZonesGeoJson.features.length > 0) {
    const ids = [];
    for (const f of state.postalZonesGeoJson.features) {
      if (f.properties?.chunk_id && (f.properties.status === 'available_locally' || f.properties.status === 'downloadable' || !f.properties.status)) {
        ids.push(f.properties.chunk_id);
      }
    }
    return ids;
  }
  return [];
}

function fitBoundsToPendingSelection() {
  if (!state.map) return;
  state.map.resize();

  let targetChunkIds = [];
  if (state.pendingSelectedChunks && state.pendingSelectedChunks.size > 0) {
    targetChunkIds = Array.from(state.pendingSelectedChunks);
  } else {
    const loadedIds = getLoadedChunkIds();
    if (loadedIds.length > 0) {
      targetChunkIds = loadedIds;
    } else {
      targetChunkIds = getAllAvailableChunkIds();
    }
  }

  const bbox = getBoundingBoxForChunkIds(targetChunkIds);
  if (bbox) {
    state.map.fitBounds(bbox, {
      padding: { top: 80, bottom: 80, left: 80, right: 390 },
      maxZoom: 11.5,
      duration: 700,
      essential: true
    });
  }
}

function updateTerritorySelectionBar() {
  const selBar = document.getElementById('territory-selection-bar');
  if (!selBar) return;

  const count = state.pendingSelectedChunks.size;
  const btnValidate = document.getElementById('btn-sel-validate');
  const summaryText = document.getElementById('sel-bar-summary-text');
  const metricsText = document.getElementById('sel-bar-metrics-text');
  const chipsContainer = document.getElementById('sel-bar-chips');

  if (count === 0) {
    if (summaryText) summaryText.textContent = '0 code postal sélectionné';
    if (metricsText) metricsText.textContent = '0 bâtiment • 0 Mo';
    if (chipsContainer) {
      chipsContainer.innerHTML = '<span class="sel-bar-placeholder">📍 Cliquez sur un secteur sur la carte pour l\'ajouter</span>';
    }
    if (btnValidate) btnValidate.disabled = true;
    return;
  }

  if (btnValidate) btnValidate.disabled = false;

  const selectedChunks = (state.manifest?.chunks || []).filter(c => state.pendingSelectedChunks.has(c.id));
  const totalBldgs = selectedChunks.reduce((acc, c) => acc + (c.buildings_count || 0), 0);

  let netBytesToDownload = 0;
  let cachedChunksCount = 0;
  for (const c of selectedChunks) {
    if (state.locallyCachedChunkIds.has(c.id)) {
      cachedChunksCount++;
    } else {
      netBytesToDownload += (c.total_size_bytes || 0);
    }
  }

  if (summaryText) {
    summaryText.innerHTML = `<strong>${count} secteur${count > 1 ? 's' : ''} sélectionné${count > 1 ? 's' : ''}</strong>`;
  }

  const netMb = (netBytesToDownload / 1048576).toFixed(1);
  let sizeInfo = netBytesToDownload > 0 ? `${netMb} Mo` : 'En cache';
  if (cachedChunksCount > 0 && netBytesToDownload > 0) {
    sizeInfo += ` (${cachedChunksCount} en cache)`;
  }
  if (metricsText) {
    metricsText.textContent = `${totalBldgs.toLocaleString('fr-FR')} bât. • ${sizeInfo}`;
  }

  // Populate selected postal codes / chunks chips (vertical card list)
  if (chipsContainer) {
    chipsContainer.innerHTML = '';
    const list = [];
    for (const cId of state.pendingSelectedChunks) {
      const match = (state.manifest?.chunks || []).find(c => c.id === cId);
      list.push({
        id: cId,
        cp: match ? match.cp : cId,
        commune: match?.commune || (match?.communes ? match.communes[0] : ''),
        buildings_count: match?.buildings_count || 0,
        total_size_bytes: match?.total_size_bytes || 0,
        isCached: state.locallyCachedChunkIds.has(cId),
      });
    }
    list.sort((a, b) => {
      const numA = parseInt(a.cp, 10) || 0;
      const numB = parseInt(b.cp, 10) || 0;
      return numA - numB;
    });

    for (const item of list) {
      const pill = document.createElement('div');
      pill.className = `sel-chunk-pill${item.isCached ? ' cached' : ''}`;
      pill.dataset.chunkId = item.id;
      pill.title = `Cliquer pour centrer sur ${escapeHtml(String(item.cp))}`;

      const bldgLabel = item.buildings_count ? `${Number(item.buildings_count).toLocaleString('fr-FR')} bât.` : '';
      const sizeLabel = item.total_size_bytes ? `${(item.total_size_bytes / 1048576).toFixed(1)} Mo` : '';
      const metaSub = [bldgLabel, sizeLabel, item.isCached ? 'En cache' : 'Prêt'].filter(Boolean).join(' • ');

      pill.innerHTML = `
        <div class="sel-chunk-pill-left">
          <span class="chunk-dot-status ${item.isCached ? 'dot-cached' : 'dot-cloud'}" title="${item.isCached ? 'En cache local' : 'Prêt au téléchargement'}"></span>
          <div class="chunk-info-text">
            <span class="chunk-cp-label"><strong>${escapeHtml(String(item.cp))}</strong>${item.commune ? ` <span class="chunk-commune-name">${escapeHtml(item.commune)}</span>` : ''}</span>
            <span class="chunk-meta-sub">${escapeHtml(metaSub)}</span>
          </div>
        </div>
        <button type="button" class="btn-remove-chunk" title="Retirer ${escapeHtml(String(item.cp))}" data-chunk-id="${escapeHtml(item.id)}">&times;</button>
      `;

      // Hover on pill highlights corresponding zone polygon on map
      pill.addEventListener('mouseenter', () => {
        setPostalZoneHoverForChunk(item.id);
      });
      pill.addEventListener('mouseleave', () => {
        clearPostalZoneHover();
      });

      // Clicking pill zooms/centers to this sector on the map with margin
      pill.addEventListener('click', (e) => {
        if (e.target.closest('.btn-remove-chunk')) return;
        const chunkBbox = getBoundingBoxForChunkIds([item.id]);
        if (chunkBbox && state.map) {
          state.map.fitBounds(chunkBbox, {
            padding: { top: 90, bottom: 90, left: 90, right: 390 },
            maxZoom: 12.8,
            essential: true
          });
        }
      });

      // Remove button handler
      pill.querySelector('.btn-remove-chunk').addEventListener('click', (e) => {
        e.stopPropagation();
        state.pendingSelectedChunks.delete(item.id);
        refreshPostalZonesVisualState();
        updateTerritorySelectionBar();
        scheduleSaveSession();
      });

      chipsContainer.appendChild(pill);
    }
  }
}

async function validateAndLoadSelectedChunks() {
  if (state.pendingSelectedChunks.size === 0) {
    alert("Veuillez sélectionner au moins un code postal à charger.");
    return;
  }

  state.activeTerritory = {
    mode: 'chunks',
    chunkIds: Array.from(state.pendingSelectedChunks),
  };

  exitTerritorySelectionMode();
  await loadTerritory();
}

function enterTerritorySelectionMode(centerLocation = null) {
  state.territorySelectionMode = true;
  document.body.classList.add('territory-selection-active');
  const selBar = document.getElementById('territory-selection-bar');
  if (selBar) selBar.classList.add('active');

  const modeIndicator = document.getElementById('territory-mode-indicator');
  if (modeIndicator) modeIndicator.classList.add('active');

  if (state.map?.getLayer('postal-zones-fill')) {
    state.map.setLayoutProperty('postal-zones-fill', 'visibility', 'visible');
    state.map.setLayoutProperty('postal-zones-stroke', 'visibility', 'visible');
  }

  // If no pending chunks are currently selected, sync with loaded chunks if any
  if (state.pendingSelectedChunks.size === 0) {
    const loadedIds = getLoadedChunkIds();
    if (loadedIds.length > 0) {
      loadedIds.forEach(id => state.pendingSelectedChunks.add(id));
    }
  }

  if (state.map) {
    state.map.resize();
    if (centerLocation) {
      if (centerLocation.bbox) {
        const bounds = Array.isArray(centerLocation.bbox[0])
          ? centerLocation.bbox
          : [[centerLocation.bbox[0], centerLocation.bbox[1]], [centerLocation.bbox[2], centerLocation.bbox[3]]];
        state.map.fitBounds(
          bounds,
          { padding: { top: 80, bottom: 80, left: 80, right: 390 }, maxZoom: centerLocation.maxZoom || 11.5, duration: 700, essential: true }
        );
      } else if (centerLocation.center) {
        state.map.flyTo({
          center: centerLocation.center,
          zoom: centerLocation.zoom || 11.2,
          essential: true
        });
      }
    } else {
      fitBoundsToPendingSelection();
    }
  }

  refreshPostalZonesVisualState();
  updateTerritorySelectionBar();
  updateLegend();
  saveSessionToStorage();
}

function exitTerritorySelectionMode() {
  state.territorySelectionMode = false;
  document.body.classList.remove('territory-selection-active');
  clearPostalZoneHover();
  const selBar = document.getElementById('territory-selection-bar');
  if (selBar) selBar.classList.remove('active');

  const modeIndicator = document.getElementById('territory-mode-indicator');
  if (modeIndicator) modeIndicator.classList.remove('active');

  if (state.map?.getLayer('postal-zones-fill')) {
    state.map.setLayoutProperty('postal-zones-fill', 'visibility', 'none');
    state.map.setLayoutProperty('postal-zones-stroke', 'visibility', 'none');
  }

  if (zonePopup) {
    zonePopup.remove();
    zonePopup = null;
  }

  updateLegend();
  saveSessionToStorage();
}

function showLocationPromptModal() {
  const modal = document.getElementById('modal-location-entry');
  if (modal) modal.classList.add('open');
  const input = document.getElementById('input-location-search');
  if (input) setTimeout(() => input.focus(), 150);
}

function closeLocationPromptModal() {
  const modal = document.getElementById('modal-location-entry');
  if (modal) modal.classList.remove('open');
  const dropdown = document.getElementById('location-suggestions');
  if (dropdown) dropdown.classList.remove('open');
}

function showRequestableModal(props) {
  const modal = document.getElementById('modal-request-data');
  if (!modal) return;

  const communeEl = document.getElementById('req-modal-commune');
  const cpEl = document.getElementById('req-modal-cp');
  const depEl = document.getElementById('req-modal-dep');

  if (communeEl) communeEl.textContent = props.nom || 'Commune';
  if (cpEl) cpEl.textContent = `${props.cp || props.codeInsee || 'Inconnu'}`;
  if (depEl) depEl.textContent = `${props.departementLabel || props.codeDepartement || 'France'}`;

  modal.classList.add('open');
}

async function performLocationSearch(query) {
  const dropdown = document.getElementById('location-suggestions');
  if (!dropdown) return;

  const results = [];
  const qLower = query.toLowerCase();

  // 1. Local manifest chunks matching (instant offline)
  if (state.manifest?.chunks) {
    for (const chunk of state.manifest.chunks) {
      const matchCp = String(chunk.cp).includes(qLower);
      const matchCommune = chunk.communes.some(c => c.toLowerCase().includes(qLower));
      if (matchCp || matchCommune) {
        const isLocal = state.locallyCachedChunkIds.has(chunk.id);
        results.push({
          title: `${chunk.communes.slice(0, 2).join(', ')} (${chunk.cp})`,
          context: DEP_CONTEXT[chunk.departement] || ('Département ' + chunk.departement),
          statusText: isLocal ? '💾 En cache' : '☁️ Prêt au téléchargement',
          statusClass: isLocal ? 'status-local' : 'status-dl',
          center: chunk.center,
          bbox: chunk.bbox,
          chunkId: chunk.id,
          cp: chunk.cp,
        });
      }
    }
  }

  // 2. Query official French national geocoder API if online
  if (navigator.onLine) {
    try {
      const apiUrl = `https://api-adresse.data.gouv.fr/search/?q=${encodeURIComponent(query)}&limit=5`;
      const res = await fetch(apiUrl);
      if (res.ok) {
        const data = await res.json();
        for (const feat of data.features || []) {
          const props = feat.properties;
          const cp = parseInt(props.postcode, 10);
          const chunk = state.manifest?.chunks?.find(c => c.cp === cp);
          const isLocal = chunk && state.locallyCachedChunkIds.has(chunk.id);

          let statusText = '⏳ À la demande';
          let statusClass = 'status-req';
          if (isLocal) {
            statusText = '💾 En cache';
            statusClass = 'status-local';
          } else if (chunk) {
            statusText = '☁️ Prêt';
            statusClass = 'status-dl';
          }

          results.push({
            title: props.label || props.name,
            context: props.context || (props.city + ' (' + props.postcode + ')'),
            statusText,
            statusClass,
            center: feat.geometry.coordinates,
            bbox: null,
            chunkId: chunk?.id || null,
            cp,
          });
        }
      }
    } catch (e) {
      console.warn('api-adresse geocoding error:', e);
    }
  }

  // Deduplicate
  const uniqueResults = [];
  const seenTitles = new Set();
  for (const r of results) {
    if (!seenTitles.has(r.title)) {
      seenTitles.add(r.title);
      uniqueResults.push(r);
    }
    if (uniqueResults.length >= 7) break;
  }

  if (uniqueResults.length === 0) {
    dropdown.innerHTML = `<div style="padding: 0.75rem 1rem; color: var(--text-muted); font-size: 0.82rem;">Aucun lieu trouvé pour "${query}"</div>`;
    dropdown.classList.add('open');
    return;
  }

  dropdown.innerHTML = uniqueResults.map((r, i) => `
    <div class="location-suggestion-item" data-index="${i}">
      <div class="suggestion-main">
        <span class="suggestion-title">📍 ${r.title}</span>
        <span class="suggestion-context">${r.context}</span>
      </div>
      <span class="suggestion-status ${r.statusClass}">${r.statusText}</span>
    </div>
  `).join('');

  dropdown.classList.add('open');

  dropdown.querySelectorAll('.location-suggestion-item').forEach((item, idx) => {
    item.addEventListener('click', () => {
      const sel = uniqueResults[idx];
      dropdown.classList.remove('open');
      closeLocationPromptModal();

      if (sel.chunkId) {
        state.pendingSelectedChunks.add(sel.chunkId);
      }

      if (sel.bbox) {
        enterTerritorySelectionMode({ bbox: sel.bbox, maxZoom: 11.8 });
      } else if (sel.center) {
        enterTerritorySelectionMode({ center: sel.center, zoom: 11.5 });
        addSearchedAddressPin({
          lon: sel.center[0],
          lat: sel.center[1],
          label: sel.title,
          context: sel.context,
        });
      } else {
        enterTerritorySelectionMode();
      }
    });
  });
}

function initLocationPromptControls() {
  const inputSearch = document.getElementById('input-location-search');
  const suggestionsDropdown = document.getElementById('location-suggestions');

  if (inputSearch && suggestionsDropdown) {
    let searchDebounceTimer = null;
    inputSearch.addEventListener('input', (e) => {
      const query = e.target.value.trim();
      clearTimeout(searchDebounceTimer);
      if (!query || query.length < 2) {
        suggestionsDropdown.classList.remove('open');
        suggestionsDropdown.innerHTML = '';
        return;
      }

      searchDebounceTimer = setTimeout(async () => {
        await performLocationSearch(query);
      }, 250);
    });

    document.addEventListener('click', (e) => {
      if (!inputSearch.contains(e.target) && !suggestionsDropdown.contains(e.target)) {
        suggestionsDropdown.classList.remove('open');
      }
    });
  }

  // Preset Lyon (Lyon 1-9 & Villeurbanne - 10 codes postaux)
  const LYON_PRESET_CPS = new Set([69001, 69002, 69003, 69004, 69005, 69006, 69007, 69008, 69009, 69100]);
  document.getElementById('preset-lyon')?.addEventListener('click', () => {
    closeLocationPromptModal();
    state.pendingSelectedChunks.clear();
    if (state.manifest?.chunks) {
      state.manifest.chunks
        .filter(c => LYON_PRESET_CPS.has(c.cp))
        .forEach(c => state.pendingSelectedChunks.add(c.id));
    }
    const lyonBbox = getBoundingBoxForChunkIds(Array.from(state.pendingSelectedChunks));
    enterTerritorySelectionMode(lyonBbox ? { bbox: lyonBbox, maxZoom: 11.2 } : { center: [4.8467, 45.7628], zoom: 11.2 });
    refreshPostalZonesVisualState();
    updateTerritorySelectionBar();
  });

  // Preset Grenoble & Métropole (14 codes postaux métropolitains)
  const GRENOBLE_PRESET_CPS = new Set([38000, 38100, 38400, 38130, 38600, 38240, 38120, 38170, 38360, 38800, 38320, 38610, 38700, 38180]);
  document.getElementById('preset-grenoble')?.addEventListener('click', () => {
    closeLocationPromptModal();
    state.pendingSelectedChunks.clear();
    if (state.manifest?.chunks) {
      state.manifest.chunks
        .filter(c => GRENOBLE_PRESET_CPS.has(c.cp))
        .forEach(c => state.pendingSelectedChunks.add(c.id));
    }
    const grenobleBbox = getBoundingBoxForChunkIds(Array.from(state.pendingSelectedChunks));
    enterTerritorySelectionMode(grenobleBbox ? { bbox: grenobleBbox, maxZoom: 10.6 } : { center: [5.7255, 45.1785], zoom: 10.6 });
    refreshPostalZonesVisualState();
    updateTerritorySelectionBar();
  });

  // Free exploration link
  document.getElementById('link-explore-freely')?.addEventListener('click', (e) => {
    e.preventDefault();
    closeLocationPromptModal();
    enterTerritorySelectionMode();
  });

  // GPS position button
  document.getElementById('btn-location-gps')?.addEventListener('click', () => {
    if (!navigator.geolocation) {
      alert("La géolocalisation n'est pas supportée par votre navigateur.");
      return;
    }
    showLoading("Recherche de votre position...");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        hideLoading();
        closeLocationPromptModal();
        const coords = [pos.coords.longitude, pos.coords.latitude];
        enterTerritorySelectionMode({ center: coords, zoom: 11.8 });
        refreshPostalZonesVisualState();
        updateTerritorySelectionBar();
      },
      (err) => {
        hideLoading();
        alert(`Impossible de récupérer votre position : ${err.message}`);
      },
      { timeout: 10000, enableHighAccuracy: true }
    );
  });

  // Selection bar buttons
  document.getElementById('btn-sel-fit')?.addEventListener('click', () => {
    fitBoundsToPendingSelection();
  });

  document.getElementById('btn-sel-clear')?.addEventListener('click', () => {
    state.pendingSelectedChunks.clear();
    refreshPostalZonesVisualState();
    updateTerritorySelectionBar();
    scheduleSaveSession();
  });

  document.getElementById('btn-sel-cancel')?.addEventListener('click', () => {
    exitTerritorySelectionMode();
  });

  document.getElementById('btn-sel-validate')?.addEventListener('click', async () => {
    await validateAndLoadSelectedChunks();
  });

  // Sidebar map button
  document.getElementById('btn-sidebar-open-territory')?.addEventListener('click', () => {
    enterTerritorySelectionMode();
  });

  // Request modal buttons
  document.getElementById('btn-close-request-modal')?.addEventListener('click', () => {
    document.getElementById('modal-request-data')?.classList.remove('open');
  });
  document.getElementById('btn-close-request-footer')?.addEventListener('click', () => {
    document.getElementById('modal-request-data')?.classList.remove('open');
  });
  document.getElementById('btn-confirm-request-data')?.addEventListener('click', () => {
    document.getElementById('modal-request-data')?.classList.remove('open');
    showToast("Demande enregistrée ! Ce territoire sera inclus dans un prochain import BDNB.");
  });
}

function showToast(msg, duration = 3000) {
  let toast = document.getElementById('tz-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'tz-toast';
    toast.style.cssText = `
      position: fixed;
      bottom: 2rem;
      left: 50%;
      transform: translateX(-50%);
      background: rgba(15, 23, 42, 0.95);
      color: #fff;
      padding: 0.75rem 1.25rem;
      border-radius: 8px;
      border: 1px solid rgba(56, 189, 248, 0.4);
      box-shadow: 0 10px 25px rgba(0,0,0,0.5);
      z-index: 9999;
      font-size: 0.88rem;
      font-weight: 600;
      pointer-events: none;
      transition: opacity 0.25s ease;
      opacity: 0;
    `;
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.style.opacity = '1';
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => {
    toast.style.opacity = '0';
  }, duration);
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
      const cache = await caches.open('tezeloma-data-v2');
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

async function loadTerritory(options = {}) {
  if (!state.manifest) return;
  showLoading('Téléchargement et décompression des données...');

  const mode = state.activeTerritory.mode;
  let targetChunks = [];

  if (mode === 'chunks') {
    const chunkIds = new Set(state.activeTerritory.chunkIds || []);
    targetChunks = state.manifest.chunks.filter(c => chunkIds.has(c.id));
  } else if (mode === 'dep') {
    const dep = state.activeTerritory.dep;
    targetChunks = state.manifest.chunks.filter(c => c.departement === dep);
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

    if (targetChunks.length > 0) {
      const totalBytes = targetChunks.reduce((acc, c) => acc + c.total_size_bytes, 0);
      const totalMb = (totalBytes / 1048576).toFixed(1);
      const cpLabels = targetChunks.map(c => c.cp).join(', ');
      const statusEl = document.getElementById('territory-status-text');
      if (statusEl) statusEl.textContent = `CP: ${cpLabels}`;
      const sizeEl = document.getElementById('territory-size-text');
      if (sizeEl) sizeEl.textContent = `~${totalMb} Mo (${targetChunks.length} chunks)`;

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

    // Record loaded chunks as locally cached
    if (targetChunks.length > 0) {
      for (const c of targetChunks) {
        state.locallyCachedChunkIds.add(c.id);
      }
    }
    refreshPostalZonesVisualState();

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
    updateLoadedDataButtonUI();

    // Fly map to bbox (unless restoring saved viewport)
    if (options && options.restoreViewport && Array.isArray(options.restoreViewport.center) && state.map) {
      state.map.jumpTo({
        center: options.restoreViewport.center,
        zoom: options.restoreViewport.zoom || 13,
      });
    } else if (combinedBbox && state.map) {
      state.map.fitBounds(
        [[combinedBbox[0], combinedBbox[1]], [combinedBbox[2], combinedBbox[3]]],
        { padding: { top: 80, bottom: 80, left: 80, right: 80 }, maxZoom: 14.0, essential: true }
      );
    }

    saveSessionToStorage();

  } catch (err) {
    console.error('Error loading territory chunks:', err);
    alert(`Erreur lors du chargement des données: ${err.message}`);
  } finally {
    hideLoading();
  }
}

/* ==========================================================================
   Real-Time Client-Side Filtering (69 Sociological Indicators)
   ========================================================================== */
function applyFilters() {
  clearUnselectedFilters();
  scheduleSaveSession();
  if (!state.buildings || state.buildings.length === 0) return;

  const activeFilterDefs = FILTER_DEFINITIONS.filter(f => state.activeFilterIds.has(f.id) && f.isActive(state));
  const { fieldwork, maxPolygons } = state;
  const filtered = [];

  for (let i = 0; i < state.buildings.length; i++) {
    const b = state.buildings[i];

    let pass = true;
    for (let j = 0; j < activeFilterDefs.length; j++) {
      if (!activeFilterDefs[j].matches(state, b)) {
        pass = false;
        break;
      }
    }
    if (!pass) continue;

    // Color computation based on mapStyleMode
    const dpe = b.dpe || 'Inconnu';
    const rawRisk = b.risque_surchauffe_ete;
    const risk = (!rawRisk || rawRisk === 'NC' || rawRisk === 'Inconnu') ? 'Non renseigné' : rawRisk;
    const conc = Number(b.concentration_prop_max_num || 0);

    let renderColor = DPE_COLORS[dpe] || DPE_COLORS['Inconnu'];
    if (state.mapStyleMode === 'overheating') {
      renderColor = OVERHEATING_COLORS[risk] || OVERHEATING_COLORS['Faible'];
    } else if (state.mapStyleMode === 'concentration') {
      renderColor = conc >= 80 ? '#ef4444' : conc >= 50 ? '#f59e0b' : conc >= 20 ? '#38bdf8' : '#64748b';
    } else if (state.mapStyleMode === 'fieldwork') {
      const isField = fieldwork.has(b.batiment_groupe_id);
      renderColor = isField ? '#a855f7' : 'rgba(100, 116, 139, 0.4)';
    }

    b.render_color = renderColor;
    filtered.push(b);
  }

  state.filteredBuildings = filtered;
  updateKPIs(filtered);
  updateFilterCountsUI();
  updateAllFilterCardMatches();

  // Apply max polygons limit to map display
  const mapBuildings = (maxPolygons && maxPolygons < filtered.length)
    ? filtered.slice(0, maxPolygons)
    : filtered;
  updateMapSource(mapBuildings);

  // Synchronize active view
  if (state.activeTab === 'buildings') {
    renderBuildingsTable();
  }
  if (state.openTool === 'landlords') {
    renderLandlordsTab();
  }
  updateExportTab();
}

function updateKPIs(filtered) {
  const filteredBuildings = filtered ? filtered.length : 0;
  const allBuildingsCount = state.buildings ? state.buildings.length : 0;

  let filteredDwellings = 0;
  let fgCount = 0;
  let highOverheatCount = 0;

  for (let i = 0; i < filteredBuildings; i++) {
    const b = filtered[i];
    filteredDwellings += Number(b.nb_log || 0);
    const dpe = b.dpe;
    if (dpe === 'F' || dpe === 'G') fgCount++;
    if (b.risque_surchauffe_ete === 'Critique' || b.risque_surchauffe_ete === 'Élevé') highOverheatCount++;
  }

  // Calculate or retrieve total dwellings in territory
  if (state._totalTerritoryDwellings === undefined || state._totalTerritoryBuildingsRef !== state.buildings) {
    state._totalTerritoryBuildingsRef = state.buildings;
    state._totalTerritoryDwellings = (state.buildings || []).reduce((sum, b) => sum + Number(b.nb_log || 0), 0);
  }
  const allDwellingsCount = state._totalTerritoryDwellings || 0;

  const bldgEl = document.getElementById('kpi-buildings');
  const dwellEl = document.getElementById('kpi-dwellings');
  const slumsEl = document.getElementById('kpi-slums');
  const overheatEl = document.getElementById('kpi-overheating');
  const exportCountEl = document.getElementById('export-count');

  const bldgText = allBuildingsCount > 0 
    ? `${filteredBuildings.toLocaleString('fr-FR')} / ${allBuildingsCount.toLocaleString('fr-FR')}` 
    : '—';
  const dwellText = allBuildingsCount > 0 
    ? `${filteredDwellings.toLocaleString('fr-FR')} / ${allDwellingsCount.toLocaleString('fr-FR')}` 
    : '—';

  const prevBuildings = state._lastKpiBuildings;
  const prevDwellings = state._lastKpiDwellings;

  if (bldgEl) {
    bldgEl.textContent = bldgText;
    if (prevBuildings !== undefined && prevBuildings !== filteredBuildings) {
      bldgEl.classList.remove('kpi-blink');
      void bldgEl.offsetWidth; // Force DOM reflow to re-trigger CSS keyframe animation
      bldgEl.classList.add('kpi-blink');
    }
  }

  if (dwellEl) {
    dwellEl.textContent = dwellText;
    if (prevDwellings !== undefined && prevDwellings !== filteredDwellings) {
      dwellEl.classList.remove('kpi-blink');
      void dwellEl.offsetWidth; // Force DOM reflow to re-trigger CSS keyframe animation
      dwellEl.classList.add('kpi-blink');
    }
  }

  state._lastKpiBuildings = filteredBuildings;
  state._lastKpiDwellings = filteredDwellings;

  if (slumsEl) {
    slumsEl.textContent = filteredBuildings > 0 
      ? `${Math.round((fgCount / filteredBuildings) * 100)}%` 
      : '0%';
  }
  if (overheatEl) {
    overheatEl.textContent = filteredBuildings > 0 
      ? `${Math.round((highOverheatCount / filteredBuildings) * 100)}%` 
      : '0%';
  }
  if (exportCountEl) {
    exportCountEl.textContent = filteredBuildings.toLocaleString('fr-FR');
  }
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
  if (!state.map || !state.map.isStyleLoaded() || !state.map.getLayer('osm-tiles-layer')) return;
  const factor = Math.max(0, Math.min(100, dimPct)) / 100;
  
  // As dimPct increases (0% -> 100%), the map becomes progressively more and more white:
  // 1. Lower opacity reveals the pure white background layer beneath
  const opacity = Math.max(0.02, 1.0 - factor * 0.95);
  // 2. Increase brightness-min to wash out dark streets and text into pure white
  const brightnessMin = factor * 0.85;
  // 3. Desaturate to eliminate distracting colored features
  const saturation = -Math.min(1.0, factor * 1.2);

  state.map.setPaintProperty('osm-tiles-layer', 'raster-opacity', opacity);
  state.map.setPaintProperty('osm-tiles-layer', 'raster-brightness-min', brightnessMin);
  state.map.setPaintProperty('osm-tiles-layer', 'raster-saturation', saturation);
}

function updateLegend() {
  const title = document.getElementById('legend-title');
  const items = document.getElementById('legend-items');
  const selectWrap = document.getElementById('map-legend-select-wrap');
  const colorSelect = document.getElementById('select-color-mode');
  if (!items) return;

  items.innerHTML = '';

  // In Territory / Chunk Selection mode, replace building legend with Chunk Status Legend
  if (state.territorySelectionMode) {
    if (selectWrap) selectWrap.style.display = 'none';
    if (title) {
      title.style.display = 'block';
      title.textContent = 'Statut des Chunks & Territoires';
    }
    items.innerHTML = `
      <div class="legend-item"><span class="legend-color" style="background: #8b5cf6;"></span><span>Sélectionné</span></div>
      <div class="legend-item"><span class="legend-color" style="background: #10b981;"></span><span>En cache local</span></div>
      <div class="legend-item"><span class="legend-color" style="background: #0ea5e9;"></span><span>Prêt (téléchargeable)</span></div>
      <div class="legend-item"><span class="legend-color" style="background: #f59e0b;"></span><span>À la demande (ETL)</span></div>
    `;
    return;
  }

  // Normal mode: Show select dropdown at the top of the legend
  if (selectWrap) selectWrap.style.display = 'block';
  if (title) title.style.display = 'none';
  if (colorSelect && colorSelect.value !== state.mapStyleMode) {
    colorSelect.value = state.mapStyleMode;
  }

  // Fieldwork option visibility
  const optFieldwork = document.getElementById('opt-color-fieldwork');
  if (optFieldwork) {
    optFieldwork.style.display = (state.fieldwork && state.fieldwork.size > 0) ? 'block' : 'none';
  }

  if (state.mapStyleMode === 'dpe') {
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
    items.innerHTML = `
      <div class="legend-item"><span class="legend-color" style="background: #991b1b;"></span><span>Critique 🔥🔥</span></div>
      <div class="legend-item"><span class="legend-color" style="background: #ef4444;"></span><span>Élevé 🔥</span></div>
      <div class="legend-item"><span class="legend-color" style="background: #f59e0b;"></span><span>Modéré</span></div>
      <div class="legend-item"><span class="legend-color" style="background: #38bdf8;"></span><span>Faible</span></div>
      <div class="legend-item"><span class="legend-color" style="background: #64748b;"></span><span>Non renseigné</span></div>
    `;
  } else if (state.mapStyleMode === 'concentration') {
    items.innerHTML = `
      <div class="legend-item"><span class="legend-color" style="background: #ef4444;"></span><span>≥ 80%</span></div>
      <div class="legend-item"><span class="legend-color" style="background: #f59e0b;"></span><span>50–80%</span></div>
      <div class="legend-item"><span class="legend-color" style="background: #38bdf8;"></span><span>20–50%</span></div>
      <div class="legend-item"><span class="legend-color" style="background: #64748b;"></span><span>&lt; 20%</span></div>
    `;
  } else if (state.mapStyleMode === 'fieldwork') {
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

  // Fill Sociological, Rent Control, DVF & Technical Details Card
  const rentEl = document.getElementById('drawer-rent-control');
  if (rentEl) {
    const loyNm = b.loyer_max_t2_non_meuble_m2 ? `${Number(b.loyer_max_t2_non_meuble_m2).toFixed(1)} €/m²` : null;
    const loyM = b.loyer_max_t2_meuble_m2 ? `${Number(b.loyer_max_t2_meuble_m2).toFixed(1)} €/m²` : null;
    const zoneLoy = b.zone_encadrement_loyers ? `Zone ${b.zone_encadrement_loyers}` : 'Hors encadrement';
    const dvfPrix = b.dvf_prix_m2_median ? `${Math.round(Number(b.dvf_prix_m2_median)).toLocaleString('fr-FR')} €/m² (${b.dvf_nb_mutations || 0} ventes)` : 'NC';
    rentEl.innerHTML = `<strong>Encadrement loyers :</strong> ${escapeHtml(zoneLoy)}${loyNm ? ` • Plafond T2 : <strong>${loyNm}</strong> (meublé ${loyM || '—'})` : ''}<br><strong>Marché DVF :</strong> ${escapeHtml(dvfPrix)}`;
  }

  const urbanEl = document.getElementById('drawer-urban-rules');
  if (urbanEl) {
    const qpv = (b.quartier_qpv && b.quartier_qpv !== 'None') ? `🏘️ QPV : <strong>${escapeHtml(b.quartier_qpv)}</strong>` : 'Hors QPV';
    const social = b.est_logement_social_rpls ? `🏛️ Parc social RPLS (${b.nb_log_sociaux_rpls || 1} log., PMR: ${b.nb_log_pmr_rpls || 0})` : 'Parc privé';
    const copro = b.est_copro_rnc ? `🏢 Copro RNIC (${escapeHtml(b.nom_copro || 'Immatriculée')}, ${b.nb_lots_habitation_copro || '—'} lots)` : 'Monopropriété / Hors RNIC';
    urbanEl.innerHTML = `${qpv} • ${social}<br>${copro}`;
  }

  const techEl = document.getElementById('drawer-tech-details');
  if (techEl) {
    const chauf = `${b.type_energie_chauffage || 'NC'} (${b.type_installation_chauffage || 'NC'})`;
    const vit = b.type_vitrage || 'NC';
    const vent = b.type_ventilation || 'NC';
    const elec = b.conso_elec_res_par_pdl_kwh ? `${Math.round(Number(b.conso_elec_res_par_pdl_kwh)).toLocaleString('fr-FR')} kWh/an` : '—';
    const rcu = b.distance_reseau_chaleur != null ? `${Math.round(Number(b.distance_reseau_chaleur))} m` : '—';
    techEl.innerHTML = `<strong>Chauffage :</strong> ${escapeHtml(chauf)} • <strong>Conso élec réelle :</strong> ${elec}<br><strong>Vitrage :</strong> ${escapeHtml(vit)} • <strong>Ventilation :</strong> ${escapeHtml(vent)} • <strong>Réseau chaleur :</strong> ${rcu}`;
  }

  // Open Drawer
  document.getElementById('building-drawer').classList.add('open');
  saveSessionToStorage();
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
   Exports (Map PNG, Excel Bâtiments, Excel Bailleurs, Word .docx & GeoJSON/ZIP)
   ========================================================================== */
function getBuildingCellPlainValue(b, col) {
  if (col.customKey) {
    const r = state.fieldwork ? state.fieldwork.get(b.batiment_groupe_id) : null;
    return r && r[col.customKey] != null ? r[col.customKey] : '';
  }
  switch (col.key) {
    case 'batiment_groupe_id': return b.batiment_groupe_id || '';
    case 'adr': return b.adr || 'Adresse inconnue';
    case 'cp': return b.cp != null ? String(b.cp) : '';
    case 'nb_log': return b.nb_log != null ? Number(b.nb_log) : 1;
    case 'dpe': return b.dpe || 'NC';
    case 'nb_dpe_fg': return b.nb_dpe_fg != null ? Number(b.nb_dpe_fg) : 0;
    case 'pct_dpe_fg': return b.pct_dpe_fg != null ? Math.round(Number(b.pct_dpe_fg)) + '%' : '0%';
    case 'risque_surchauffe_ete': return b.risque_surchauffe_ete || 'Non renseigné';
    case 'score_surchauffe_ete': return b.score_surchauffe_ete != null ? Number(b.score_surchauffe_ete) : 0;
    case 'facteurs_surchauffe': return b.facteurs_surchauffe || '';
    case 'icu_expo_nuit': return b.icu_expo_nuit != null ? String(b.icu_expo_nuit) : '';
    case 'type_isolation_plancher_haut': return b.type_isolation_plancher_haut || '';
    case 'type_isolation_mur_exterieur': return b.type_isolation_mur_exterieur || '';
    case 'type_fermeture': return b.type_fermeture || '';
    case 'classe_inertie': return b.classe_inertie || '';
    case 'concentration_prop_max_denomination': return b.concentration_prop_max_denomination || '';
    case 'siren_principal': return b.siren_principal || '';
    case 'concentration_prop_max_pct': {
      const val = b.concentration_prop_max_num != null ? b.concentration_prop_max_num : b.concentration_prop_max_pct;
      const conc = val != null ? Math.round(Number(val)) : 0;
      return conc > 0 ? conc + '%' : '';
    }
    case 'max_patrimoine_majic_bailleur':
      return b.max_patrimoine_majic_bailleur ? Number(b.max_patrimoine_majic_bailleur) : 0;
    case 'loyer_max_t2_non_meuble_m2':
      return b.loyer_max_t2_non_meuble_m2 ? Number(b.loyer_max_t2_non_meuble_m2).toFixed(1) + ' €' : (b.zone_encadrement_loyers ? 'Zoné' : 'Non');
    case 'loyer_max_t2_meuble_m2':
      return b.loyer_max_t2_meuble_m2 ? Number(b.loyer_max_t2_meuble_m2).toFixed(1) + ' €' : (b.zone_encadrement_loyers ? 'Zoné' : 'Non');
    case 'est_logement_social_rpls':
      return b.est_logement_social_rpls ? 'Oui' : 'Non';
    case 'nom_copro': {
      let val = b.nom_copro || '';
      if (typeof val === 'string' && val.startsWith('[') && val.endsWith(']')) {
        try {
          const parsed = JSON.parse(val);
          if (Array.isArray(parsed)) val = parsed.join(', ');
        } catch (_) {}
      }
      return val;
    }
    case 'quartier_qpv':
      return b.quartier_qpv || '';
    default: {
      const v = b[col.key];
      if (v === null || v === undefined || v === 'None') return '';
      if (typeof v === 'boolean') return v ? 'Oui' : 'Non';
      return v;
    }
  }
}

function getSortedBuildingsForExport() {
  const cols = getAllBuildingsColumns().filter(c => !c.isAction);
  const list = [...state.filteredBuildings];
  if (buildingsSortCol && buildingsSortDir) {
    const activeCol = cols.find(c => c.key === buildingsSortCol);
    if (activeCol) {
      list.sort((a, b) => compareBuildingRows(a, b, activeCol, buildingsSortDir));
    } else {
      list.sort(defaultBuildingSort);
    }
  } else {
    list.sort(defaultBuildingSort);
  }
  return { rows: list, cols };
}

function getGroupedLandlordsForSelection() {
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

  const list = Array.from(groups.values());
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
        const cmp = activeCol.type === 'number'
          ? Number(vA || 0) - Number(vB || 0)
          : String(vA).localeCompare(String(vB), 'fr', { numeric: true, sensitivity: 'base' });
        return landlordsSortDir === 'desc' ? -cmp : cmp;
      });
      return { grouped: list, matchedOwners };
    }
  }
  list.sort((a, b) => {
    if (b.locauxCount !== a.locauxCount) return b.locauxCount - a.locauxCount;
    return b.buildings.size - a.buildings.size;
  });
  return { grouped: list, matchedOwners };
}

function buildBuildingsWorkbook() {
  const { rows, cols } = getSortedBuildingsForExport();
  const tableRows = rows.map(b => {
    const obj = {};
    for (const col of cols) {
      obj[col.label] = getBuildingCellPlainValue(b, col);
    }
    return obj;
  });

  const wsTable = XLSX.utils.json_to_sheet(tableRows);
  wsTable['!cols'] = cols.map(c => ({ wch: Math.max(12, Math.min(34, c.label.length + 6)) }));

  const rawRows = rows.map(b => {
    const copy = { ...b };
    delete copy.geometry;
    delete copy.render_color;
    return copy;
  });
  const wsRaw = XLSX.utils.json_to_sheet(rawRows);

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, wsTable, 'Tableau_Batiments');
  XLSX.utils.book_append_sheet(wb, wsRaw, 'Donnees_Brutes');
  return wb;
}

function buildOwnersWorkbook() {
  const { grouped, matchedOwners } = getGroupedLandlordsForSelection();
  const summaryRows = grouped.map(g => ({
    'SIREN': g.siren || 'NC',
    'Dénomination': g.denomination || '',
    'Forme Juridique': g.forme_juridique || '',
    'Bâtiments (sélection)': g.buildings.size,
    'Locaux (sélection)': g.locauxCount,
    'Patrimoine Total (locaux)': g.patrimoine_majic || 0,
    'Commune du Siège': g.commune_siege || '',
  }));

  const wsSummary = XLSX.utils.json_to_sheet(summaryRows);
  wsSummary['!cols'] = [
    { wch: 14 },
    { wch: 36 },
    { wch: 24 },
    { wch: 20 },
    { wch: 18 },
    { wch: 22 },
    { wch: 22 },
  ];

  const wsDetail = XLSX.utils.json_to_sheet(matchedOwners);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, wsSummary, 'Tableau_Bailleurs');
  XLSX.utils.book_append_sheet(wb, wsDetail, 'Detail_Par_Batiment');
  return wb;
}

function exportFilteredBuildingsExcel() {
  if (state.filteredBuildings.length === 0) {
    alert('Aucun bâtiment dans la sélection à exporter.');
    return;
  }
  showLoading('Génération du tableur Excel des bâtiments...');

  setTimeout(() => {
    try {
      const workbook = buildBuildingsWorkbook();
      XLSX.writeFile(workbook, `tezeloma_batiments_export_${new Date().toISOString().slice(0, 10)}.xlsx`);
    } finally {
      hideLoading();
      closeAllModals();
    }
  }, 80);
}

function exportFilteredOwnersExcel() {
  if (state.filteredBuildings.length === 0) {
    alert('Aucun bâtiment dans la sélection à exporter.');
    return;
  }
  showLoading('Génération du tableur des bailleurs...');

  setTimeout(() => {
    try {
      const workbook = buildOwnersWorkbook();
      XLSX.writeFile(workbook, `tezeloma_bailleurs_export_${new Date().toISOString().slice(0, 10)}.xlsx`);
    } finally {
      hideLoading();
      closeAllModals();
    }
  }, 80);
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
const TOOL_TITLES = {
  landlords: '🔍 Bailleurs & SCI',
  export: '📥 Exporter la sélection',
  sources: '📚 Sources de données',
  potential: '🔭 Pistes de données',
};

function initTabs() {
  document.querySelectorAll('.nav-tab[data-tab]').forEach(btn => {
    btn.addEventListener('click', () => {
      const tabId = btn.getAttribute('data-tab');
      switchTab(tabId);
    });
  });

  // Wrap each tool pane into a modal dialog
  document.querySelectorAll('.tool-pane').forEach(pane => {
    const id = pane.getAttribute('data-tool-pane');
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay tool-dialog-overlay';
    overlay.id = `tool-dialog-${id}`;
    overlay.innerHTML = `
      <div class="modal-content tool-dialog-content" role="dialog" aria-modal="true">
        <div class="modal-header">
          <h3 class="modal-title">${TOOL_TITLES[id] || id}</h3>
          <button type="button" class="drawer-close tool-dialog-close" aria-label="Fermer">&times;</button>
        </div>
        <div class="tool-dialog-body"></div>
      </div>`;
    overlay.querySelector('.tool-dialog-body').appendChild(pane);
    document.body.appendChild(overlay);
    overlay.querySelector('.tool-dialog-close').addEventListener('click', closeTool);
    overlay.addEventListener('mousedown', e => { if (e.target === overlay) closeTool(); });
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && state.openTool) closeTool(); });

  // Tools dropdown
  const dd = document.getElementById('tools-dropdown');
  const toggle = document.getElementById('btn-tools-toggle');
  const setMenu = open => {
    dd.classList.toggle('open', open);
    toggle.setAttribute('aria-expanded', String(open));
  };
  toggle.addEventListener('click', e => { e.stopPropagation(); setMenu(!dd.classList.contains('open')); });
  document.addEventListener('click', e => { if (!dd.contains(e.target)) setMenu(false); });
  dd.querySelectorAll('[data-tool]').forEach(item => {
    item.addEventListener('click', () => { setMenu(false); openTool(item.getAttribute('data-tool')); });
  });

  const headerExportBtn = document.getElementById('btn-header-export');
  if (headerExportBtn) {
    headerExportBtn.addEventListener('click', () => {
      openTool('export');
    });
  }
}

function openTool(toolId) {
  if (!TOOL_TITLES[toolId]) return;
  closeTool();
  state.openTool = toolId;
  document.getElementById(`tool-dialog-${toolId}`)?.classList.add('open');
  document.getElementById('btn-tools-toggle')?.classList.add('active');
  refreshOpenTool();
}

function closeTool() {
  document.querySelectorAll('.tool-dialog-overlay.open').forEach(o => o.classList.remove('open'));
  state.openTool = null;
  document.getElementById('btn-tools-toggle')?.classList.remove('active');
}

function refreshOpenTool() {
  if (state.openTool === 'landlords') renderLandlordsTab();
  else if (state.openTool === 'export') updateExportTab();
  else if (state.openTool === 'sources') renderSourcesTab();
}

function switchTab(tabId) {
  const TOOL_IDS = ['landlords', 'export', 'sources', 'potential'];
  if (TOOL_IDS.includes(tabId)) {
    openTool(tabId);
    return;
  }
  closeTool();
  state.activeTab = tabId;

  // Update navigation tab highlights
  document.querySelectorAll('.nav-tab[data-tab]').forEach(b => {
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
  }
  saveSessionToStorage();
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
  const baseKeys = new Set(BASE_BUILDINGS_TABLE_COLUMNS.map(c => c.key));
  const extraSocCols = [];

  for (const f of FILTER_DEFINITIONS) {
    if ((state.activeFilterIds.has(f.id) || f.isActive(state)) && f.column && !baseKeys.has(f.column)) {
      baseKeys.add(f.column);
      const isNum = f.controlType === 'slider' || f.controlType === 'number_min';
      extraSocCols.push({
        key: f.column,
        label: f.label.length > 26 ? f.label.slice(0, 24) + '…' : f.label,
        type: isNum ? 'number' : 'text',
        render: (b) => {
          const v = b[f.column];
          if (v === null || v === undefined || v === '' || v === 'None') return '—';
          if (typeof v === 'boolean') return v ? 'Oui' : 'Non';
          if (typeof v === 'number') return Number.isInteger(v) ? v.toLocaleString('fr-FR') : v.toFixed(1);
          return escapeHtml(String(v));
        },
      });
    }
  }

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
  return [...BASE_BUILDINGS_TABLE_COLUMNS, ...extraSocCols, ...fwCols, actionCol];
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
        scheduleSaveSession();
      }, 250);
    });
  }

  if (modeSelect) {
    modeSelect.addEventListener('change', () => {
      buildingsTableRenderLimit = 200;
      if (container) container.scrollTop = 0;
      renderBuildingsTable();
      scheduleSaveSession();
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
  scheduleSaveSession();

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
   Tab 4: Export Logic (Map PNG, Excel Bâtiments, Excel Bailleurs, Word .docx, subtle ZIP)
   ========================================================================== */
function formatFilterActiveCriterion(f) {
  const val = f.getValue ? f.getValue(state) : null;
  if (f.controlType === 'dpe_pills') {
    const arr = Array.isArray(val) ? val : Array.from(state.selectedDpes || []);
    return arr.length > 0 ? `Étiquettes retenues : ${arr.join(', ')}` : 'Aucune étiquette';
  }
  if (f.controlType === 'overheating_pills') {
    const arr = Array.isArray(val) ? val : Array.from(state.selectedOverheating || []);
    return arr.length > 0 ? `Niveaux retenus : ${arr.join(', ')}` : 'Aucun niveau';
  }
  if (f.controlType === 'legal_pills') {
    const arr = val && Array.isArray(val.selected) ? val.selected : Array.from(state.selectedLegal || []);
    const mode = (val && val.mode) || state.legalMode || 'inclusif';
    return `${arr.join(', ')} (mode ${mode})`;
  }
  if (f.controlType === 'slider' || f.controlType === 'number_min') {
    return `Seuil minimum : ≥ ${val}${f.unit || ''}`;
  }
  if (f.controlType === 'range_min_max') {
    const min = val && val.min ? val.min : '—';
    const max = val && val.max ? val.max : '—';
    return `Plage : de ${min} à ${max}`;
  }
  if (f.controlType === 'select') {
    if (Array.isArray(f.options)) {
      const opt = f.options.find(o => String(o.value) === String(val));
      if (opt) return opt.label;
    }
    return String(val || '');
  }
  if (f.controlType === 'text') {
    return `Recherche : « ${val || ''} »`;
  }
  return String(val != null ? val : '');
}

/**
 * Returns the active filters that ACTUALLY remove matches from the loaded territory
 * (i.e. where matchCount < state.buildings.length).
 */
function getEffectiveActiveFilters() {
  const bldgs = state.buildings || [];
  const totalCount = bldgs.length;
  if (totalCount === 0) return [];

  const catMap = new Map(SOCIOLOGICAL_CATEGORIES.map(c => [c.id, `${c.icon} ${c.title}`]));
  const effective = [];

  for (const f of FILTER_DEFINITIONS) {
    if (!state.activeFilterIds.has(f.id) || !f.isActive(state)) continue;
    let matchCount = 0;
    for (let i = 0; i < totalCount; i++) {
      if (f.matches(state, bldgs[i])) matchCount++;
    }
    const removedCount = totalCount - matchCount;
    if (removedCount > 0) {
      effective.push({
        id: f.id,
        label: f.label,
        categoryTitle: catMap.get(f.category) || f.category,
        criterionText: formatFilterActiveCriterion(f),
        desc: f.desc || '',
        source: f.source || 'BDNB',
        matchCount,
        removedCount,
        totalCount,
        removedPct: ((removedCount / totalCount) * 100).toFixed(1),
      });
    }
  }

  // Also check custom fieldwork filters if any remove matches
  if (state.fieldworkFilters && state.fieldwork && state.fieldwork.size > 0) {
    for (const [colName, filterVal] of Object.entries(state.fieldworkFilters)) {
      const trimmed = String(filterVal || '').trim().toLowerCase();
      if (!trimmed) continue;
      let matchCount = 0;
      for (let i = 0; i < totalCount; i++) {
        const fwRow = state.fieldwork.get(bldgs[i].batiment_groupe_id);
        const cellVal = fwRow && fwRow[colName] != null ? String(fwRow[colName]).toLowerCase() : '';
        if (cellVal.includes(trimmed)) matchCount++;
      }
      const removedCount = totalCount - matchCount;
      if (removedCount > 0) {
        effective.push({
          id: `fieldwork_${colName}`,
          label: `Enquête Terrain : ${colName}`,
          categoryTitle: '📋 Enquête de Terrain (.xlsx)',
          criterionText: `Contient « ${filterVal} »`,
          desc: `Filtre appliqué sur la colonne personnalisée "${colName}" du fichier de terrain importé.`,
          source: 'Fichier terrain (.xlsx)',
          matchCount,
          removedCount,
          totalCount,
          removedPct: ((removedCount / totalCount) * 100).toFixed(1),
        });
      }
    }
  }

  return effective;
}

function updateExportTab() {
  const countEl = document.getElementById('export-tab-count');
  const totalEl = document.getElementById('export-tab-total-count');
  const ownersEl = document.getElementById('export-tab-owners-count');
  const filtersEl = document.getElementById('export-tab-filters-count');

  if (countEl) countEl.textContent = state.filteredBuildings.length.toLocaleString('fr-FR');
  if (totalEl) totalEl.textContent = (state.buildings ? state.buildings.length : 0).toLocaleString('fr-FR');
  if (ownersEl) {
    const { grouped } = getGroupedLandlordsForSelection();
    ownersEl.textContent = grouped.length.toLocaleString('fr-FR');
  }
  if (filtersEl) {
    const eff = getEffectiveActiveFilters();
    filtersEl.textContent = eff.length.toLocaleString('fr-FR');
  }
}

function initExportTabControls() {
  const btnMapPng = document.getElementById('btn-export-map-png');
  const btnBldgs = document.getElementById('btn-export-tab-bldgs');
  const btnOwners = document.getElementById('btn-export-tab-owners');
  const btnWord = document.getElementById('btn-export-word-doc');
  const btnZip = document.getElementById('btn-export-full-zip');
  const btnGeojson = document.getElementById('btn-export-tab-geojson');

  if (btnMapPng) btnMapPng.addEventListener('click', exportMapPng);
  if (btnBldgs) btnBldgs.addEventListener('click', exportFilteredBuildingsExcel);
  if (btnOwners) btnOwners.addEventListener('click', exportFilteredOwnersExcel);
  if (btnWord) btnWord.addEventListener('click', exportWordReport);
  if (btnZip) btnZip.addEventListener('click', exportFilteredFullZip);
  if (btnGeojson) btnGeojson.addEventListener('click', exportFilteredGeoJSON);
}

function getMapStyleLegendEntries() {
  if (state.mapStyleMode === 'overheating') {
    return {
      title: 'Risque Surchauffe Estivale',
      entries: [
        { color: '#991b1b', label: 'Critique' },
        { color: '#ef4444', label: 'Élevé' },
        { color: '#f59e0b', label: 'Modéré' },
        { color: '#38bdf8', label: 'Faible' },
        { color: '#64748b', label: 'Non renseigné' },
      ],
    };
  }
  if (state.mapStyleMode === 'concentration') {
    return {
      title: 'Concentration Foncière',
      entries: [
        { color: '#ef4444', label: '≥ 80%' },
        { color: '#f59e0b', label: '50–80%' },
        { color: '#38bdf8', label: '20–50%' },
        { color: '#64748b', label: '< 20%' },
      ],
    };
  }
  if (state.mapStyleMode === 'fieldwork') {
    return {
      title: 'Enquête de Terrain',
      entries: [
        { color: '#a855f7', label: 'Visité / Enquêté' },
        { color: '#94a3b8', label: 'Non visité' },
      ],
    };
  }
  return {
    title: 'Diagnostic Énergétique (DPE)',
    entries: ['A', 'B', 'C', 'D', 'E', 'F', 'G'].map(c => ({
      color: DPE_COLORS[c],
      label: `DPE ${c}`,
    })),
  };
}

function getActiveTerritoryLabel() {
  const el = document.getElementById('sidebar-territory-name');
  if (el && el.textContent.trim()) return el.textContent.trim();
  const dep = state.activeTerritory?.dep || '69';
  return DEP_DISPLAY[dep] || `Département ${dep}`;
}

async function captureMapWithOverlays() {
  const paneMap = document.getElementById('pane-map');
  const wasInactive = paneMap && !paneMap.classList.contains('active');
  let prevStyle = '';

  if (wasInactive && paneMap) {
    prevStyle = paneMap.getAttribute('style') || '';
    paneMap.style.display = 'flex';
    paneMap.style.visibility = 'hidden';
    paneMap.style.position = 'absolute';
    paneMap.style.inset = '0';
    paneMap.style.zIndex = '-1';
  }

  try {
    if (state.map) {
      state.map.resize();
      state.map.triggerRepaint();
      await new Promise(resolve => {
        let done = false;
        const finish = () => {
          if (!done) {
            done = true;
            resolve();
          }
        };
        state.map.once('render', finish);
        setTimeout(finish, 250);
      });
    }

    const glCanvas = state.map ? state.map.getCanvas() : null;
    const width = (glCanvas && glCanvas.width > 100) ? glCanvas.width : 1280;
    const height = (glCanvas && glCanvas.height > 100) ? glCanvas.height : 800;

    const outCanvas = document.createElement('canvas');
    outCanvas.width = width;
    outCanvas.height = height;
    const ctx = outCanvas.getContext('2d');

    // 1. Background + WebGL map layer
    ctx.fillStyle = '#f8fafc';
    ctx.fillRect(0, 0, width, height);
    if (glCanvas && glCanvas.width > 0 && glCanvas.height > 0) {
      ctx.drawImage(glCanvas, 0, 0, width, height);
    }

    // 2. Top-Left Header Pill (Territory + Selection Count)
    const territoryLabel = getActiveTerritoryLabel();
    const selCount = state.filteredBuildings.length.toLocaleString('fr-FR');
    const totCount = (state.buildings ? state.buildings.length : 0).toLocaleString('fr-FR');
    const headerTitle = `TeZeLoMa — ${territoryLabel}`;
    const headerSub = `Sélection active : ${selCount} / ${totCount} bâtiments`;

    ctx.save();
    ctx.font = 'bold 15px system-ui, -apple-system, sans-serif';
    const w1 = ctx.measureText(headerTitle).width;
    ctx.font = '13px system-ui, -apple-system, sans-serif';
    const w2 = ctx.measureText(headerSub).width;
    const boxW = Math.max(w1, w2) + 32;
    const boxH = 54;

    ctx.fillStyle = 'rgba(255, 255, 255, 0.94)';
    ctx.strokeStyle = '#cbd5e1';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(16, 16, boxW, boxH, 8);
    else ctx.rect(16, 16, boxW, boxH);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#0f172a';
    ctx.font = 'bold 15px system-ui, -apple-system, sans-serif';
    ctx.fillText(headerTitle, 32, 38);
    ctx.fillStyle = '#0284c7';
    ctx.font = '600 13px system-ui, -apple-system, sans-serif';
    ctx.fillText(headerSub, 32, 58);
    ctx.restore();

    // 3. Bottom-Left Legend Box
    const legend = getMapStyleLegendEntries();
    ctx.save();
    ctx.font = 'bold 13px system-ui, -apple-system, sans-serif';
    let maxLegW = ctx.measureText(legend.title).width + 28;
    ctx.font = '12px system-ui, -apple-system, sans-serif';
    for (const item of legend.entries) {
      const iw = ctx.measureText(item.label).width + 48;
      if (iw > maxLegW) maxLegW = iw;
    }
    const legRowH = 20;
    const legH = 36 + legend.entries.length * legRowH + 10;
    const legX = 16;
    const legY = height - legH - 16;

    ctx.fillStyle = 'rgba(255, 255, 255, 0.94)';
    ctx.strokeStyle = '#cbd5e1';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(legX, legY, maxLegW, legH, 8);
    else ctx.rect(legX, legY, maxLegW, legH);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#0f172a';
    ctx.font = 'bold 13px system-ui, -apple-system, sans-serif';
    ctx.fillText(legend.title, legX + 14, legY + 24);

    ctx.font = '12px system-ui, -apple-system, sans-serif';
    legend.entries.forEach((item, idx) => {
      const ry = legY + 38 + idx * legRowH;
      ctx.fillStyle = item.color;
      ctx.fillRect(legX + 14, ry - 10, 14, 12);
      ctx.strokeStyle = 'rgba(15, 23, 42, 0.2)';
      ctx.lineWidth = 1;
      ctx.strokeRect(legX + 14, ry - 10, 14, 12);
      ctx.fillStyle = '#334155';
      ctx.fillText(item.label, legX + 36, ry);
    });
    ctx.restore();

    // 4. Bottom-Right Attribution
    ctx.save();
    const attrText = '© OpenStreetMap contributors • TeZeLoMa';
    ctx.font = '11px system-ui, -apple-system, sans-serif';
    const attrW = ctx.measureText(attrText).width + 18;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.fillRect(width - attrW - 12, height - 28, attrW, 20);
    ctx.fillStyle = '#475569';
    ctx.fillText(attrText, width - attrW - 3, height - 14);
    ctx.restore();

    const dataUrl = outCanvas.toDataURL('image/png');
    const base64 = dataUrl.split(',')[1];
    const binaryStr = atob(base64);
    const bytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) {
      bytes[i] = binaryStr.charCodeAt(i);
    }

    return {
      dataUrl,
      bytes,
      width,
      height,
    };
  } finally {
    if (wasInactive && paneMap) {
      if (prevStyle) paneMap.setAttribute('style', prevStyle);
      else paneMap.removeAttribute('style');
    }
  }
}

async function exportMapPng() {
  showLoading('Capture de la carte en PNG...');
  try {
    const { bytes } = await captureMapWithOverlays();
    const dateStr = new Date().toISOString().slice(0, 10);
    const blob = new Blob([bytes], { type: 'image/png' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `tezeloma_carte_${dateStr}.png`;
    a.click();
    URL.revokeObjectURL(url);
    closeAllModals();
  } catch (err) {
    console.error('Error exporting map PNG:', err);
    alert(`Erreur lors de l'export PNG de la carte : ${err.message}`);
  } finally {
    hideLoading();
  }
}

/* ==========================================================================
   Word (.docx) 4-Page Report Generator via JSZip (OpenXML WordprocessingML)
   Page 1: Active Filters (those that actually remove matches)
   Page 2: Map PNG + Legend
   Page 3: Bâtiments Table
   Page 4: Bailleurs Table
   ========================================================================== */
function escapeXml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function docxParagraph(text, opts = {}) {
  const {
    bold = false,
    italic = false,
    color = '0F172A',
    sizeHalfPt = 20,
    spaceBefore = 60,
    spaceAfter = 100,
    align = 'left',
    shadingFill = null,
  } = opts;
  const pPr = [
    `<w:spacing w:before="${spaceBefore}" w:after="${spaceAfter}"/>`,
    align !== 'left' ? `<w:jc w:val="${align}"/>` : '',
    shadingFill ? `<w:shd w:val="clear" w:color="auto" w:fill="${shadingFill}"/>` : '',
  ].join('');
  const rPr = [
    bold ? '<w:b/>' : '',
    italic ? '<w:i/>' : '',
    color ? `<w:color w:val="${color}"/>` : '',
    sizeHalfPt ? `<w:sz w:val="${sizeHalfPt}"/><w:szCs w:val="${sizeHalfPt}"/>` : '',
  ].join('');
  return `<w:p><w:pPr>${pPr}</w:pPr><w:r><w:rPr>${rPr}</w:rPr><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`;
}

function docxPageBreak() {
  return `<w:p><w:r><w:br w:type="page"/></w:r></w:p>`;
}

function docxTable(headers, rows, colWidthsPct = null, fontSizeHalfPt = 16) {
  const borderXml = `
    <w:tblBorders>
      <w:top w:val="single" w:sz="4" w:space="0" w:color="CBD5E1"/>
      <w:left w:val="single" w:sz="4" w:space="0" w:color="CBD5E1"/>
      <w:bottom w:val="single" w:sz="4" w:space="0" w:color="CBD5E1"/>
      <w:right w:val="single" w:sz="4" w:space="0" w:color="CBD5E1"/>
      <w:insideH w:val="single" w:sz="4" w:space="0" w:color="E2E8F0"/>
      <w:insideV w:val="single" w:sz="4" w:space="0" w:color="E2E8F0"/>
    </w:tblBorders>`;

  let headerCells = '';
  headers.forEach((h, i) => {
    const wPct = colWidthsPct && colWidthsPct[i] ? `<w:tcW w:w="${Math.round(colWidthsPct[i] * 50)}" w:type="pct"/>` : '';
    headerCells += `
      <w:tc>
        <w:tcPr>
          ${wPct}
          <w:shd w:val="clear" w:color="auto" w:fill="0F172A"/>
          <w:tcMar>
            <w:top w:w="80" w:type="dxa"/>
            <w:bottom w:w="80" w:type="dxa"/>
            <w:left w:w="100" w:type="dxa"/>
            <w:right w:w="100" w:type="dxa"/>
          </w:tcMar>
        </w:tcPr>
        <w:p>
          <w:pPr><w:spacing w:before="20" w:after="20"/></w:pPr>
          <w:r>
            <w:rPr><w:b/><w:color w:val="FFFFFF"/><w:sz w:val="${fontSizeHalfPt}"/><w:szCs w:val="${fontSizeHalfPt}"/></w:rPr>
            <w:t xml:space="preserve">${escapeXml(h)}</w:t>
          </w:r>
        </w:p>
      </w:tc>`;
  });

  let bodyRowsXml = '';
  rows.forEach((row, rIdx) => {
    const fill = rIdx % 2 === 1 ? 'F8FAFC' : 'FFFFFF';
    let cellsXml = '';
    row.forEach((cellVal, cIdx) => {
      const wPct = colWidthsPct && colWidthsPct[cIdx] ? `<w:tcW w:w="${Math.round(colWidthsPct[cIdx] * 50)}" w:type="pct"/>` : '';
      cellsXml += `
        <w:tc>
          <w:tcPr>
            ${wPct}
            <w:shd w:val="clear" w:color="auto" w:fill="${fill}"/>
            <w:tcMar>
              <w:top w:w="65" w:type="dxa"/>
              <w:bottom w:w="65" w:type="dxa"/>
              <w:left w:w="90" w:type="dxa"/>
              <w:right w:w="90" w:type="dxa"/>
            </w:tcMar>
          </w:tcPr>
          <w:p>
            <w:pPr><w:spacing w:before="15" w:after="15"/></w:pPr>
            <w:r>
              <w:rPr><w:color w:val="1E293B"/><w:sz w:val="${fontSizeHalfPt}"/><w:szCs w:val="${fontSizeHalfPt}"/></w:rPr>
              <w:t xml:space="preserve">${escapeXml(cellVal)}</w:t>
            </w:r>
          </w:p>
        </w:tc>`;
    });
    bodyRowsXml += `<w:tr>${cellsXml}</w:tr>`;
  });

  return `
    <w:tbl>
      <w:tblPr>
        <w:tblW w:w="5000" w:type="pct"/>
        ${borderXml}
      </w:tblPr>
      <w:tr><w:trPr><w:tblHeader/></w:trPr>${headerCells}</w:tr>
      ${bodyRowsXml}
    </w:tbl>`;
}

function docxEmbeddedImage(rId, widthPx, heightPx) {
  // Fit comfortably inside Landscape A4 page (max ~9.4in wide by ~5.0in tall)
  const maxW = 9.4 * 914400;
  const maxH = 5.0 * 914400;
  const aspect = (widthPx > 0 && heightPx > 0) ? (widthPx / heightPx) : 1.6;
  let cx = maxW;
  let cy = Math.round(cx / aspect);
  if (cy > maxH) {
    cy = maxH;
    cx = Math.round(cy * aspect);
  }

  return `
    <w:p>
      <w:pPr><w:jc w:val="center"/><w:spacing w:before="100" w:after="120"/></w:pPr>
      <w:r>
        <w:drawing>
          <wp:inline distT="0" distB="0" distL="0" distR="0">
            <wp:extent cx="${cx}" cy="${cy}"/>
            <wp:docPr id="1" name="Carte TeZeLoMa"/>
            <wp:cNvGraphicFramePr>
              <a:graphicFrameLocks noChangeAspect="1"/>
            </wp:cNvGraphicFramePr>
            <a:graphic>
              <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
                <pic:pic>
                  <pic:nvPicPr>
                    <pic:cNvPr id="0" name="map.png"/>
                    <pic:cNvPicPr/>
                  </pic:nvPicPr>
                  <pic:blipFill>
                    <a:blip r:embed="${rId}"/>
                    <a:stretch><a:fillRect/></a:stretch>
                  </pic:blipFill>
                  <pic:spPr>
                    <a:xfrm>
                      <a:off x="0" y="0"/>
                      <a:ext cx="${cx}" cy="${cy}"/>
                    </a:xfrm>
                    <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
                  </pic:spPr>
                </pic:pic>
              </a:graphicData>
            </a:graphic>
          </wp:inline>
        </w:drawing>
      </w:r>
    </w:p>`;
}

async function exportWordReport() {
  if (state.filteredBuildings.length === 0) {
    alert('Aucun bâtiment dans la sélection à exporter.');
    return;
  }
  if (typeof JSZip === 'undefined') {
    alert("La librairie JSZip n'est pas disponible.");
    return;
  }

  showLoading('Génération du rapport Word (.docx) en 4 pages...');

  try {
    const dateStr = new Date().toISOString().slice(0, 10);
    const nowFormatted = new Date().toLocaleString('fr-FR');
    const territoryLabel = getActiveTerritoryLabel();
    const totalLoaded = state.buildings ? state.buildings.length : 0;
    const filteredCount = state.filteredBuildings.length;
    const excludedTotal = Math.max(0, totalLoaded - filteredCount);

    // Compute synthesis KPIs on active selection
    let totalLogs = 0;
    let totalFgLogs = 0;
    let totalOverheat = 0;
    for (const b of state.filteredBuildings) {
      totalLogs += Number(b.nb_log || 0);
      totalFgLogs += Number(b.nb_dpe_fg != null ? b.nb_dpe_fg : (b.dpe === 'F' || b.dpe === 'G' ? (b.nb_log || 1) : 0));
      if (b.risque_surchauffe_ete === 'Élevé' || b.risque_surchauffe_ete === 'Critique') totalOverheat++;
    }

    const { grouped: groupedLandlords } = getGroupedLandlordsForSelection();
    const effectiveFilters = getEffectiveActiveFilters();

    // Capture Map PNG
    const mapCapture = await captureMapWithOverlays();

    // =========================================================================
    // PAGE 1: Active Filters (those that actually remove matches)
    // =========================================================================
    const profObj = getAllProfiles().find(p => p.id === state.activeProfileId);
    const profileLabel = profObj ? profObj.name : 'Sélection personnalisée';

    const page1Parts = [
      docxParagraph('TeZeLoMa — Rapport d\'Enquête Cartographique & Bailleurs', {
        bold: true, sizeHalfPt: 32, color: '0284C7', spaceBefore: 0, spaceAfter: 80,
      }),
      docxParagraph('Page 1 / 4 — Synthèse de la sélection & Filtres actifs (excluant des bâtiments)', {
        bold: true, sizeHalfPt: 24, color: '0F172A', spaceBefore: 20, spaceAfter: 140,
      }),
      docxParagraph(
        `Date : ${nowFormatted}   |   Territoire : ${territoryLabel}   |   Profil : ${profileLabel}`,
        { italic: true, sizeHalfPt: 18, color: '475569', spaceBefore: 0, spaceAfter: 160 }
      ),
      docxTable(
        ['Bâtiments retenus', 'Bâtiments exclus', 'Logements (sélection)', 'Logements DPE F/G', 'Surchauffe Élevée/Crit.', 'Bailleurs PM identifiés'],
        [[
          `${filteredCount.toLocaleString('fr-FR')} / ${totalLoaded.toLocaleString('fr-FR')}`,
          `${excludedTotal.toLocaleString('fr-FR')} (-${totalLoaded > 0 ? ((excludedTotal / totalLoaded) * 100).toFixed(1) : '0.0'}%)`,
          totalLogs.toLocaleString('fr-FR'),
          totalFgLogs.toLocaleString('fr-FR'),
          totalOverheat.toLocaleString('fr-FR'),
          groupedLandlords.length.toLocaleString('fr-FR'),
        ]],
        [18, 18, 16, 16, 16, 16],
        17
      ),
      docxParagraph(
        `Filtres actifs réduisant effectivement la sélection (${effectiveFilters.length} filtre${effectiveFilters.length > 1 ? 's' : ''}) :`,
        { bold: true, sizeHalfPt: 22, color: '0F172A', spaceBefore: 220, spaceAfter: 80 }
      ),
      docxParagraph(
        'Seuls les filtres actifs qui écartent effectivement au moins un bâtiment du territoire chargé sont listés ci-dessous avec leur impact mesuré :',
        { italic: true, sizeHalfPt: 17, color: '475569', spaceBefore: 0, spaceAfter: 120 }
      ),
    ];

    if (effectiveFilters.length === 0) {
      page1Parts.push(
        docxParagraph(
          'Aucun filtre actif ne réduit la sélection sur ce territoire (100 % des bâtiments chargés sont conservés).',
          { bold: true, sizeHalfPt: 19, color: '334155', spaceBefore: 80, spaceAfter: 120 }
        )
      );
    } else {
      const filterRows = effectiveFilters.map(ef => [
        ef.label,
        ef.categoryTitle.replace(/^[^\wÀ-ÿ]+/, '').trim(),
        ef.criterionText,
        `${ef.matchCount.toLocaleString('fr-FR')} / ${ef.totalCount.toLocaleString('fr-FR')} retenus (${ef.removedCount.toLocaleString('fr-FR')} exclus, -${ef.removedPct}%)`,
        `${ef.desc} [Source : ${ef.source}]`,
      ]);
      page1Parts.push(
        docxTable(
          ['Filtre actif', 'Catégorie', 'Critère appliqué', 'Impact sur les bâtiments', 'Explication & Source'],
          filterRows,
          [20, 15, 17, 18, 30],
          16
        )
      );
    }

    // =========================================================================
    // PAGE 2: Map PNG + Legend
    // =========================================================================
    const legendInfo = getMapStyleLegendEntries();
    const page2Parts = [
      docxParagraph('Page 2 / 4 — Carte de la sélection', {
        bold: true, sizeHalfPt: 24, color: '0F172A', spaceBefore: 0, spaceAfter: 60,
      }),
      docxParagraph(
        `Territoire : ${territoryLabel}   |   Coloration : ${legendInfo.title}   |   ${filteredCount.toLocaleString('fr-FR')} bâtiments affichés`,
        { italic: true, sizeHalfPt: 18, color: '475569', spaceBefore: 0, spaceAfter: 80 }
      ),
      docxEmbeddedImage('rIdMapImg', mapCapture.width, mapCapture.height),
      docxParagraph(
        `Légende active (${legendInfo.title}) : ${legendInfo.entries.map(e => e.label).join('  •  ')}`,
        { bold: true, sizeHalfPt: 17, color: '334155', align: 'center', spaceBefore: 60, spaceAfter: 60 }
      ),
    ];

    // =========================================================================
    // PAGE 3: Bâtiments Table
    // =========================================================================
    const { rows: sortedBldgs } = getSortedBuildingsForExport();
    const maxDocxBldgRows = 25;
    const bldgSlice = sortedBldgs.slice(0, maxDocxBldgRows);
    const bldgDocxCols = [
      { label: 'ID BDNB', get: b => b.batiment_groupe_id || '' },
      { label: 'Adresse', get: b => b.adr || 'Adresse inconnue' },
      { label: 'CP', get: b => b.cp != null ? String(b.cp) : '' },
      { label: 'Log.', get: b => b.nb_log != null ? String(b.nb_log) : '1' },
      { label: 'DPE', get: b => b.dpe || 'NC' },
      { label: '% F/G', get: b => b.pct_dpe_fg != null ? Math.round(Number(b.pct_dpe_fg)) + '%' : '0%' },
      { label: 'Risque Été', get: b => b.risque_surchauffe_ete || 'Non renseigné' },
      { label: 'Score', get: b => b.score_surchauffe_ete != null ? `${b.score_surchauffe_ete}/100` : '0/100' },
      { label: 'Principal Bailleur', get: b => b.concentration_prop_max_denomination || '—' },
      { label: 'SIREN', get: b => b.siren_principal || '—' },
      { label: 'Conc. %', get: b => {
        const val = b.concentration_prop_max_num != null ? b.concentration_prop_max_num : b.concentration_prop_max_pct;
        return val != null && Number(val) > 0 ? Math.round(Number(val)) + '%' : '—';
      }},
      { label: 'Loyer Max T2', get: b => b.loyer_max_t2_non_meuble_m2 ? Number(b.loyer_max_t2_non_meuble_m2).toFixed(1) + ' €' : (b.zone_encadrement_loyers ? 'Zoné' : 'Non') },
    ];

    const bldgTableRows = bldgSlice.map(b => bldgDocxCols.map(c => c.get(b)));
    const bldgTruncNote = sortedBldgs.length > maxDocxBldgRows
      ? `Affichage des ${maxDocxBldgRows} premiers bâtiments selon le tri actif sur ${sortedBldgs.length.toLocaleString('fr-FR')} au total (voir l'export Excel Bâtiments pour la liste intégrale).`
      : `Liste complète des ${sortedBldgs.length.toLocaleString('fr-FR')} bâtiment(s) de la sélection active.`;

    const page3Parts = [
      docxParagraph(`Page 3 / 4 — Tableau des Bâtiments (${sortedBldgs.length.toLocaleString('fr-FR')} bâtiments)`, {
        bold: true, sizeHalfPt: 24, color: '0F172A', spaceBefore: 0, spaceAfter: 60,
      }),
      docxParagraph(bldgTruncNote, {
        italic: true, sizeHalfPt: 17, color: '475569', spaceBefore: 0, spaceAfter: 100,
      }),
      docxTable(
        bldgDocxCols.map(c => c.label),
        bldgTableRows,
        [10, 20, 5, 5, 5, 5, 9, 6, 15, 8, 6, 6],
        14
      ),
    ];

    // =========================================================================
    // PAGE 4: Bailleurs Table
    // =========================================================================
    const maxDocxOwnerRows = 25;
    const ownerSlice = groupedLandlords.slice(0, maxDocxOwnerRows);
    const ownerTruncNote = groupedLandlords.length > maxDocxOwnerRows
      ? `Affichage des ${maxDocxOwnerRows} premiers bailleurs personnes morales sur ${groupedLandlords.length.toLocaleString('fr-FR')} au total (voir l'export Excel Bailleurs pour la liste intégrale).`
      : `Liste complète des ${groupedLandlords.length.toLocaleString('fr-FR')} bailleur(s) personne(s) morale(s) de la sélection active.`;

    const page4Parts = [
      docxParagraph(`Page 4 / 4 — Tableau des Bailleurs & SCI (${groupedLandlords.length.toLocaleString('fr-FR')} entités morales)`, {
        bold: true, sizeHalfPt: 24, color: '0F172A', spaceBefore: 0, spaceAfter: 60,
      }),
      docxParagraph(ownerTruncNote, {
        italic: true, sizeHalfPt: 17, color: '475569', spaceBefore: 0, spaceAfter: 100,
      }),
    ];

    if (ownerSlice.length === 0) {
      page4Parts.push(
        docxParagraph('Aucun propriétaire personne morale identifié dans la sélection active.', {
          italic: true, sizeHalfPt: 18, color: '64748B', spaceBefore: 80, spaceAfter: 80,
        })
      );
    } else {
      const ownerTableRows = ownerSlice.map(g => [
        g.siren || 'NC',
        g.denomination || '',
        g.forme_juridique || '',
        g.buildings.size.toLocaleString('fr-FR'),
        g.locauxCount.toLocaleString('fr-FR'),
        g.patrimoine_majic > 0 ? `${g.patrimoine_majic.toLocaleString('fr-FR')} loc.` : '—',
        g.commune_siege || '—',
      ]);
      page4Parts.push(
        docxTable(
          ['SIREN', 'Dénomination', 'Forme Juridique', 'Bâtiments (sél.)', 'Locaux (sél.)', 'Patrimoine Total', 'Commune du Siège'],
          ownerTableRows,
          [11, 28, 16, 11, 11, 11, 12],
          15
        )
      );
    }

    // Combine all 4 pages with explicit page breaks into word/document.xml
    const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
            xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
            xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
            xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
            xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
  <w:body>
    ${page1Parts.join('\n')}
    ${docxPageBreak()}
    ${page2Parts.join('\n')}
    ${docxPageBreak()}
    ${page3Parts.join('\n')}
    ${docxPageBreak()}
    ${page4Parts.join('\n')}
    <w:sectPr>
      <w:pgSz w:w="16838" w:h="11906" w:orient="landscape"/>
      <w:pgMar w:top="720" w:right="720" w:bottom="720" w:left="720" w:header="360" w:footer="360" w:gutter="0"/>
    </w:sectPr>
  </w:body>
</w:document>`;

    const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="png" ContentType="image/png"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`;

    const rootRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

    const docRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
  <Relationship Id="rIdMapImg" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/map.png"/>
</Relationships>`;

    const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults>
    <w:rPrDefault>
      <w:rPr>
        <w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/>
        <w:sz w:val="20"/>
        <w:szCs w:val="20"/>
        <w:lang w:val="fr-FR"/>
      </w:rPr>
    </w:rPrDefault>
  </w:docDefaults>
</w:styles>`;

    const docxZip = new JSZip();
    docxZip.file('[Content_Types].xml', contentTypesXml);
    docxZip.file('_rels/.rels', rootRelsXml);
    docxZip.file('word/document.xml', documentXml);
    docxZip.file('word/_rels/document.xml.rels', docRelsXml);
    docxZip.file('word/styles.xml', stylesXml);
    docxZip.file('word/media/map.png', mapCapture.bytes);

    const blob = await docxZip.generateAsync({
      type: 'blob',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
    });

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `tezeloma_rapport_export_${dateStr}.docx`;
    a.click();
    URL.revokeObjectURL(url);
    closeAllModals();
  } catch (err) {
    console.error('Error generating Word report:', err);
    alert(`Erreur lors de la génération du rapport Word : ${err.message}`);
  } finally {
    hideLoading();
  }
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
    const wbBldgs = buildBuildingsWorkbook();
    const bldgArray = XLSX.write(wbBldgs, { bookType: 'xlsx', type: 'array' });
    zip.file('tableur_batiments_groupe.xlsx', bldgArray);

    // 2. Excel Bailleurs
    const wbOwners = buildOwnersWorkbook();
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
    const { matchedOwners } = getGroupedLandlordsForSelection();
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
      `   Synthèse des propriétaires personnes morales et détail par bâtiment avec SIREN,`,
      `   forme juridique et locaux possédés.`,
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
   Tab 5: Info-Oriented Data Sources & Traceability Dictionary
   ========================================================================== */

const SOURCE_METADATA_MAP = {
  'ADEME / BDNB': { file: 'csv/batiment_groupe_dpe_representatif_logement.csv', producer: 'ADEME / CSTB BDNB', mode: 'csv', coverage: 'France entière' },
  'ADEME DPE par lot': { file: 'csv/batiment_groupe_dpe_statistique_logement.csv', producer: 'ADEME (Observatoire DPE)', mode: 'csv', coverage: 'France entière' },
  'ADEME DPE': { file: 'csv/batiment_groupe_dpe_representatif_logement.csv', producer: 'ADEME (Observatoire DPE)', mode: 'csv', coverage: 'France entière' },
  'BDNB / ADEME': { file: 'csv/batiment_groupe_dpe_statistique_logement.csv', producer: 'ADEME / CSTB BDNB', mode: 'csv', coverage: 'France entière' },
  'BDNB / DPE': { file: 'csv/batiment_groupe_dpe_representatif_logement.csv', producer: 'ADEME / CSTB BDNB', mode: 'csv', coverage: 'France entière' },
  'Score Composite TeZeLoMa': { file: 'Calcul composite (BDNB ADEME + WFS Grand Lyon / Cerema)', producer: 'Collectif TeZeLoMa', mode: 'etl', coverage: 'Lyon (69) & Grenoble (38)' },
  'Data Grand Lyon WFS': { file: 'ilots_chaleur_urbains.geojson & encadrement_loyers.geojson', producer: 'Métropole de Lyon (Data Grand Lyon)', mode: 'wfs', coverage: '69 — Métropole de Lyon' },
  'DGFiP MAJIC / RNE': { file: 'csv/proprietaire.csv + API recherche-entreprises.api.gouv.fr', producer: 'DGFiP MAJIC / DINUM RNE', mode: 'api', coverage: 'France entière' },
  'DGFiP MAJIC': { file: 'csv/rel_batiment_groupe_proprietaire.csv + csv/proprietaire.csv', producer: 'DGFiP (Fichiers Fonciers MAJIC)', mode: 'csv', coverage: 'Départements 69, 38, 44, 76 & 34' },
  'DGFiP MAJIC / INSEE': { file: 'csv/proprietaire.csv', producer: 'DGFiP MAJIC / INSEE', mode: 'csv', coverage: 'France entière' },
  'ANCT / BDNB': { file: 'csv/batiment_groupe_qpv.csv', producer: 'ANCT (Politique de la Ville)', mode: 'csv', coverage: 'France entière' },
  'Ministère du Logement (RPLS)': { file: 'csv/batiment_groupe_rpls.csv', producer: 'Ministère du Logement (RPLS)', mode: 'csv', coverage: 'France entière' },
  'RPLS': { file: 'csv/batiment_groupe_rpls.csv', producer: 'Ministère du Logement (RPLS)', mode: 'csv', coverage: 'France entière' },
  'RPLS (accessible_pmr)': { file: 'csv/batiment_groupe_rpls.csv', producer: 'Ministère du Logement (RPLS)', mode: 'csv', coverage: 'France entière' },
  'Préfecture / Data Grand Lyon': { file: 'encadrement_loyers.geojson & Base_OP_2024_L3800.csv', producer: 'Préfecture / Observatoire des Loyers', mode: 'wfs', coverage: 'Lyon (69) & Grenoble (38)' },
  'Arrêté Préfectoral 2025-2026': { file: 'encadrement_loyers.geojson & Base_OP_2024_L3800.csv', producer: 'Préfecture du Rhône / de l\'Isère', mode: 'wfs', coverage: 'Lyon (69) & Grenoble (38)' },
  'DGFiP DVF Open Data': { file: 'csv/batiment_groupe_dvf_open_statistique.csv', producer: 'DGFiP (DVF Open Data)', mode: 'csv', coverage: 'France entière' },
  'ANAH RNIC': { file: 'csv/batiment_groupe_rnc.csv', producer: 'ANAH (Registre Copropriétés RNIC)', mode: 'csv', coverage: 'France entière' },
  'DGFiP FFO / BDNB': { file: 'csv/batiment_groupe_ffo_bat.csv', producer: 'DGFiP (Fichiers Fonciers) / CSTB', mode: 'csv', coverage: 'France entière' },
  'DGFiP FFO': { file: 'csv/batiment_groupe_ffo_bat.csv', producer: 'DGFiP (Fichiers Fonciers)', mode: 'csv', coverage: 'France entière' },
  'IGN BD TOPO': { file: 'csv/batiment_groupe_bdtopo_bat.csv', producer: 'IGN (BD TOPO)', mode: 'csv', coverage: 'France entière' },
  'ADEME DPE / FFO': { file: 'csv/batiment_groupe_dpe_representatif_logement.csv', producer: 'ADEME / DGFiP FFO', mode: 'csv', coverage: 'France entière' },
  'BDNB Synthèse': { file: 'csv/batiment_groupe_synthese_propriete_usage.csv', producer: 'CSTB BDNB', mode: 'csv', coverage: 'France entière' },
  'GPU Urbanisme / BDNB': { file: 'csv/batiment_groupe_urbanisme.csv', producer: 'GPU (Géoportail de l\'Urbanisme)', mode: 'csv', coverage: 'France entière' },
  'IRSN / BDNB': { file: 'csv/batiment_groupe_risques.csv', producer: 'IRSN (Aléa Radon)', mode: 'csv', coverage: 'France entière' },
  'BRGM / Géorisques': { file: 'csv/batiment_groupe_risques.csv', producer: 'BRGM (Géorisques / Argiles)', mode: 'csv', coverage: 'France entière' },
  'CEREMA / France Chaleur Urbaine': { file: 'csv/batiment_groupe_indicateur_reseau_chaud_froid.csv', producer: 'Cerema / France Chaleur Urbaine', mode: 'csv', coverage: 'France entière' },
  'INSEE / BAN': { file: 'csv/adresse.csv + csv/batiment_groupe_adresse.csv', producer: 'INSEE / Base Adresse Nationale', mode: 'csv', coverage: 'France entière' },
  'INSEE IRIS': { file: 'csv/batiment_groupe_bdtopo_bat.csv', producer: 'INSEE (Contours IRIS)', mode: 'csv', coverage: 'France entière' },
  'BAN Adresses': { file: 'csv/rel_batiment_groupe_adresse.csv + csv/adresse.csv', producer: 'Base Adresse Nationale (BAN)', mode: 'csv', coverage: 'France entière' },
  'Tableur militant (.xlsx)': { file: 'Tableur local .xlsx importé (fieldwork_saved.parquet)', producer: 'Collectif d\'enquête TeZeLoMa', mode: 'xlsx', coverage: 'Territoire d\'enquête' },
  'Enedis DLE / SDES': { file: 'csv/batiment_groupe_dle_elec_multimillesime.csv', producer: 'Enedis / SDES (Données Énergie)', mode: 'csv', coverage: 'France entière' },
  'GRDF DLE / SDES': { file: 'csv/batiment_groupe_dle_gaz_multimillesime.csv', producer: 'GRDF / SDES (Données Énergie)', mode: 'csv', coverage: 'France entière' },
};

const RAW_COLUMN_OVERRIDE = {
  'dpe': 'classe_bilan_dpe / dpe',
  'classe_ges': 'classe_emission_ges / classe_ges',
  'conso_ep_m2': 'conso_energie_primaire_m2 / conso_ep_m2',
  'hauteur_moyenne_m': 'hauteur_mean / hauteur_moyenne_m',
  'owner_search': 'denomination / concentration_prop_max_denomination',
  'legal_category': 'forme_juridique / formes_juridiques',
  'concentration_pct': 'concentration_prop_max_pct / concentration_prop_max_num',
  'max_locaux_un_prop': 'max_locaux_open_un_prop',
  'min_patrimoine_majic': 'nb_locaux_open_dans_MAJIC / max_patrimoine_majic_bailleur',
  'bailleur_distant': 'code_postal_proprietaire',
  'social_rpls_mode': 'est_logement_social_rpls',
  'pmr_rpls_mode': 'nb_log_pmr_rpls',
  'qpv_mode': 'quartier_qpv',
  'rent_control_mode': 'zone_encadrement_loyers',
  'loyer_max_t2_nm': 'loyer_max_t2_non_meuble_m2',
  'copro_status': 'immat_copro / est_copro_rnc',
  'copro_search': 'nom_copro',
  'nb_lots_copro': 'nb_lots_copro / nb_lots_habitation_copro',
  'patrimoine_abf': 'zone_plu_bati_patrimonial / contrainte_urbanisme_ac1',
  'has_clim': 'type_energie_climatisation',
  'fieldwork_status': 'fieldwork_status (clé batiment_groupe_id)',
  'surface_habitable_logement': 'surface_habitable_logement',
};

const EXTRA_DISPLAYABLE_VARIABLES = [
  {
    id: 'batiment_groupe_id',
    category: 'morphology',
    label: 'Identifiant national unique BDNB du bâtiment',
    rawColumn: 'batiment_groupe_id',
    source: 'CSTB BDNB',
    sourceFile: 'csv/batiment_groupe.csv',
    producer: 'CSTB (Base Nationale des Bâtiments)',
    retrievalMode: 'parquet',
    coverage: 'France entière',
    isFilter: false,
    isDisplay: true,
    isLandlord: false,
    desc: 'Identifiant pivot officiel pérenne attribué par le CSTB pour relier l\'ensemble des 16 tables foncières, cadastrales, énergétiques et cartographiques d\'un même groupe de bâtiments.',
  },
  {
    id: 'adr',
    category: 'geography',
    label: 'Adresse postale officielle (Numéro et nom de voie)',
    rawColumn: 'adr',
    source: 'Base Adresse Nationale (BAN)',
    sourceFile: 'csv/adresse.csv + csv/rel_batiment_groupe_adresse.csv',
    producer: 'Base Adresse Nationale (BAN)',
    retrievalMode: 'parquet',
    coverage: 'France entière',
    isFilter: true,
    isDisplay: true,
    isLandlord: false,
    desc: 'Libellé d\'adresse complet certifié issu de la Base Adresse Nationale (BAN) et rattaché à l\'emprise du bâtiment. Utilisé pour les infobulles, la table et les fiches d\'enquête.',
  },
  {
    id: 'cp',
    category: 'geography',
    label: 'Code postal de distribution',
    rawColumn: 'cp',
    source: 'Base Adresse Nationale (BAN)',
    sourceFile: 'csv/adresse.csv',
    producer: 'Base Adresse Nationale (BAN)',
    retrievalMode: 'parquet',
    coverage: 'France entière',
    isFilter: true,
    isDisplay: true,
    isLandlord: false,
    desc: 'Code postal d\'acheminement à 5 chiffres (ex: 69001 à 69009, 69100, 38000...) servant au découpage en zones polygonales et au ciblage d\'intervention par quartier.',
  },
  {
    id: 'code_commune_insee',
    category: 'geography',
    label: 'Code officiel géographique commune (INSEE)',
    rawColumn: 'code_commune_insee',
    source: 'INSEE',
    sourceFile: 'csv/adresse.csv',
    producer: 'INSEE',
    retrievalMode: 'parquet',
    coverage: 'France entière',
    isFilter: false,
    isDisplay: true,
    isLandlord: false,
    desc: 'Code INSEE officiel à 5 chiffres de la commune ou arrondissement de rattachement (ex: 69381 à 69389 pour Lyon, 69266 pour Villeurbanne, 38185 pour Grenoble).',
  },
  {
    id: 'surface_emprise_sol_m2',
    category: 'morphology',
    label: 'Surface d\'emprise au sol du bâtiment (m²)',
    rawColumn: 'surface_emprise_sol_m2',
    source: 'IGN BD TOPO',
    sourceFile: 'csv/batiment_groupe_bdtopo_bat.csv',
    producer: 'IGN (BD TOPO)',
    retrievalMode: 'parquet',
    coverage: 'France entière',
    isFilter: false,
    isDisplay: true,
    isLandlord: false,
    desc: 'Superficie calculée en mètres carrés de l\'emprise cadastrale au sol du bâtiment, calculée géométriquement d\'après les contours de la BD TOPO IGN.',
  },
  {
    id: 'geometry',
    category: 'morphology',
    label: 'Emprise vectorielle polygonale GPS (WGS84)',
    rawColumn: 'geom_groupe / geometry',
    source: 'IGN BD TOPO',
    sourceFile: 'csv/batiment_groupe_bdtopo_bat.csv',
    producer: 'IGN (BD TOPO)',
    retrievalMode: 'parquet',
    coverage: 'France entière',
    isFilter: false,
    isDisplay: true,
    isLandlord: false,
    desc: 'Coordonnées vectorielles polygonales géoréférencées (polygone ou multipolygone GPS WGS84) du bâtiment, restituées et stylisées dynamiquement sur la carte MapLibre.',
  },
  {
    id: 'nb_adresses',
    category: 'geography',
    label: 'Nombre d\'adresses postales distinctes rattachées',
    rawColumn: 'nb_adresses',
    source: 'Base Adresse Nationale (BAN)',
    sourceFile: 'csv/batiment_groupe_adresse.csv',
    producer: 'Base Adresse Nationale (BAN)',
    retrievalMode: 'parquet',
    coverage: 'France entière',
    isFilter: false,
    isDisplay: true,
    isLandlord: false,
    desc: 'Nombre d\'entrées d\'immeuble et de numéros de rue officiels recensés sur la même emprise bâtie (permet de repérer les grands ensembles ou immeubles d\'angle).',
  },
  {
    id: 'usage_principal_bdnb_open',
    category: 'morphology',
    label: 'Usage principal officiel BDNB',
    rawColumn: 'usage_principal_bdnb_open',
    source: 'CSTB BDNB',
    sourceFile: 'csv/batiment_groupe.csv',
    producer: 'CSTB (Base Nationale des Bâtiments)',
    retrievalMode: 'parquet',
    coverage: 'France entière',
    isFilter: false,
    isDisplay: true,
    isLandlord: false,
    desc: 'Affectation d\'usage majoritaire du bâtiment (Résidentiel, Tertiaire, Mixte) consolidée par le CSTB à partir des déclarations fiscales foncières.',
  },
  {
    id: 'facteurs_surchauffe',
    category: 'summer',
    label: 'Facteurs explicatifs de vulnérabilité canicule',
    rawColumn: 'facteurs_surchauffe',
    source: 'Collectif TeZeLoMa',
    sourceFile: 'Score Composite TeZeLoMa (Algorithme multi-critères)',
    producer: 'Collectif TeZeLoMa',
    retrievalMode: 'etl',
    coverage: 'Lyon (69) & Grenoble (38)',
    isFilter: false,
    isDisplay: true,
    isLandlord: false,
    desc: 'Liste textuelle synthétique détaillant les défauts thermiques cumulés de l\'immeuble (ex: « Toiture non isolée • Absence de volets • ICU Nocturne élevé »). Affichée sur la fiche inspecteur.',
  },
  {
    id: 'loyer_ref_t2_non_meuble_m2',
    category: 'social',
    label: 'Loyer de référence médian préfectoral T2 non-meublé (€/m²)',
    rawColumn: 'loyer_ref_t2_non_meuble_m2',
    source: 'Préfecture / Observatoire des Loyers',
    sourceFile: 'encadrement_loyers.geojson & Base_OP_2024_L3800.csv',
    producer: 'Préfecture / Observatoire des Loyers',
    retrievalMode: 'wfs',
    coverage: 'Lyon (69) & Grenoble (38)',
    isFilter: false,
    isDisplay: true,
    isLandlord: false,
    desc: 'Loyer médian de référence fixé par arrêté préfectoral pour un logement T2 de même époque. Le loyer plafond légal (+20%) découle directement de cette valeur.',
  },
  {
    id: 'loyer_max_t2_meuble_m2',
    category: 'social',
    label: 'Loyer plafond légal majoré T2 meublé (€/m²)',
    rawColumn: 'loyer_max_t2_meuble_m2',
    source: 'Préfecture / Data Grand Lyon',
    sourceFile: 'encadrement_loyers.geojson',
    producer: 'Préfecture / Data Grand Lyon',
    retrievalMode: 'wfs',
    coverage: '69 — Métropole de Lyon',
    isFilter: false,
    isDisplay: true,
    isLandlord: false,
    desc: 'Montant maximal légal autorisé au m² pour un bail meublé T2 (majoration meublé comprise). Tout dépassement expose le bailleur à une mise en demeure et une action locataire.',
  },
  {
    id: 'dvf_valeur_mediane',
    category: 'social',
    label: 'Valeur vénale médiane des transactions DVF (€)',
    rawColumn: 'dvf_valeur_mediane',
    source: 'DGFiP DVF Open Data',
    sourceFile: 'csv/batiment_groupe_dvf_open_statistique.csv',
    producer: 'DGFiP (DVF Open Data)',
    retrievalMode: 'csv',
    coverage: 'France entière',
    isFilter: false,
    isDisplay: true,
    isLandlord: false,
    desc: 'Montant net vendeur médian en euros des ventes immobilières actées chez le notaire dans cet ensemble immobilier au cours des 5 dernières années.',
  },
  {
    id: 'personne_id',
    category: 'landlords',
    label: 'Identifiant propriétaire personne morale (Cadastre MAJIC)',
    rawColumn: 'personne_id',
    source: 'DGFiP MAJIC',
    sourceFile: 'csv/proprietaire.csv',
    producer: 'DGFiP (Fichiers Fonciers MAJIC)',
    retrievalMode: 'parquet',
    coverage: 'Départements 69, 38, 44, 76 & 34',
    isFilter: false,
    isDisplay: true,
    isLandlord: true,
    desc: 'Identifiant cadastral fiscal anonymisé ou pivot attribué par la DGFiP à chaque propriétaire personne morale pour rattacher l\'ensemble de son patrimoine foncier.',
  },
  {
    id: 'nb_locaux_open_dans_batiment',
    category: 'landlords',
    label: 'Lots détenus par le propriétaire dans l\'immeuble',
    rawColumn: 'nb_locaux_open_dans_batiment',
    source: 'DGFiP MAJIC',
    sourceFile: 'csv/rel_batiment_groupe_proprietaire.csv',
    producer: 'DGFiP (Fichiers Fonciers MAJIC)',
    retrievalMode: 'parquet',
    coverage: 'Départements 69, 38, 44, 76 & 34',
    isFilter: false,
    isDisplay: true,
    isLandlord: true,
    desc: 'Nombre exact de logements, commerces ou locaux déclarés au cadastre MAJIC au nom de cette société ou SCI dans ce bâtiment spécifique.',
  },
  {
    id: 'dirigeants',
    category: 'landlords',
    label: 'Dirigeants, gérants et administrateurs d\'entreprises / SCI',
    rawColumn: 'dirigeants (API REST live)',
    source: 'DINUM / INPI / RNE',
    sourceFile: 'https://recherche-entreprises.api.gouv.fr/search?q={siren}',
    producer: 'DINUM / INPI (Registre National des Entreprises)',
    retrievalMode: 'api',
    coverage: 'France entière',
    isFilter: false,
    isDisplay: true,
    isLandlord: true,
    desc: 'Noms, prénoms, qualité (Gérant, Associé-Gérant, Président) et année de naissance des personnes physiques dirigeant la SCI ou la foncière, levés en temps réel au RNE lors du clic sur « Voir Dirigeants ».',
  },
  {
    id: 'siege_adresse',
    category: 'landlords',
    label: 'Adresse postale et commune du siège social de l\'entreprise',
    rawColumn: 'siege.adresse (API REST live)',
    source: 'INSEE (Répertoire Sirene)',
    sourceFile: 'https://recherche-entreprises.api.gouv.fr/search?q={siren}',
    producer: 'INSEE (Répertoire Sirene)',
    retrievalMode: 'api',
    coverage: 'France entière',
    isFilter: false,
    isDisplay: true,
    isLandlord: true,
    desc: 'Adresse officielle du siège social de la personne morale propriétaire déclarée au répertoire Sirene de l\'INSEE (permet de démasquer les holdings basées à Paris ou à l\'étranger).',
  },
  {
    id: 'libelle_activite_principale',
    category: 'landlords',
    label: 'Activité principale et code NAF de la société',
    rawColumn: 'libelle_activite_principale (API REST live)',
    source: 'INSEE (Répertoire Sirene)',
    sourceFile: 'https://recherche-entreprises.api.gouv.fr/search?q={siren}',
    producer: 'INSEE (Répertoire Sirene)',
    retrievalMode: 'api',
    coverage: 'France entière',
    isFilter: false,
    isDisplay: true,
    isLandlord: true,
    desc: 'Code et libellé officiel d\'activité économique (NAF / APE) de l\'entreprise propriétaire (ex: 68.20A Location de logements, 68.20B Location de terrains et autres biens...).',
  },
  {
    id: 'fieldwork_custom',
    category: 'geography',
    label: 'Colonnes personnalisées libres de votre tableur .xlsx terrain',
    rawColumn: 'Colonnes libres .xlsx (clé pivot batiment_groupe_id)',
    source: 'Tableur militant (.xlsx)',
    sourceFile: 'Fichier Excel (.xlsx) téléversé dans la barre latérale',
    producer: 'Tableur terrain de l\'utilisateur',
    retrievalMode: 'xlsx',
    coverage: 'Territoire de l\'enquête',
    isFilter: true,
    isDisplay: true,
    isLandlord: false,
    desc: 'Toutes les colonnes personnalisées de votre fichier Excel de suivi militant (notes, contacts locataires, dates d\'assemblée, litiges) fusionnées automatiquement grâce à l\'identifiant pivot batiment_groupe_id.',
  },
];

/* Canonical file → producer catalogue: a given file always sits under ONE producer family,
   whatever label the individual variables used for it. */
const FILE_CATALOG = {
  'batiment_groupe.csv': 'CSTB — BDNB (socle bâtiments)',
  'batiment_groupe_synthese_propriete_usage.csv': 'CSTB — BDNB (socle bâtiments)',
  'batiment_groupe_bdtopo_bat.csv': 'IGN — BD TOPO',
  'adresse.csv': 'BAN — Base Adresse Nationale',
  'batiment_groupe_adresse.csv': 'BAN — Base Adresse Nationale',
  'rel_batiment_groupe_adresse.csv': 'BAN — Base Adresse Nationale',
  'batiment_groupe_dpe_representatif_logement.csv': 'ADEME — DPE',
  'batiment_groupe_dpe_statistique_logement.csv': 'ADEME — DPE',
  'batiment_groupe_ffo_bat.csv': 'DGFiP — Fichiers Fonciers & MAJIC',
  'rel_batiment_groupe_proprietaire.csv': 'DGFiP — Fichiers Fonciers & MAJIC',
  'proprietaire.csv': 'DGFiP — Fichiers Fonciers & MAJIC',
  'batiment_groupe_dvf_open_statistique.csv': 'DGFiP — DVF (transactions)',
  'batiment_groupe_qpv.csv': 'ANCT — Politique de la Ville',
  'batiment_groupe_rnc.csv': 'ANAH — Registre des copropriétés',
  'batiment_groupe_rpls.csv': 'Ministère du Logement — RPLS',
  'batiment_groupe_risques.csv': 'BRGM / IRSN — Risques naturels',
  'batiment_groupe_urbanisme.csv': 'GPU — Urbanisme',
  'batiment_groupe_indicateur_reseau_chaud_froid.csv': 'Cerema — Réseaux de chaleur',
  'batiment_groupe_dle_elec_multimillesime.csv': 'Enedis / GRDF / SDES — Énergie',
  'batiment_groupe_dle_gaz_multimillesime.csv': 'Enedis / GRDF / SDES — Énergie',
  'ilots_chaleur_urbains.geojson': 'Métropole de Lyon — Data Grand Lyon',
  'encadrement_loyers.geojson': 'Préfecture / Observatoires des loyers',
  'Base_OP_2024_L3800.csv': 'Préfecture / Observatoires des loyers',
  'API recherche-entreprises (RNE / Sirene)': 'DINUM / INSEE — API Entreprises',
  'Score composite TeZeLoMa (calcul)': 'Collectif TeZeLoMa — calculs maison',
  'Tableur militant (.xlsx)': 'Collectif TeZeLoMa — calculs maison',
};

function normalizeSourceFiles(sourceFile) {
  const s = sourceFile || '';
  if (/recherche-entreprises/i.test(s) && !/\.csv/.test(s)) return ['API recherche-entreprises (RNE / Sirene)'];
  if (/Calcul composite|Score Composite/i.test(s)) return ['Score composite TeZeLoMa (calcul)'];
  if (/\.xlsx|Excel/i.test(s)) return ['Tableur militant (.xlsx)'];
  const files = [];
  const re = /([A-Za-z0-9_]+\.(?:csv|geojson|shp))/g;
  let m;
  while ((m = re.exec(s)) !== null) if (!files.includes(m[1])) files.push(m[1]);
  if (/recherche-entreprises/i.test(s)) files.push('API recherche-entreprises (RNE / Sirene)');
  return files.length ? files : [s];
}

let DATA_SOURCES_DICTIONARY = [];

function buildDataSourcesDictionary() {
  const dict = [];

  // 1. Convert all FILTER_DEFINITIONS
  for (const f of FILTER_DEFINITIONS) {
    const meta = SOURCE_METADATA_MAP[f.source] || {
      file: f.source,
      producer: f.source,
      mode: 'csv',
      coverage: 'France entière',
    };

    const rawCol = RAW_COLUMN_OVERRIDE[f.id] || f.column;
    const cat = SOCIOLOGICAL_CATEGORIES.find(c => c.id === f.category);
    const categoryLabel = cat ? cat.shortLabel : f.category;
    const categoryIcon = cat ? cat.icon : '📌';

    const isDisplay = [
      'dpe', 'classe_ges', 'conso_ep_m2', 'nb_log', 'nb_niveau', 'annee_construction',
      'score_surchauffe_ete', 'risque_surchauffe_ete', 'loyer_max_t2_nm', 'loyer_max_t2_non_meuble_m2',
      'quartier_qpv', 'nom_copro', 'type_energie_chauffage', 'type_vitrage', 'type_ventilation',
      'conso_elec_res_par_pdl_kwh', 'distance_reseau_chaleur', 'dvf_prix_m2_median', 'dvf_nb_mutations',
      'adr', 'cp', 'pct_dpe_fg', 'nb_dpe_fg',
    ].includes(f.id);

    const isLandlord = [
      'owner_search', 'legal_category', 'forme_juridique_principale', 'concentration_pct',
      'max_locaux_un_prop', 'min_patrimoine_majic', 'nb_proprietaires_open', 'bailleur_distant',
    ].includes(f.id);

    dict.push({
      id: f.id,
      label: f.label,
      category: f.category,
      categoryLabel: categoryLabel,
      categoryIcon: categoryIcon,
      rawColumn: rawCol,
      desc: f.desc,
      source: f.source,
      sourceFile: meta.file,
      producer: meta.producer,
      retrievalMode: meta.mode,
      coverage: meta.coverage,
      isFilter: true,
      isDisplay: isDisplay,
      isLandlord: isLandlord,
    });
  }

  // 2. Add extra displayable variables
  for (const extra of EXTRA_DISPLAYABLE_VARIABLES) {
    const cat = SOCIOLOGICAL_CATEGORIES.find(c => c.id === extra.category);
    dict.push({
      id: extra.id,
      label: extra.label,
      category: extra.category,
      categoryLabel: cat ? cat.shortLabel : extra.category,
      categoryIcon: cat ? cat.icon : '📌',
      rawColumn: extra.rawColumn,
      desc: extra.desc,
      source: extra.source,
      sourceFile: extra.sourceFile,
      producer: extra.producer,
      retrievalMode: extra.retrievalMode,
      coverage: extra.coverage,
      isFilter: extra.isFilter,
      isDisplay: extra.isDisplay,
      isLandlord: extra.isLandlord,
    });
  }

  // 3. Harmonise producer by source file (same file => same producer family)
  for (const it of dict) {
    it.producerRaw = it.producer;
    it.files = normalizeSourceFiles(it.sourceFile);
    const fam = FILE_CATALOG[it.files[0]];
    if (fam) it.producer = fam;
  }

  DATA_SOURCES_DICTIONARY = dict;
  return DATA_SOURCES_DICTIONARY;
}

const sourcesState = {
  subview: 'info', // 'info' | 'dataset'
  searchQuery: '',
  categoryFilter: 'all',
  producerFilter: 'all',
  usageFilter: 'all',
  sortCol: 'label',
  sortDir: 'asc',
  pinnedRowId: null,
};

const SOURCES_TABLE_COLUMNS = [
  {
    key: 'label',
    label: 'Information / Libellé',
    sortValue: (item) => (item.label || '').toLowerCase(),
  },
  {
    key: 'rawColumn',
    label: 'Colonne brute d\'origine',
    sortValue: (item) => (item.rawColumn || '').toLowerCase(),
  },
  {
    key: 'desc',
    label: 'Description & Contexte légal',
    sortValue: (item) => (item.desc || '').toLowerCase(),
  },
  {
    key: 'sourceFile',
    label: 'Fichier / API Source',
    sortValue: (item) => (item.sourceFile || '').toLowerCase(),
  },
  {
    key: 'producer',
    label: 'Producteur officiel',
    sortValue: (item) => (item.producer || '').toLowerCase(),
  },
  {
    key: 'category',
    label: 'Thématique',
    sortValue: (item) => (item.categoryLabel || '').toLowerCase(),
  },
];

function getFilteredSourcesList() {
  if (DATA_SOURCES_DICTIONARY.length === 0) {
    buildDataSourcesDictionary();
  }

  const q = (sourcesState.searchQuery || '').trim().toLowerCase();
  const cat = sourcesState.categoryFilter;
  const prod = sourcesState.producerFilter;
  const usage = sourcesState.usageFilter;

  let list = DATA_SOURCES_DICTIONARY.filter(item => {
    // 1. Category Filter
    if (cat !== 'all' && item.category !== cat) {
      return false;
    }

    // 2. Producer Filter
    if (prod !== 'all') {
      if (prod.startsWith('prod::')) {
        const fam = prod.slice(6);
        if (!(item.files || []).some(f => FILE_CATALOG[f] === fam) && item.producer !== fam) return false;
      } else if (!(item.files || []).includes(prod)) {
        return false;
      }
    }

    // 3. Usage Filter
    if (usage === 'filter' && !item.isFilter) return false;
    if (usage === 'display' && !item.isDisplay) return false;
    if (usage === 'landlord' && !item.isLandlord) return false;
    if (usage === 'rhone' && !item.coverage.includes('69') && !item.coverage.includes('Lyon')) return false;
    if (usage === 'isere' && !item.coverage.includes('38') && !item.coverage.includes('Grenoble')) return false;
    if (usage === 'ouest' && !/44|76|34|Nantes|Rouen|Montpellier/.test(item.coverage)) return false;
    if (usage === 'national' && !item.coverage.includes('France')) return false;

    // 4. Text Search Query
    if (q) {
      const match =
        (item.label && item.label.toLowerCase().includes(q)) ||
        (item.rawColumn && item.rawColumn.toLowerCase().includes(q)) ||
        (item.desc && item.desc.toLowerCase().includes(q)) ||
        (item.sourceFile && item.sourceFile.toLowerCase().includes(q)) ||
        (item.producer && item.producer.toLowerCase().includes(q)) ||
        (item.categoryLabel && item.categoryLabel.toLowerCase().includes(q)) ||
        (item.coverage && item.coverage.toLowerCase().includes(q));
      if (!match) return false;
    }

    return true;
  });

  // Sort
  if (sourcesState.sortCol) {
    const colDef = SOURCES_TABLE_COLUMNS.find(c => c.key === sourcesState.sortCol);
    if (colDef) {
      list.sort((a, b) => {
        const vA = colDef.sortValue(a);
        const vB = colDef.sortValue(b);
        const cmp = vA.localeCompare(vB, 'fr', { numeric: true, sensitivity: 'base' });
        return sourcesState.sortDir === 'desc' ? -cmp : cmp;
      });
    }
  }

  return list;
}

function switchSourcesSubview(subview) {
  sourcesState.subview = subview;

  const btnInfo = document.getElementById('btn-sources-subview-info');
  const btnDataset = document.getElementById('btn-sources-subview-dataset');
  const panelInfo = document.getElementById('sources-subview-info');
  const panelDataset = document.getElementById('sources-subview-dataset');

  if (btnInfo) btnInfo.classList.toggle('active', subview === 'info');
  if (btnDataset) btnDataset.classList.toggle('active', subview === 'dataset');

  if (panelInfo) panelInfo.style.display = subview === 'info' ? 'block' : 'none';
  if (panelDataset) panelDataset.style.display = subview === 'dataset' ? 'block' : 'none';

  if (subview === 'info') {
    renderSourcesDictTable();
  }
}

function renderSourcesDictHeaders() {
  const tr = document.getElementById('sources-dict-thead-tr');
  if (!tr) return;
  tr.innerHTML = '';

  for (const col of SOURCES_TABLE_COLUMNS) {
    const th = document.createElement('th');
    th.className = 'sortable';

    const isActive = sourcesState.sortCol === col.key;
    if (isActive) {
      th.classList.add('sorted-active');
    }

    const sortSymbol = isActive
      ? (sourcesState.sortDir === 'asc' ? ' ▲' : ' ▼')
      : ' <span style="opacity:0.35;">⇅</span>';

    th.innerHTML = `${escapeHtml(col.label)} <span class="sort-indicator">${sortSymbol}</span>`;

    th.addEventListener('click', () => {
      if (sourcesState.sortCol === col.key) {
        sourcesState.sortDir = sourcesState.sortDir === 'asc' ? 'desc' : 'asc';
      } else {
        sourcesState.sortCol = col.key;
        sourcesState.sortDir = 'asc';
      }
      renderSourcesDictTable();
    });

    tr.appendChild(th);
  }
}

function renderSourcesDictTable() {
  const tbody = document.getElementById('table-sources-dict-body');
  if (!tbody) return;

  renderSourcesDictHeaders();

  const filtered = getFilteredSourcesList();

  // Update dynamic count feedback
  const feedbackEl = document.getElementById('sources-filter-feedback');
  if (feedbackEl) {
    feedbackEl.innerHTML = `Affichage de <strong>${filtered.length}</strong> sur <strong>${DATA_SOURCES_DICTIONARY.length}</strong> information(s) et colonnes sources`;
  }

  // Update count pill in subnav
  const pillEl = document.getElementById('sources-count-pill');
  if (pillEl) {
    if (filtered.length === DATA_SOURCES_DICTIONARY.length) {
      pillEl.textContent = `${DATA_SOURCES_DICTIONARY.length} variables & colonnes sources répertoriées`;
    } else {
      pillEl.textContent = `${filtered.length} / ${DATA_SOURCES_DICTIONARY.length} variables affichées`;
    }
  }

  if (filtered.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="6">
          <div class="sources-empty-state">
            <div class="sources-empty-icon">🔍</div>
            <div class="sources-empty-title">Aucune information trouvée</div>
            <p>Aucun indicateur ni colonne brute ne correspond à vos filtres actuels.</p>
            <button type="button" class="btn btn-secondary btn-sm" id="btn-sources-empty-reset" style="margin-top:0.6rem;">
              🔄 Réinitialiser tous les filtres
            </button>
          </div>
        </td>
      </tr>
    `;
    document.getElementById('btn-sources-empty-reset')?.addEventListener('click', resetSourcesFilters);
    return;
  }

  tbody.innerHTML = '';
  const fragment = document.createDocumentFragment();

  for (const item of filtered) {
    const tr = document.createElement('tr');
    tr.setAttribute('data-id', item.id);

    // 1. Information / Libellé
    const tdInfo = document.createElement('td');
    tdInfo.className = 'sources-info-cell';

    let usagePillsHtml = '';
    if (item.isFilter) {
      usagePillsHtml += `<span class="badge-usage-filter" title="Indicateur filtrable dans le catalogue dynamique">🎛️ Filtre</span> `;
    }
    if (item.isDisplay) {
      usagePillsHtml += `<span class="badge-usage-display" title="Affiché dans la table ou la fiche détaillée de l'immeuble">👁️ Affiché</span> `;
    }
    if (item.isLandlord) {
      usagePillsHtml += `<span class="badge-usage-landlord" title="Affiché dans l'onglet Bailleurs & SCI">🏛️ Bailleur</span> `;
    }

    tdInfo.innerHTML = `
      <div class="sources-info-name">
        <span>${item.categoryIcon}</span>
        <span>${escapeHtml(item.label)}</span>
      </div>
      <div class="sources-info-badges">
        ${usagePillsHtml}
      </div>
    `;

    // 2. Colonne brute d'origine
    const tdCol = document.createElement('td');
    tdCol.innerHTML = `
      <div class="sources-col-box" data-col="${escapeHtml(item.rawColumn)}" title="Cliquer pour copier le nom de la colonne brute">
        <code>${escapeHtml(item.rawColumn)}</code>
        <span class="btn-copy-col">📋</span>
      </div>
    `;

    // 3. Description (preview and hover if big)
    const tdDesc = document.createElement('td');
    const isLongDesc = item.desc && item.desc.length > 75;
    const isPinned = sourcesState.pinnedRowId === item.id;

    tdDesc.innerHTML = `
      <div class="sources-desc-cell${isPinned ? ' pinned' : ''}" data-id="${item.id}" title="Cliquer pour épingler/fermer l'explication complète">
        <div class="sources-desc-preview">
          ${escapeHtml(item.desc)}
        </div>
        ${isLongDesc ? `<span class="sources-desc-more-hint">🔍 Survoler / Cliquer pour lire la suite</span>` : ''}
        <div class="sources-desc-popover">
          <div class="sources-desc-popover-title">
            <span>${item.categoryIcon}</span>
            <span>${escapeHtml(item.label)}</span>
          </div>
          <div class="sources-desc-popover-body">
            ${escapeHtml(item.desc)}
          </div>
          <div class="sources-desc-popover-law">
            <b>Colonne :</b> <code>${escapeHtml(item.rawColumn)}</code> • <b>Source :</b> ${escapeHtml(item.sourceFile)} (${escapeHtml(item.producer)})
          </div>
        </div>
      </div>
    `;

    // 4. Fichier / API Source
    const tdFile = document.createElement('td');
    tdFile.className = 'sources-file-cell';
    const tagClass = `tz-tag-${item.retrievalMode || 'csv'}`;
    const modeLabel = {
      csv: '📦 CSV Open Data',
      parquet: '🗄️ GeoParquet',
      wfs: '🗺️ WFS Spatial',
      api: '⚡ API REST Live',
      xlsx: '📋 Tableur .xlsx',
      etl: '⚙️ Build ETL',
    }[item.retrievalMode] || '📦 Fichier';

    tdFile.innerHTML = `
      <div class="sources-file-name" title="${escapeHtml(item.sourceFile)}">${escapeHtml(item.sourceFile)}</div>
      <div class="sources-file-meta">
        <span class="tz-tag ${tagClass}" style="font-size:0.68rem; padding: 1px 6px;">${modeLabel}</span>
        <span class="badge-coverage">${escapeHtml(item.coverage)}</span>
      </div>
    `;

    // 5. Producteur officiel
    const tdProd = document.createElement('td');
    tdProd.className = 'sources-producer-cell';
    tdProd.innerHTML = `
      <span class="badge-producer">🏛️ ${escapeHtml(item.producer)}</span>
    `;

    // 6. Catégorie / Thématique
    const tdCat = document.createElement('td');
    tdCat.innerHTML = `
      <span class="badge-category badge-cat-${item.category}">
        <span>${item.categoryIcon}</span>
        <span>${escapeHtml(item.categoryLabel)}</span>
      </span>
    `;

    tr.appendChild(tdInfo);
    tr.appendChild(tdCol);
    tr.appendChild(tdDesc);
    tr.appendChild(tdFile);
    tr.appendChild(tdProd);
    tr.appendChild(tdCat);

    fragment.appendChild(tr);
  }

  tbody.appendChild(fragment);

  // Attach interactive click-to-copy handlers on column boxes
  tbody.querySelectorAll('.sources-col-box').forEach(box => {
    box.addEventListener('click', (e) => {
      e.stopPropagation();
      const colText = box.getAttribute('data-col');
      if (colText && navigator.clipboard) {
        navigator.clipboard.writeText(colText).then(() => {
          const originalHtml = box.innerHTML;
          box.innerHTML = `<code>${escapeHtml(colText)}</code> <span style="color:#059669; font-weight:700;">✓ Copié !</span>`;
          setTimeout(() => {
            box.innerHTML = originalHtml;
          }, 1400);
        }).catch(err => {
          console.warn('Clipboard write failed:', err);
        });
      }
    });
  });

  // Attach click-to-pin handlers on description cells
  tbody.querySelectorAll('.sources-desc-cell').forEach(cell => {
    cell.addEventListener('click', (e) => {
      e.stopPropagation();
      const cellId = cell.getAttribute('data-id');
      if (sourcesState.pinnedRowId === cellId) {
        sourcesState.pinnedRowId = null;
        cell.classList.remove('pinned');
      } else {
        tbody.querySelectorAll('.sources-desc-cell.pinned').forEach(c => c.classList.remove('pinned'));
        sourcesState.pinnedRowId = cellId;
        cell.classList.add('pinned');
      }
    });
  });
}

function resetSourcesFilters() {
  sourcesState.searchQuery = '';
  sourcesState.categoryFilter = 'all';
  sourcesState.producerFilter = 'all';
  sourcesState.usageFilter = 'all';

  const inputSearch = document.getElementById('sources-search-input');
  if (inputSearch) inputSearch.value = '';

  const btnClear = document.getElementById('btn-sources-clear-search');
  if (btnClear) btnClear.style.display = 'none';

  const selectCat = document.getElementById('sources-filter-category');
  if (selectCat) selectCat.value = 'all';

  const selectProd = document.getElementById('sources-filter-producer');
  if (selectProd) selectProd.value = 'all';

  const selectUsage = document.getElementById('sources-filter-usage');
  if (selectUsage) selectUsage.value = 'all';

  renderSourcesDictTable();
}

function exportSourcesDictionaryCSV() {
  const visibleItems = getFilteredSourcesList();
  if (visibleItems.length === 0) {
    alert('Aucune information à exporter avec les filtres actuels.');
    return;
  }

  const headers = [
    'Information',
    'Thematique',
    'Colonne_Brute_Origine',
    'Description',
    'Fichier_ou_API_Source',
    'Producteur_Officiel',
    'Mode_Recuperation',
    'Couverture_Territoriale',
    'Filtrable_Catalogue',
    'Affiche_Detail',
  ];

  const rows = visibleItems.map(i => [
    `"${(i.label || '').replace(/"/g, '""')}"`,
    `"${(i.categoryLabel || '').replace(/"/g, '""')}"`,
    `"${(i.rawColumn || '').replace(/"/g, '""')}"`,
    `"${(i.desc || '').replace(/"/g, '""')}"`,
    `"${(i.sourceFile || '').replace(/"/g, '""')}"`,
    `"${(i.producer || '').replace(/"/g, '""')}"`,
    `"${(i.retrievalMode || '').replace(/"/g, '""')}"`,
    `"${(i.coverage || '').replace(/"/g, '""')}"`,
    i.isFilter ? 'Oui' : 'Non',
    i.isDisplay ? 'Oui' : 'Non',
  ]);

  const csvContent = '\uFEFF' + [headers.join(','), ...rows.map(r => r.join(','))].join('\r\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const dateStr = new Date().toISOString().slice(0, 10);
  a.download = `tezeloma_dictionnaire_sources_${dateStr}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function navigateToSourceInfo(query) {
  switchTab('sources');
  switchSourcesSubview('info');

  sourcesState.searchQuery = query || '';
  sourcesState.categoryFilter = 'all';
  sourcesState.producerFilter = 'all';
  sourcesState.usageFilter = 'all';

  const inputSearch = document.getElementById('sources-search-input');
  if (inputSearch) inputSearch.value = query || '';

  const btnClear = document.getElementById('btn-sources-clear-search');
  if (btnClear) btnClear.style.display = query ? 'block' : 'none';

  const selectCat = document.getElementById('sources-filter-category');
  if (selectCat) selectCat.value = 'all';

  const selectProd = document.getElementById('sources-filter-producer');
  if (selectProd) selectProd.value = 'all';

  const selectUsage = document.getElementById('sources-filter-usage');
  if (selectUsage) selectUsage.value = 'all';

  renderSourcesDictTable();

  // Highlight matching row if present
  setTimeout(() => {
    const matchingRow = document.querySelector(`#table-sources-dict-body tr[data-id="${query}"]`);
    if (matchingRow) {
      matchingRow.scrollIntoView({ behavior: 'smooth', block: 'center' });
      matchingRow.classList.add('highlight-row');
      setTimeout(() => matchingRow.classList.remove('highlight-row'), 2500);
    }
  }, 100);
}

window.navigateToSourceInfo = navigateToSourceInfo;

function initSourcesTabControls() {
  buildDataSourcesDictionary();

  // Subview toggle buttons
  document.getElementById('btn-sources-subview-info')?.addEventListener('click', () => {
    switchSourcesSubview('info');
  });

  document.getElementById('btn-sources-subview-dataset')?.addEventListener('click', () => {
    switchSourcesSubview('dataset');
  });

  // Populate Producer select filter
  const selectProd = document.getElementById('sources-filter-producer');
  if (selectProd) {
    // Group by producer family (optgroup), then one option per source file
    const fileCounts = {};
    for (const it of DATA_SOURCES_DICTIONARY) {
      for (const f of (it.files || [])) fileCounts[f] = (fileCounts[f] || 0) + 1;
    }
    const fams = {};
    for (const f of Object.keys(fileCounts)) {
      const fam = FILE_CATALOG[f] || 'Autres sources';
      (fams[fam] = fams[fam] || []).push(f);
    }
    selectProd.innerHTML = '<option value="all">Tous les producteurs & fichiers</option>';
    for (const fam of Object.keys(fams).sort((x, y) => x.localeCompare(y, 'fr'))) {
      const grp = document.createElement('optgroup');
      grp.label = fam;
      const total = fams[fam].length > 1 ? document.createElement('option') : null;
      if (total) {
        total.value = 'prod::' + fam;
        total.textContent = `Tous les fichiers — ${fam}`;
        grp.appendChild(total);
      }
      for (const f of fams[fam].sort()) {
        const opt = document.createElement('option');
        opt.value = f;
        opt.textContent = `${total ? '↳ ' : ''}${f} (${fileCounts[f]})`;
        grp.appendChild(opt);
      }
      selectProd.appendChild(grp);
    }
    selectProd.addEventListener('change', () => {
      sourcesState.producerFilter = selectProd.value;
      renderSourcesDictTable();
    });
  }

  // Category select filter
  const selectCat = document.getElementById('sources-filter-category');
  if (selectCat) {
    selectCat.addEventListener('change', () => {
      sourcesState.categoryFilter = selectCat.value;
      renderSourcesDictTable();
    });
  }

  // Usage select filter
  const selectUsage = document.getElementById('sources-filter-usage');
  if (selectUsage) {
    selectUsage.addEventListener('change', () => {
      sourcesState.usageFilter = selectUsage.value;
      renderSourcesDictTable();
    });
  }

  // Search input with instant filtering
  const inputSearch = document.getElementById('sources-search-input');
  const btnClear = document.getElementById('btn-sources-clear-search');
  if (inputSearch) {
    inputSearch.addEventListener('input', () => {
      sourcesState.searchQuery = inputSearch.value;
      if (btnClear) {
        btnClear.style.display = inputSearch.value ? 'block' : 'none';
      }
      renderSourcesDictTable();
    });
  }

  if (btnClear && inputSearch) {
    btnClear.addEventListener('click', () => {
      inputSearch.value = '';
      sourcesState.searchQuery = '';
      btnClear.style.display = 'none';
      inputSearch.focus();
      renderSourcesDictTable();
    });
  }

  // Reset filters button
  document.getElementById('btn-sources-reset-filters')?.addEventListener('click', resetSourcesFilters);

  // Export CSV button
  document.getElementById('btn-sources-export-csv')?.addEventListener('click', exportSourcesDictionaryCSV);

  // Building drawer goto sources button
  document.getElementById('btn-drawer-goto-sources')?.addEventListener('click', () => {
    switchTab('sources');
    switchSourcesSubview('info');
  });

  // Close pinned popovers on click outside
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.sources-desc-cell')) {
      sourcesState.pinnedRowId = null;
      document.querySelectorAll('.sources-desc-cell.pinned').forEach(c => c.classList.remove('pinned'));
    }
  });

  // Initial render
  renderSourcesDictTable();
}

function renderSourcesTab() {
  if (DATA_SOURCES_DICTIONARY.length === 0) {
    buildDataSourcesDictionary();
  }
  if (sourcesState.subview === 'info') {
    renderSourcesDictTable();
  }
}

/* ==========================================================================
   Address Geocoding Search (BAN API + Local Loaded Buildings + Low Ambiguity + Pin)
   ========================================================================== */
const GENERIC_ADDR_TOKENS = new Set([
  'rue', 'r', 'avenue', 'av', 'boulevard', 'bd', 'bvd', 'place', 'pl',
  'chemin', 'ch', 'impasse', 'imp', 'allee', 'all', 'cours', 'crs',
  'quai', 'route', 'rte', 'passage', 'pass', 'square', 'sq', 'montee',
  'qu', 'faubourg', 'fg', 'voie', 'cite', 'residence', 'res', 'lotissement',
  'de', 'du', 'des', 'la', 'le', 'les', 'l', 'd', 'au', 'aux', 'en', 'sur', 'sous',
  'bis', 'ter', 'quater'
]);

const INCOMPLETE_TRAILING_TOKENS = new Set([
  ...GENERIC_ADDR_TOKENS,
  'saint', 'sainte', 'st', 'ste', 'general', 'gal', 'docteur', 'dr',
  'professeur', 'pr', 'president', 'marechal', 'amiral', 'colonel', 'commandant',
  'paul', 'jean', 'pierre', 'louis', 'charles', 'henri', 'jules', 'victor',
  'claude', 'francois', 'georges', 'marie', 'joseph', 'camille', 'andre',
  'marcel', 'edouard', 'etienne', 'antoine', 'gabriel', 'leon', 'albert',
  'emile', 'felix', 'gustave', 'maurice', 'rene', 'robert', 'roger'
]);

function normalizeAddrText(str) {
  return String(str || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function addSearchedAddressPin({ lon, lat, label, context, batiment_groupe_id = null }) {
  if (!state.map || typeof lon !== 'number' || typeof lat !== 'number' || Number.isNaN(lon) || Number.isNaN(lat)) {
    return null;
  }

  if (!Array.isArray(state.searchedAddressMarkers)) {
    state.searchedAddressMarkers = [];
  }

  // If a pin already exists at virtually the same location (~30m), update it in place
  const existingIdx = state.searchedAddressMarkers.findIndex(
    m => Math.hypot(m.lon - lon, m.lat - lat) < 0.00035
  );
  if (existingIdx !== -1) {
    const existing = state.searchedAddressMarkers[existingIdx];
    existing.lon = lon;
    existing.lat = lat;
    existing.label = label || existing.label;
    existing.context = context || existing.context;
    if (batiment_groupe_id) existing.batiment_groupe_id = batiment_groupe_id;
    existing.marker.setLngLat([lon, lat]);
    const textEl = existing.element?.querySelector('.address-pin-badge-text');
    if (textEl) textEl.textContent = existing.label;
    return existing;
  }

  const pinId = `pin_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const shortLabel = String(label || 'Adresse recherchée');

  const pinEl = document.createElement('div');
  pinEl.className = 'address-search-pin';
  pinEl.dataset.pinId = pinId;
  pinEl.title = context ? `${shortLabel} — ${context}` : shortLabel;

  pinEl.innerHTML = `
    <div class="address-pin-badge">
      <span class="address-pin-badge-text">📍 ${escapeHtml(shortLabel)}</span>
      <button type="button" class="address-pin-remove" title="Retirer ce repère" aria-label="Retirer ce repère">&times;</button>
    </div>
    <div class="address-pin-icon-wrap">
      <div class="address-pin-pulse"></div>
      <svg class="address-pin-svg" viewBox="0 0 32 38" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M16 36C16 36 29 23.4 29 14C29 6.8203 23.1797 1 16 1C8.8203 1 3 6.8203 3 14C3 23.4 16 36 16 36Z" fill="#2563eb" stroke="#ffffff" stroke-width="2.5"/>
        <circle cx="16" cy="14" r="5.5" fill="#ffffff"/>
      </svg>
    </div>
  `;

  const marker = new maplibregl.Marker({ element: pinEl, anchor: 'bottom' })
    .setLngLat([lon, lat])
    .addTo(state.map);

  const pinRecord = {
    id: pinId,
    lon,
    lat,
    label: shortLabel,
    context: context || '',
    batiment_groupe_id,
    marker,
    element: pinEl,
  };

  pinEl.querySelector('.address-pin-remove')?.addEventListener('click', (e) => {
    e.stopPropagation();
    removeSearchedAddressPin(pinId);
  });

  pinEl.addEventListener('click', (e) => {
    if (e.target.closest('.address-pin-remove')) return;
    e.stopPropagation();
    state.map.flyTo({ center: [pinRecord.lon, pinRecord.lat], zoom: 17.5, essential: true });
    if (pinRecord.batiment_groupe_id) {
      inspectBuilding(pinRecord.batiment_groupe_id);
    }
  });

  state.searchedAddressMarkers.push(pinRecord);
  return pinRecord;
}

function removeSearchedAddressPin(pinId) {
  if (!Array.isArray(state.searchedAddressMarkers)) return;
  const idx = state.searchedAddressMarkers.findIndex(m => m.id === pinId);
  if (idx !== -1) {
    try {
      state.searchedAddressMarkers[idx].marker.remove();
    } catch (_) {}
    state.searchedAddressMarkers.splice(idx, 1);
  }
}

function clearSearchedAddressPins() {
  if (!Array.isArray(state.searchedAddressMarkers)) return;
  for (const m of state.searchedAddressMarkers) {
    try {
      m.marker.remove();
    } catch (_) {}
  }
  state.searchedAddressMarkers = [];
}

function getActivePostalCodesSet() {
  const cps = new Set();
  if (state.buildings && state.buildings.length > 0) {
    for (let i = 0; i < state.buildings.length; i++) {
      if (state.buildings[i].cp) cps.add(Number(state.buildings[i].cp));
    }
  }
  if (state.pendingSelectedChunks && state.manifest?.chunks) {
    for (const c of state.manifest.chunks) {
      if (state.pendingSelectedChunks.has(c.id)) cps.add(Number(c.cp));
    }
  }
  return cps;
}

function tokenMatchesCandidateWord(qTok, cTok) {
  if (qTok === cTok) return true;
  if (/^\d+$/.test(qTok) || /^\d+$/.test(cTok)) {
    return qTok === cTok;
  }
  if (qTok.length >= 5 && cTok.startsWith(qTok) && (qTok.length / cTok.length) >= 0.65) {
    return true;
  }
  return false;
}

function searchLocalBuildingAddresses(query) {
  if (!state.buildings || state.buildings.length === 0) return [];
  const qNorm = normalizeAddrText(query);
  const qTokens = qNorm.split(' ').filter(Boolean);
  if (qTokens.length === 0) return [];

  const matchesByAddrKey = new Map();

  for (let i = 0; i < state.buildings.length; i++) {
    const b = state.buildings[i];
    if (!b.adr) continue;
    const rawAddresses = String(b.adr).split(/\s*\|\s*|\s*;\s*/);
    const cpStr = String(b.cp || '');
    const communeStr = String(b.libelle_commune_insee || '');

    for (const singleAdr of rawAddresses) {
      const fullNorm = normalizeAddrText(`${singleAdr} ${cpStr} ${communeStr}`);
      const fullWords = fullNorm.split(' ').filter(Boolean);

      // Every query token must match a word in fullWords (exact for numbers, word/prefix for text)
      const allMatched = qTokens.every((qTok, idx) => {
        const isLast = idx === qTokens.length - 1;
        return fullWords.some(w => {
          if (/^\d+$/.test(qTok)) return w === qTok;
          if (w === qTok) return true;
          if (isLast && qTok.length >= 3 && w.startsWith(qTok)) return true;
          if (qTok.length >= 5 && w.startsWith(qTok)) return true;
          return false;
        });
      });

      if (!allMatched) continue;

      const cleanStreet = singleAdr.trim().replace(/\s+\d{5}$/, '').trim();
      const adrNorm = normalizeAddrText(cleanStreet);
      const key = `${adrNorm}|${cpStr}`;
      if (!matchesByAddrKey.has(key)) {
        const coords = getGeometryCenter(b.geometry);
        if (!coords) continue;
        matchesByAddrKey.set(key, {
          label: `${cleanStreet}${cpStr ? `, ${cpStr}` : ''}${communeStr ? ` ${communeStr}` : ''}`,
          streetName: cleanStreet,
          postcode: cpStr,
          city: communeStr,
          context: `${cpStr} ${communeStr}`.trim(),
          lon: coords[0],
          lat: coords[1],
          score: 0.95,
          inActiveTerritory: true,
          source: 'local',
          batiment_groupe_id: b.batiment_groupe_id,
        });
        if (matchesByAddrKey.size >= 15) break;
      }
    }
    if (matchesByAddrKey.size >= 15) break;
  }

  return Array.from(matchesByAddrKey.values());
}

async function fetchAddressCandidates(query, abortSignal, timeoutMs = 1200) {
  const localCandidates = searchLocalBuildingAddresses(query);
  const activeCps = getActivePostalCodesSet();
  const banCandidates = [];

  if (navigator.onLine) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    if (abortSignal) {
      if (abortSignal.aborted) {
        clearTimeout(timer);
        controller.abort();
      } else {
        abortSignal.addEventListener('abort', () => {
          clearTimeout(timer);
          controller.abort();
        }, { once: true });
      }
    }

    try {
      const res = await fetch(
        `https://api-adresse.data.gouv.fr/search/?q=${encodeURIComponent(query)}&limit=8`,
        { signal: controller.signal }
      );
      if (res.ok) {
        const data = await res.json();
        for (const feat of data.features || []) {
          const props = feat.properties || {};
          const [lon, lat] = feat.geometry?.coordinates || [];
          if (typeof lon !== 'number' || typeof lat !== 'number') continue;
          const cpNum = parseInt(props.postcode, 10);
          const inActive = activeCps.has(cpNum);
          const streetName = (props.name || props.label || '').replace(/\s+\d{5}.*$/, '').trim();

          // Link to local building if one matches this streetName + postcode
          let matchedBuildingId = null;
          const normStreet = normalizeAddrText(streetName);
          const localMatch = localCandidates.find(
            lc => normalizeAddrText(lc.streetName) === normStreet && String(lc.postcode) === String(props.postcode || '')
          );
          if (localMatch) {
            matchedBuildingId = localMatch.batiment_groupe_id;
          }

          banCandidates.push({
            label: props.label || `${streetName} ${props.postcode || ''} ${props.city || ''}`.trim(),
            streetName,
            postcode: props.postcode || '',
            city: props.city || '',
            context: `${props.postcode || ''} ${props.city || ''}`.trim(),
            lon,
            lat,
            score: Number(props.score || 0),
            inActiveTerritory: inActive,
            source: matchedBuildingId ? 'local' : 'ban',
            batiment_groupe_id: matchedBuildingId,
          });
        }
      }
    } catch (err) {
      if (err?.name !== 'AbortError') {
        console.warn('Geocoding error:', err);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  // Merge & deduplicate (preferring active territory matches first)
  const merged = [];
  const seenKeys = new Set();

  for (const c of [...localCandidates, ...banCandidates]) {
    const key = `${normalizeAddrText(c.streetName)}|${c.postcode}`;
    if (!seenKeys.has(key)) {
      seenKeys.add(key);
      merged.push(c);
    }
  }

  merged.sort((a, b) => {
    if (a.inActiveTerritory !== b.inActiveTerritory) {
      return a.inActiveTerritory ? -1 : 1;
    }
    return (b.score || 0) - (a.score || 0);
  });

  return merged;
}

function evaluateAddressAmbiguity(query, candidates) {
  const trimmed = String(query || '').trim();
  if (trimmed.length < 6) {
    return { lowAmbiguity: false, reason: 'too_short' };
  }

  const qNorm = normalizeAddrText(trimmed);
  const qTokens = qNorm.split(' ').filter(Boolean);
  if (qTokens.length < 2) {
    return { lowAmbiguity: false, reason: 'single_token' };
  }

  // Check if the user is still typing a trailing connector, generic word, or common first name
  const lastToken = qTokens[qTokens.length - 1];
  const isLastNumeric = /^\d+$/.test(lastToken);
  if (!isLastNumeric && (lastToken.length < 3 || INCOMPLETE_TRAILING_TOKENS.has(lastToken))) {
    return { lowAmbiguity: false, reason: 'incomplete_trailing_token' };
  }

  // Require at least one distinctive non-generic, non-numeric token of length >= 3
  const distinctiveTokens = qTokens.filter(
    t => !/^\d+$/.test(t) && !GENERIC_ADDR_TOKENS.has(t) && t.length >= 3
  );
  if (distinctiveTokens.length === 0) {
    return { lowAmbiguity: false, reason: 'no_distinctive_token' };
  }
  if (distinctiveTokens.length === 1 && INCOMPLETE_TRAILING_TOKENS.has(distinctiveTokens[0])) {
    return { lowAmbiguity: false, reason: 'only_common_prefix' };
  }

  if (!candidates || candidates.length === 0) {
    return { lowAmbiguity: false, reason: 'no_candidates' };
  }

  // Filter candidates where:
  // 1) All query tokens match the candidate's full label
  // 2) All significant street-name words of the candidate are covered by the query tokens
  const wellMatched = candidates.filter((cand) => {
    const candFullWords = normalizeAddrText(`${cand.streetName} ${cand.postcode} ${cand.city}`)
      .split(' ')
      .filter(Boolean);
    const candStreetWords = normalizeAddrText(cand.streetName)
      .split(' ')
      .filter(w => w && !/^\d+$/.test(w) && !GENERIC_ADDR_TOKENS.has(w) && w.length >= 3);

    if (candStreetWords.length === 0) return false;

    const allQueryTokensMatch = qTokens.every(qTok =>
      candFullWords.some(cWord => tokenMatchesCandidateWord(qTok, cWord))
    );
    if (!allQueryTokensMatch) return false;

    const allStreetWordsCovered = candStreetWords.every(sWord =>
      qTokens.some(qTok => tokenMatchesCandidateWord(qTok, sWord))
    );
    return allStreetWordsCovered;
  });

  if (wellMatched.length === 0) {
    return { lowAmbiguity: false, reason: 'no_complete_street_match' };
  }

  // Prefer matches within the active/loaded territory if any exist
  const activePool = wellMatched.filter(c => c.inActiveTerritory);
  const pool = activePool.length > 0 ? activePool : wellMatched;

  const primary = pool[0];
  const primaryStreetNorm = normalizeAddrText(primary.streetName);

  // Check if all candidates in pool point to the same street & approximate location (~400m)
  const allSamePlace = pool.every(
    c =>
      normalizeAddrText(c.streetName) === primaryStreetNorm &&
      Math.hypot(c.lon - primary.lon, c.lat - primary.lat) < 0.004
  );

  if (allSamePlace) {
    return { lowAmbiguity: true, bestCandidate: primary };
  }

  // If multiple cities/locations match in pool, check if user explicitly specified the city or postcode of primary
  const primaryCityWords = normalizeAddrText(primary.city)
    .split(' ')
    .filter(w => w.length >= 3 && !GENERIC_ADDR_TOKENS.has(w) && w !== 'arrondissement');
  const hasExplicitCityOrCp =
    (primary.postcode && qTokens.includes(normalizeAddrText(primary.postcode))) ||
    (primaryCityWords.length > 0 && primaryCityWords.some(cw => qTokens.some(qt => tokenMatchesCandidateWord(qt, cw))));

  if (hasExplicitCityOrCp) {
    const cityFiltered = pool.filter(c => normalizeAddrText(c.postcode) === normalizeAddrText(primary.postcode) || normalizeAddrText(c.city) === normalizeAddrText(primary.city));
    const allCitySamePlace = cityFiltered.every(
      c => Math.hypot(c.lon - primary.lon, c.lat - primary.lat) < 0.004
    );
    if (allCitySamePlace) {
      return { lowAmbiguity: true, bestCandidate: primary };
    }
  }

  // Or if primary score strongly dominates the runner-up
  if ((primary.score || 0) >= 0.8 && ((primary.score || 0) - (pool[1]?.score || 0)) >= 0.14) {
    return { lowAmbiguity: true, bestCandidate: primary };
  }

  return { lowAmbiguity: false, reason: 'ambiguous_multiple_matches' };
}

function initAddressSearch() {
  const input = document.getElementById('input-address-search');
  const clearBtn = document.getElementById('btn-clear-address-search');
  const suggestionsEl = document.getElementById('address-search-suggestions');
  if (!input) return;

  let suggestDebounceTimer = null;
  let autoMoveDebounceTimer = null;
  let activeAbortController = null;
  let latestCandidates = [];
  let latestCandidatesQuery = '';
  let lastAutoMovedKey = '';

  const closeSuggestions = () => {
    if (suggestionsEl) {
      suggestionsEl.classList.remove('open');
      suggestionsEl.innerHTML = '';
    }
  };

  const navigateToCandidate = (cand, updateInput = false) => {
    if (!cand || !state.map) return;
    const key = `${cand.lon.toFixed(5)},${cand.lat.toFixed(5)}`;
    lastAutoMovedKey = key;

    if (updateInput && cand.label) {
      input.value = cand.label;
      if (clearBtn) clearBtn.style.display = 'flex';
    }

    closeSuggestions();
    state.map.flyTo({ center: [cand.lon, cand.lat], zoom: 17, duration: 900, essential: true });
    addSearchedAddressPin({
      lon: cand.lon,
      lat: cand.lat,
      label: cand.streetName || cand.label,
      context: cand.context || `${cand.postcode || ''} ${cand.city || ''}`.trim(),
      batiment_groupe_id: cand.batiment_groupe_id || null,
    });
  };

  const renderSuggestions = (candidates, ambiguityInfo) => {
    if (!suggestionsEl) return;
    if (!candidates || candidates.length === 0) {
      closeSuggestions();
      return;
    }

    const topList = candidates.slice(0, 6);
    const itemsHtml = topList.map((c, idx) => {
      const badgeClass = c.inActiveTerritory ? 'badge-local' : 'badge-ban';
      const badgeText = c.inActiveTerritory ? '📍 Territoire actif' : '🇫🇷 France';
      return `
        <div class="map-search-suggestion-item" data-idx="${idx}">
          <div class="map-search-suggestion-main">
            <span class="map-search-suggestion-title">${escapeHtml(c.streetName || c.label)}</span>
            <span class="map-search-suggestion-sub">${escapeHtml(c.context || c.label)}</span>
          </div>
          <span class="map-search-suggestion-badge ${badgeClass}">${badgeText}</span>
        </div>
      `;
    }).join('');

    const hintHtml = !ambiguityInfo?.lowAmbiguity
      ? `<div class="map-search-hint-bar">💡 Précisez l'adresse ou cliquez sur une suggestion pour centrer la carte</div>`
      : '';

    suggestionsEl.innerHTML = itemsHtml + hintHtml;
    suggestionsEl.classList.add('open');

    suggestionsEl.querySelectorAll('.map-search-suggestion-item').forEach((el) => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = parseInt(el.getAttribute('data-idx'), 10);
        const chosen = topList[idx];
        if (chosen) {
          clearTimeout(autoMoveDebounceTimer);
          navigateToCandidate(chosen, true);
        }
      });
    });
  };

  input.addEventListener('input', (e) => {
    clearTimeout(suggestDebounceTimer);
    clearTimeout(autoMoveDebounceTimer);
    if (activeAbortController) {
      activeAbortController.abort();
      activeAbortController = null;
    }

    const q = e.target.value.trim();
    latestCandidates = [];
    latestCandidatesQuery = '';

    if (clearBtn) {
      clearBtn.style.display = q.length > 0 ? 'flex' : 'none';
    }

    if (q.length < 3) {
      lastAutoMovedKey = '';
      closeSuggestions();
      return;
    }

    // 1. Fetch & show suggestions after 350ms (does NOT move the map)
    suggestDebounceTimer = setTimeout(async () => {
      // Immediately show local building matches if available
      const localFast = searchLocalBuildingAddresses(q);
      if (localFast.length > 0 && input.value.trim() === q) {
        latestCandidates = localFast;
        latestCandidatesQuery = q;
        renderSuggestions(localFast, evaluateAddressAmbiguity(q, localFast));
      }

      activeAbortController = new AbortController();
      const candidates = await fetchAddressCandidates(q, activeAbortController.signal, 1000);
      if (input.value.trim() !== q) return;
      latestCandidates = candidates;
      latestCandidatesQuery = q;
      const ambiguity = evaluateAddressAmbiguity(q, candidates);
      renderSuggestions(candidates, ambiguity);
    }, 350);

    // 2. Only auto-move the map after a longer debounce (850ms) AND when ambiguity is low
    autoMoveDebounceTimer = setTimeout(async () => {
      if (input.value.trim() !== q) return;

      // First check instant local candidates or already resolved candidates for this exact query
      let candidates = (latestCandidatesQuery === q && latestCandidates.length > 0)
        ? latestCandidates
        : searchLocalBuildingAddresses(q);

      let ambiguity = evaluateAddressAmbiguity(q, candidates);

      // If not yet resolved locally, fetch with BAN API
      if (!ambiguity.lowAmbiguity && latestCandidatesQuery !== q) {
        activeAbortController = new AbortController();
        candidates = await fetchAddressCandidates(q, activeAbortController.signal, 1200);
        if (input.value.trim() !== q) return;
        latestCandidates = candidates;
        latestCandidatesQuery = q;
        ambiguity = evaluateAddressAmbiguity(q, candidates);
      }

      if (ambiguity.lowAmbiguity && ambiguity.bestCandidate) {
        const target = ambiguity.bestCandidate;
        const key = `${target.lon.toFixed(5)},${target.lat.toFixed(5)}`;
        if (key !== lastAutoMovedKey) {
          navigateToCandidate(target, false);
        }
      }
    }, 850);
  });

  // Allow pressing Enter to immediately select the best candidate
  input.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      clearTimeout(suggestDebounceTimer);
      clearTimeout(autoMoveDebounceTimer);
      const q = input.value.trim();
      if (q.length < 3) return;
      let candidates = latestCandidates;
      if (!candidates || candidates.length === 0) {
        activeAbortController = new AbortController();
        candidates = await fetchAddressCandidates(q, activeAbortController.signal);
        latestCandidates = candidates;
      }
      if (candidates && candidates.length > 0) {
        navigateToCandidate(candidates[0], false);
      }
    } else if (e.key === 'Escape') {
      closeSuggestions();
    }
  });

  clearBtn?.addEventListener('click', () => {
    clearTimeout(suggestDebounceTimer);
    clearTimeout(autoMoveDebounceTimer);
    if (activeAbortController) {
      activeAbortController.abort();
      activeAbortController = null;
    }
    input.value = '';
    clearBtn.style.display = 'none';
    latestCandidates = [];
    lastAutoMovedKey = '';
    closeSuggestions();
    clearSearchedAddressPins();
    input.focus();
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('#map-search-bar')) {
      closeSuggestions();
    }
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
  document.getElementById('btn-load-territory')?.addEventListener('click', () => {
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

  // Map Style Mode Select inside Legend
  const colorSelect = document.getElementById('select-color-mode');
  if (colorSelect) {
    colorSelect.addEventListener('change', (e) => {
      state.mapStyleMode = e.target.value;
      updateLegend();
      applyFilters();
      saveSessionToStorage();
    });
  }

  // Map Display Settings Overlay (Fond blanc & Limite de polygones)
  const toggleDisplayOverlay = () => {
    const overlay = document.getElementById('map-display-overlay');
    if (!overlay) return;
    overlay.classList.toggle('collapsed');
    const isCollapsed = overlay.classList.contains('collapsed');
    const btn = document.getElementById('btn-toggle-display-overlay');
    if (btn) btn.textContent = isCollapsed ? '▸' : '▾';
    saveMapDisplaySettingsToStorage();
    scheduleSaveSession();
  };
  document.getElementById('header-toggle-display-overlay')?.addEventListener('click', toggleDisplayOverlay);
  document.getElementById('btn-toggle-display-overlay')?.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleDisplayOverlay();
  });

  // Background Dimming Slider
  const bgDimSlider = document.getElementById('slider-bg-dim');
  if (bgDimSlider) {
    bgDimSlider.addEventListener('input', (e) => {
      state.bgDimPct = parseInt(e.target.value, 10);
      document.getElementById('label-bg-dim').textContent = `${state.bgDimPct}%`;
      setMapDim(state.bgDimPct);
      saveMapDisplaySettingsToStorage();
      scheduleSaveSession();
    });
  }

  // Max Polygons Select
  const maxPolySelect = document.getElementById('select-max-polygons');
  if (maxPolySelect) {
    maxPolySelect.addEventListener('change', (e) => {
      state.maxPolygons = parseInt(e.target.value, 10);
      applyFilters();
      saveMapDisplaySettingsToStorage();
      saveSessionToStorage();
    });
  }

  // Reset Filters & Clear All Filters Buttons
  document.getElementById('btn-reset-filters')?.addEventListener('click', () => {
    clearAllFilters();
  });
  document.getElementById('btn-clear-all-filters')?.addEventListener('click', () => {
    clearAllFilters();
  });

  // Drawer Close Button
  document.getElementById('btn-close-drawer')?.addEventListener('click', () => {
    state.selectedBuildingId = null;
    document.getElementById('building-drawer').classList.remove('open');
    if (state.map) {
      state.map.setFilter('buildings-selected', ['==', ['get', 'batiment_groupe_id'], '']);
    }
    saveSessionToStorage();
  });

  // Modals & Territory Manager
  document.getElementById('btn-open-territory-manager')?.addEventListener('click', () => {
    if (state.territorySelectionMode) {
      exitTerritorySelectionMode();
    } else {
      enterTerritorySelectionMode();
    }
  });
  document.getElementById('btn-close-territory-modal')?.addEventListener('click', () => {
    document.getElementById('modal-territory').classList.remove('open');
  });
  document.getElementById('btn-close-territory-footer')?.addEventListener('click', () => {
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
  document.getElementById('btn-save-data-url')?.addEventListener('click', async () => {
    let url = inputBaseUrl.value.trim();
    if (!url.endsWith('/')) url += '/';
    state.dataBaseUrl = url;
    await loadManifest();
    await loadTerritory();
    alert(`Source de données mise à jour: ${url}`);
  });

  document.getElementById('link-source-local')?.addEventListener('click', (e) => {
    e.preventDefault();
    inputBaseUrl.value = '../../data/chunks/';
    document.getElementById('btn-save-data-url').click();
  });

  document.getElementById('link-source-github')?.addEventListener('click', (e) => {
    e.preventDefault();
    inputBaseUrl.value = 'https://raw.githubusercontent.com/sebastienbrg/building_mapper/data-release/data/chunks/';
    document.getElementById('btn-save-data-url').click();
  });

  // Clear Cache Button
  document.getElementById('btn-clear-cache')?.addEventListener('click', async () => {
    if ('caches' in window) {
      await caches.delete('tezeloma-data-v1');
      await caches.delete('tezeloma-data-v2');
    }
    try {
      localStorage.removeItem(SESSION_STORAGE_KEY);
    } catch (e) {
      // ignore
    }
    alert("Le cache local des données et de session a été vidé avec succès.");
  });

  initFieldworkDropzone();
  initAddressSearch();

  window.addEventListener('beforeunload', () => {
    saveSessionToStorage();
  });
  window.addEventListener('pagehide', () => {
    saveSessionToStorage();
  });
}

function closeAllModals() {
  document.querySelectorAll('.modal-overlay:not(.tool-dialog-overlay)').forEach(m => m.classList.remove('open'));
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
