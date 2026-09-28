// src/components/ClassroomUtilizationPanel.jsx
//
// Classroom Utilization module (Hastings-only, admin-only, gated by
// config.enableClassroomUtilization -- off by default, same convention as
// CapitalPrioritiesPanel/enableCapitalPriorities). Exports TWO top-level
// panel components, each its own .dashboard-box in StakeholderMap.jsx, both
// gated by the same enableClassroomUtilization flag (no second flag):
//   - `ClassroomUtilizationPanel` (default export, title "Classroom
//     Utilization"): a summary card plus the button that opens the
//     Classroom Utilization workspace (ClassroomUtilizationWorkspace.jsx),
//     where Import Schedule, Terms and all results now live.
//   - `SpaceGrowthProjectionsPanel` (named export, title "Space Growth
//     Projections"): a summary card plus the button that opens the Space
//     Growth workspace (SpaceGrowthWorkspace.jsx), where the results and the
//     setup tools (space targets, room tagging, department targets,
//     enrollment upload -- SpaceGrowthSetupTab.jsx) now live.
import React, { useState } from 'react';
import { CE_ORANGE_HEADER } from '../utils/brandColors';
import { MF } from '../theme/mfTokens';
import { KpiCard } from './mf';
import ClassroomUtilizationWorkspace from './ClassroomUtilizationWorkspace.jsx';
import SpaceGrowthWorkspace from './SpaceGrowthWorkspace.jsx';
import { summaryKpis, termDisplayLabel } from './classroomUtilizationView';
import { sideCardKpis } from './spaceGrowthView';

// Shared module header color (src/utils/brandColors.js). Used by both panel
// titles this file exports (ClassroomUtilizationPanel and
// SpaceGrowthProjectionsPanel).
const CLARK_ENERSEN_ORANGE = CE_ORANGE_HEADER;

// Dark full-width "Open …" button shared by both summary cards.
function openButtonStyle(enabled) {
  return {
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
    cursor: enabled ? 'pointer' : 'default',
    opacity: enabled ? 1 : 0.55
  };
}

const summaryCardStyle = {
  background: MF.surface.page,
  padding: 8,
  border: `1px solid ${MF.line.border}`,
  borderRadius: 6,
  marginTop: 6,
  display: 'flex',
  flexDirection: 'column'
};

// Structural split (2026-08-19): two separate dashboard boxes in
// StakeholderMap.jsx, both gated by the one enableClassroomUtilization flag --
// ClassroomUtilizationPanel (this component) and SpaceGrowthProjectionsPanel
// (below: Space Configuration, Room Utilization Tagging, Enrollment & FTE
// Projections, Space Growth / Right-Sizing). Kept as two exports from this
// one file because the Space Growth sections share the constants/helpers at
// the top.
//
// Phase 3.4: this panel is now a compact summary card -- two KPIs for the
// default term (the current term, or the most recent term with classes) and
// the button that opens the Classroom Utilization workspace. The old
// Import Schedule / Terms / Utilization Results / Heat Map / Size Range
// sections moved into the workspace (ClassroomUtilizationWorkspace.jsx; admin
// tools on its Setup tab).
export default function ClassroomUtilizationPanel({
  enabled = false,
  // Deliberately distinct from SpaceDashboardPanel's pre-existing, unrelated
  // "Classroom Utilization" section (static-CSV-backed, always on for
  // non-Sarpy tenants) so the two aren't mistaken for one another in the UI.
  title = 'Classroom Utilization',
  // Return value of useClassroomUtilizationData (mounted once in
  // StakeholderMap.jsx): the one shared schedule/terms/Airtable load.
  utilizationData = null
}) {
  const [workspaceOpen, setWorkspaceOpen] = useState(false);

  if (!enabled) return null;

  const status = utilizationData?.status || 'idle';
  const results = utilizationData?.results || null;
  // Open once the first load has settled -- after an error too, so Setup
  // (import, terms) is still reachable when there's nothing to show yet.
  const canOpenWorkspace = Boolean(results) || status === 'error';
  const termLabel = results ? termDisplayLabel(utilizationData, utilizationData.defaultTermId) : '';

  return (
    <div className="control-section" style={summaryCardStyle}>
      <h4 style={{ margin: 0, padding: '6px 8px', fontSize: 12.5, fontWeight: 700, color: MF.surface.page, background: CLARK_ENERSEN_ORANGE, borderRadius: 6 }}>{title}</h4>

      {!results ? (
        <div style={{ marginTop: 8, fontSize: 11, color: MF.ink.muted }}>
          {status === 'error' ? "Couldn't load classroom utilization — open it to check Setup." : 'Calculating…'}
        </div>
      ) : (
        <>
          {termLabel ? <div style={{ marginTop: 8, fontSize: 11, color: MF.ink.muted }}>{termLabel}</div> : null}
          <div style={{ marginTop: 6, display: 'flex', gap: 8 }}>
            {summaryKpis(utilizationData).map(({ key, ...props }) => (
              <div key={key} style={{ flex: 1, minWidth: 0 }}>
                <KpiCard {...props} compact />
              </div>
            ))}
          </div>
        </>
      )}

      <button
        type="button"
        onClick={() => setWorkspaceOpen(true)}
        disabled={!canOpenWorkspace}
        style={openButtonStyle(canOpenWorkspace)}
      >
        Open Classroom Utilization
      </button>

      {workspaceOpen && canOpenWorkspace ? (
        <ClassroomUtilizationWorkspace data={utilizationData} onClose={() => setWorkspaceOpen(false)} />
      ) : null}
    </div>
  );
}

