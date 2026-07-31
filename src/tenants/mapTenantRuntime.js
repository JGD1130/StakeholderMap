import { canon } from '../utils/idUtils';

export const SARPY_FACILITY_TYPE_COLORS = Object.freeze({
  Administrative: '#2563eb',
  'Law Enforcement': '#dc2626',
  'Public Works': '#facc15',
  Recreation: '#16a34a',
  Infrastructure: '#6b7280'
});

export const getSarpyFacilityTypeColor = (facilityType) => (
  SARPY_FACILITY_TYPE_COLORS[String(facilityType || '').trim()] || '#9ca3af'
);

export const buildSarpyFacilityTypeColorExpression = () => {
  const expr = ['match', ['to-string', ['coalesce', ['get', 'facilityType'], ['get', 'FacilityType'], '']]];
  Object.entries(SARPY_FACILITY_TYPE_COLORS).forEach(([label, color]) => {
    expr.push(label, color);
  });
  expr.push('#9ca3af');
  return expr;
};

export const buildSarpyFacilityTypeLegend = (features = [], enabled = false) => {
  if (!enabled) return [];
  const rows = Array.isArray(features) ? features : [];
  const counts = new Map();
  rows.forEach((feature) => {
    const props = feature?.properties || {};
    const label = String(props.facilityType ?? props.FacilityType ?? '').trim();
    if (!label) return;
    counts.set(label, (counts.get(label) || 0) + 1);
  });
  const knownOrder = Object.keys(SARPY_FACILITY_TYPE_COLORS);
  const ordered = [
    ...knownOrder.filter((label) => counts.has(label)),
    ...Array.from(counts.keys()).filter((label) => !knownOrder.includes(label)).sort((a, b) => a.localeCompare(b))
  ];
  return ordered.map((label) => ({
    label: `${label} (${counts.get(label)})`,
    color: getSarpyFacilityTypeColor(label)
  }));
};

export const buildTenantAllowedCampusKeys = ({
  universityId,
  config,
  floorplanCampus,
  universityName,
  activeUniversityName
}) => new Set(
  [
    universityId,
    config?.universityId,
    floorplanCampus,
    universityName,
    activeUniversityName
  ]
    .map((value) => canon(value || ''))
    .filter((value) => value && value !== 'na')
);

export const buildMapTenantRuntime = ({
  tenantAdapter,
  config,
  mode,
  universityName,
  universityId,
  activeUniversityName
}) => {
  const isSarpyCountyInstance = Boolean(tenantAdapter?.isSarpyCountyInstance);
  const isHastingsCollegeInstance = Boolean(tenantAdapter?.isHastingsCollegeInstance);
  const isCherokeeMentalHealthInstance = Boolean(tenantAdapter?.isCherokeeMentalHealthInstance);
  const floorplansEnabled = tenantAdapter.getFloorplansEnabled({
    config,
    defaultEnabled: !isSarpyCountyInstance
  });
  const lowZoomBuildingMarkersEnabled = tenantAdapter.getLowZoomBuildingMarkersEnabled({
    config,
    defaultEnabled: isSarpyCountyInstance
  });
  const floorplanOverlaysEnabled = tenantAdapter.getFloorplanOverlaysEnabled({
    config,
    mode,
    isAdminMode: mode === 'admin'
  });
  const wallsOverlayEnabled = tenantAdapter.getWallsOverlayEnabled({
    config,
    mode,
    isAdminMode: mode === 'admin'
  });
  const doorStairOverlaysEnabled = tenantAdapter.getDoorStairOverlaysEnabled({
    config,
    mode,
    isAdminMode: mode === 'admin'
  });
  const sarpyFacilityTypeBuildingColorsEnabled = tenantAdapter.getUseFacilityTypeBuildingColorsInSpaceData({
    config,
    mode
  });
  const hasConfiguredUniversityLogo = Boolean(
    config?.logos && Object.prototype.hasOwnProperty.call(config.logos, 'university')
  );
  const universityLogoFile = String(
    hasConfiguredUniversityLogo
      ? (config?.logos?.university || '')
      : tenantAdapter.getDefaultUniversityLogoFile({ config, universityName, universityId })
  ).trim();

  return {
    isSarpyCountyInstance,
    isHastingsCollegeInstance,
    isCherokeeMentalHealthInstance,
    sarpyBuildingOutlineBaseColor: isSarpyCountyInstance ? '#f97316' : '#000000',
    sarpyBuildingOutlineSelectedColor: isSarpyCountyInstance ? '#fb923c' : '#1d4ed8',
    floorplansEnabled,
    lowZoomBuildingMarkersEnabled,
    floorplanOverlaysEnabled,
    wallsOverlayEnabled,
    doorStairOverlaysEnabled,
    sarpyFacilityTypeBuildingColorsEnabled,
    sarpyFacilityTypeColorExpr: sarpyFacilityTypeBuildingColorsEnabled
      ? buildSarpyFacilityTypeColorExpression()
      : null,
    sarpyFacilityTypeLegend: buildSarpyFacilityTypeLegend(config?.buildings?.features, isSarpyCountyInstance),
    defaultDashboardTitle: tenantAdapter.defaultDashboardTitle,
    dashboardSpaceContextTitle: tenantAdapter.dashboardSpaceContextTitle,
    showClassroomUtilizationDashboard: tenantAdapter.showClassroomUtilizationDashboard,
    showStrategicDashboard: tenantAdapter.showStrategicDashboard,
    universityLogoFile,
    universityLogoAlt: tenantAdapter.getUniversityLogoAlt({ universityName, universityId, config, activeUniversityName }),
    aiEnabledForCurrentView: tenantAdapter.getAiEnabledForCurrentView({ config, isAdminMode: mode === 'admin' }),
    airtableSyncEnabled: tenantAdapter.getAirtableSyncEnabled({ config, mode }),
    departmentOptionsEndpointEnabled: tenantAdapter.getDepartmentOptionsEndpointEnabled({ config, mode }),
    roomDataPolicy: tenantAdapter.getRoomDataPolicy({ config, mode })
  };
};