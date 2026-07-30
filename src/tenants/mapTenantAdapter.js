import { canon } from '../utils/idUtils';
import { resolveTenant } from './registry';

const normalizeToken = (value) => String(canon(value || '') || '').trim().toLowerCase();

const collectConfiguredFloorplanBuildings = ({ config, buildingFolderMap }) => {
  const seen = new Set();
  return (config?.buildings?.features || [])
    .map((feature) => {
      const props = feature?.properties || {};
      return String(props.name || props.Name || props.id || '').trim();
    })
    .filter((name) => {
      if (!name || seen.has(name)) return false;
      if (!buildingFolderMap?.[name]) return false;
      seen.add(name);
      return true;
    })
    .map((name) => ({ name, folder: buildingFolderMap[name] }));
};

const buildStaticCampusFloorplanBuildings = ({ floorplansEnabled, buildingsList = [], campusName = '' }) => {
  if (!floorplansEnabled) return [];
  return buildingsList.filter((building) => !building?.campus || building.campus === campusName);
};

const filterRoomsByConfiguredCampus = ({
  rooms = [],
  allowedCampusKeys = new Set(),
  configuredDashboardBuildingKeys = new Set(),
  getRoomBuildingId,
  getRoomBuildingLabel,
  normalizeDashboardKey
}) => {
  if (!Array.isArray(rooms) || !rooms.length) return [];

  return rooms.filter((room) => {
    if (!room || typeof room !== 'object') return false;

    const explicitCampusKeys = [
      room.campus,
      room.campusId,
      room.campus_id,
      room.universityId,
      room.university_id,
      room.university,
      room.tenant,
      room.tenantId,
      room.organization,
      room.org
    ]
      .map((value) => normalizeToken(value || ''))
      .filter((value) => value && value !== 'na');

    const roomBuildingKey = normalizeDashboardKey(
      getRoomBuildingId(room) || getRoomBuildingLabel(room)
    );
    const hasConfiguredBuildings = configuredDashboardBuildingKeys.size > 0;
    const buildingInScope = (roomBuildingKey && hasConfiguredBuildings)
      ? configuredDashboardBuildingKeys.has(roomBuildingKey)
      : null;

    if (explicitCampusKeys.length) {
      const campusMatch = explicitCampusKeys.some((value) => allowedCampusKeys.has(value));
      if (campusMatch) return true;
      if (buildingInScope !== null) return buildingInScope;
      return false;
    }

    if (buildingInScope !== null) return buildingInScope;
    return false;
  });
};

const DEFAULT_TENANT_ADAPTER = Object.freeze({
  id: 'default',
  isSarpyCountyInstance: false,
  isHastingsCollegeInstance: false,
  isCherokeeMentalHealthInstance: false,
  defaultDashboardTitle: 'Campus Summary',
  dashboardSpaceContextTitle: 'Campus Space Context',
  showClassroomUtilizationDashboard: true,
  showStrategicDashboard: true,
  matches: () => false,
  getFloorplansEnabled: ({ config }) => Boolean(config?.enableFloorplans ?? true),
  getFloorplanOverlaysEnabled: ({ mode }) => mode === 'admin',
  getWallsOverlayEnabled: ({ mode }) => mode === 'admin',
  getDoorStairOverlaysEnabled: ({ mode }) => mode === 'admin',
  getLowZoomBuildingMarkersEnabled: ({ config }) => Boolean(config?.enableLowZoomBuildingMarkers ?? false),
  getUseFacilityTypeBuildingColorsInSpaceData: () => false,
  getDefaultUniversityLogoFile: () => 'HC_image.png',
  getUniversityLogoAlt: ({ universityName }) => universityName || 'University',
  getAiEnabledForCurrentView: ({ config }) => config?.enableMapfluenceAI !== false,
  getPublicAirtableControlsAllowed: ({ isDemoPublicMode }) => Boolean(isDemoPublicMode),
  buildFloorplanBuildingOptions: ({ floorplansEnabled, config, buildingFolderMap }) =>
    floorplansEnabled ? collectConfiguredFloorplanBuildings({ config, buildingFolderMap }) : [],
  filterRoomsToConfiguredCampus: ({ rooms, floorplansEnabled }) =>
    floorplansEnabled ? (Array.isArray(rooms) ? rooms : []) : []
});

