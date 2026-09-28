// src/components/CapitalPrioritiesPanel.jsx
//
// Capital Compass side-panel card (admin-only, gated on
// config.enableCapitalPriorities): the orange header, two compact KPIs --
// Tier 1 capital need and buildings scored -- and the button that opens the
// Capital Compass workspace (CapitalCompassWorkspace.jsx), where the ranking,
// budget, phasing, deferred maintenance, scoring and uploads now live.
//
// All data comes from useCapitalCompassData (mounted once in
// StakeholderMap.jsx, passed in as `capitalData`). Building names come from
// the tenant's buildings config (read-only, never written back); they are the
// scoring list, the "of M buildings" count and the deferred maintenance name
// match.
import React, { useMemo, useState } from 'react';
import { CE_ORANGE_HEADER } from '../utils/brandColors';
import { MF } from '../theme/mfTokens';
import { KpiCard } from './mf';
import CapitalCompassWorkspace from './CapitalCompassWorkspace.jsx';
import { panelKpis } from './capitalCompassView';

export default function CapitalPrioritiesPanel({
  enabled = false,
  title = 'Capital Compass',
  buildingFeatures = [],
  getBuildingResourceEntry = null,
  // useCapitalCompassData's result (mounted once in StakeholderMap.jsx).
  capitalData = null,
  // Switches the map to the "Capital Compass tiers" view (null = not offered).
  onShowOnMap = null
}) {
  const [workspaceOpen, setWorkspaceOpen] = useState(false);

  const buildingNames = useMemo(() => {
    const seen = new Set();
    (Array.isArray(buildingFeatures) ? buildingFeatures : []).forEach((feature) => {
      const name = String(feature?.properties?.id || feature?.properties?.name || '').trim();
      if (name) seen.add(name);
    });
    return [...seen].sort((a, b) => a.localeCompare(b));
  }, [buildingFeatures]);

  if (!enabled) return null;

  const status = capitalData?.status || 'idle';
  const ready = status === 'ready';
  // Open once the first load has settled -- after an error too, so Setup
  // (scoring, uploads) is still reachable.
  const canOpenWorkspace = ready || status === 'error';

  return (
    <div
      className="control-section"
      style={{
        background: MF.surface.page,
        padding: 8,
        border: `1px solid ${MF.line.border}`,
        borderRadius: 6,
        marginTop: 6,
        display: 'flex',
        flexDirection: 'column'
      }}
    >
      <h4 style={{ margin: 0, padding: '6px 8px', fontSize: 12.5, fontWeight: 700, color: MF.surface.page, background: CE_ORANGE_HEADER, borderRadius: 6 }}>{title}</h4>

      {ready ? (
        <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
          {panelKpis(capitalData, buildingNames.length).map(({ key, ...props }) => (
            <div key={key} style={{ flex: 1, minWidth: 0 }}>
              <KpiCard {...props} compact />
            </div>
          ))}
        </div>
      ) : (
        <div style={{ marginTop: 8, fontSize: 11, color: MF.ink.muted }}>
          {status === 'error' ? "Couldn't load Capital Compass — open it to retry." : 'Loading…'}
        </div>
      )}

      <button
        type="button"
        onClick={() => setWorkspaceOpen(true)}
        disabled={!canOpenWorkspace}
        style={{
          marginTop: 8,
          width: '100%',
          padding: '8px 12px',
          border: 'none',
          borderRadius: 6,
          background: MF.ink.primary,
          color: MF.surface.page,
          fontFamily: 'inherit',
          fontSize: 12.5,
          fontWeight: 600,
          cursor: canOpenWorkspace ? 'pointer' : 'default',
          opacity: canOpenWorkspace ? 1 : 0.55
        }}
      >
        Open Capital Compass
      </button>

      {workspaceOpen && canOpenWorkspace ? (
        <CapitalCompassWorkspace
          data={capitalData}
          buildingNames={buildingNames}
          getBuildingResourceEntry={getBuildingResourceEntry}
          onShowOnMap={onShowOnMap}
          onClose={() => setWorkspaceOpen(false)}
        />
      ) : null}
    </div>
  );
}