// Second dashboard box (see the split comment above ClassroomUtilizationPanel).
// Same enableClassroomUtilization flag gates this panel too.
//
// Phase 5.5: a compact summary card -- the 2036 space gap (the Executive
// Dashboard's headline) and 2036 enrollment -- and the button that opens the
// Space Growth workspace. The old Space Configuration / Room Tagging /
// Enrollment / Department Targets / Right-Sizing sections moved into the
// workspace (Setup tab and results tabs).
export function SpaceGrowthProjectionsPanel({
  enabled = false,
  title = 'Space Growth Projections',
  // Return value of useSpaceGrowthData (mounted once in StakeholderMap.jsx):
  // the one shared Space Growth load and calculation.
  spaceGrowthData = null
}) {
  const [workspaceOpen, setWorkspaceOpen] = useState(false);

  if (!enabled || !spaceGrowthData) return null;

  const status = spaceGrowthData.status || 'idle';
  const hasResults = Boolean(spaceGrowthData.dashboardResults);
  // Open once the first load has settled -- after an error too, so Setup is
  // still reachable when there's nothing to show yet.
  const canOpenWorkspace = hasResults || status === 'error';

  return (
    <div className="control-section" style={summaryCardStyle}>
      <h4 style={{ margin: 0, padding: '6px 8px', fontSize: 12.5, fontWeight: 700, color: MF.surface.page, background: CLARK_ENERSEN_ORANGE, borderRadius: 6 }}>{title}</h4>

      {!hasResults ? (
        <div style={{ marginTop: 8, fontSize: 11, color: MF.ink.muted }}>
          {status === 'error' ? "Couldn't load space growth — open it to check Setup." : 'Calculating…'}
        </div>
      ) : (
        <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
          {sideCardKpis(spaceGrowthData).map(({ key, ...props }) => (
            <div key={key} style={{ flex: 1, minWidth: 0 }}>
              <KpiCard {...props} compact />
            </div>
          ))}
        </div>
      )}

      <button
        type="button"
        onClick={() => setWorkspaceOpen(true)}
        disabled={!canOpenWorkspace}
        style={openButtonStyle(canOpenWorkspace)}
      >
        Open Space Growth
      </button>

      {workspaceOpen && canOpenWorkspace ? (
        <SpaceGrowthWorkspace data={spaceGrowthData} onClose={() => setWorkspaceOpen(false)} />
      ) : null}
    </div>
  );
}