const HASTINGS_TENANT_ADAPTER = Object.freeze({
  ...DEFAULT_TENANT_ADAPTER,
  id: 'hastings',
  isHastingsCollegeInstance: true,
  matches: ({ resolvedTenantId, normalizedUniversityId, activeUniversityName }) =>
    resolvedTenantId === 'hastings' ||
    normalizedUniversityId === 'hastings' ||
    normalizedUniversityId === 'hastings_college' ||
    /hastings/i.test(String(activeUniversityName || '')),
  buildFloorplanBuildingOptions: ({ floorplansEnabled, buildingsList }) =>
    buildStaticCampusFloorplanBuildings({
      floorplansEnabled,
      buildingsList,
      campusName: 'Hastings'
    }),
  filterRoomsToConfiguredCampus: ({ rooms }) => (Array.isArray(rooms) ? rooms : [])
});

const SARPY_TENANT_ADAPTER = Object.freeze({
  ...DEFAULT_TENANT_ADAPTER,
  id: 'sarpy-county',
  isSarpyCountyInstance: true,
  defaultDashboardTitle: 'County Summary',
  dashboardSpaceContextTitle: 'County Space Context',
  showClassroomUtilizationDashboard: false,
  showStrategicDashboard: false,
  matches: ({ resolvedTenantId, normalizedUniversityId, activeUniversityName }) =>
    resolvedTenantId === 'sarpy_county' ||
    resolvedTenantId === 'sarpy-county' ||
    normalizedUniversityId === 'sarpy_county' ||
    normalizedUniversityId === 'sarpycounty' ||
    normalizedUniversityId === 'sarpy' ||
    normalizedUniversityId === 'sarpy_ne' ||
    /sarpy/i.test(String(activeUniversityName || '')),
  getFloorplansEnabled: ({ config }) => Boolean(config?.enableFloorplans ?? false),
  getFloorplanOverlaysEnabled: () => false,
  getWallsOverlayEnabled: () => true,
  getDoorStairOverlaysEnabled: () => false,
  getLowZoomBuildingMarkersEnabled: ({ config }) => Boolean(config?.enableLowZoomBuildingMarkers ?? true),
  getUseFacilityTypeBuildingColorsInSpaceData: () => true,
  getDefaultUniversityLogoFile: () => 'SarpyCounty_logo.png',
  getUniversityLogoAlt: () => 'Sarpy County',
  getAiEnabledForCurrentView: ({ config, isAdminMode }) =>
    (config?.enableMapfluenceAI ?? Boolean(isAdminMode)) !== false,
  getPublicAirtableControlsAllowed: () => false,
  buildFloorplanBuildingOptions: ({ floorplansEnabled, config, buildingFolderMap }) =>
    floorplansEnabled ? collectConfiguredFloorplanBuildings({ config, buildingFolderMap }) : [],
  filterRoomsToConfiguredCampus: ({
    rooms,
    allowedCampusKeys,
    configuredDashboardBuildingKeys,
    getRoomBuildingId,
    getRoomBuildingLabel,
    normalizeDashboardKey
  }) =>
    filterRoomsByConfiguredCampus({
      rooms,
      allowedCampusKeys,
      configuredDashboardBuildingKeys,
      getRoomBuildingId,
      getRoomBuildingLabel,
      normalizeDashboardKey
    })
});

const CHEROKEE_TENANT_ADAPTER = Object.freeze({
  ...DEFAULT_TENANT_ADAPTER,
  id: 'cherokee-mental-health',
  isCherokeeMentalHealthInstance: true,
  matches: ({ resolvedTenantId, normalizedUniversityId, activeUniversityName }) =>
    resolvedTenantId === 'cherokee_mental_health' ||
    resolvedTenantId === 'cherokee-mental-health' ||
    normalizedUniversityId === 'cherokee_mental_health' ||
    normalizedUniversityId === 'cherokee_mental_health_map' ||
    normalizedUniversityId === 'cherokee' ||
    normalizedUniversityId === 'cherokee_mh' ||
    /cherokee/i.test(String(activeUniversityName || ''))
});

const TENANT_ADAPTERS = [
  HASTINGS_TENANT_ADAPTER,
  SARPY_TENANT_ADAPTER,
  CHEROKEE_TENANT_ADAPTER
];

export function resolveMapTenantAdapter({ universityId, config, tenant, activeUniversityName }) {
  const resolvedTenant =
    tenant ||
    resolveTenant(universityId) ||
    resolveTenant(config?.universityId) ||
    null;

  const context = {
    resolvedTenantId: normalizeToken(resolvedTenant?.id || resolvedTenant?.configId || ''),
    normalizedUniversityId: normalizeToken(universityId || config?.universityId || ''),
    activeUniversityName: String(activeUniversityName || '').trim()
  };

  return TENANT_ADAPTERS.find((adapter) => adapter.matches(context)) || DEFAULT_TENANT_ADAPTER;
}

export {
  DEFAULT_TENANT_ADAPTER,
  HASTINGS_TENANT_ADAPTER,
  SARPY_TENANT_ADAPTER,
  CHEROKEE_TENANT_ADAPTER
};
