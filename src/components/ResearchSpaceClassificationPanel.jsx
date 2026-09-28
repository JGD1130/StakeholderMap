// src/components/ResearchSpaceClassificationPanel.jsx
//
// Research Space Classification module (F&A Compass; admin-only, gated by
// config.enableResearchSpaceClassification). Its own standalone section,
// deliberately NOT nested inside Classroom Utilization or Capital Priorities,
// per explicit instruction.
//
// F&A space-survey functional-use classification, occupant-based per
// Clark's real domain expertise (2026-09-17 spec) -- NOT simple room-level
// percentages. A room's functional profile is derived from its occupants'
// funding-source splits, weighted by each occupant's share of the room:
//   universities/{universityId}/researchSpaceOccupants/{occupantId}
//     { roomKey, occupantName, role, fundingSources: [{source, percentage,
//       category}], footprintWeight, kind?, createdAt, updatedAt }
//     (kind: 'class_lab' marks the one placeholder occupant of a room saved
//     as "Class lab (instruction)" -- see researchSpaceDraft.js)
//   universities/{universityId}/researchSpaceRoomStatus/{roomKey}
//     { status: 'vacant_unassigned' | 'ineligible_non_assignable', updatedAt }
//     -- mutually exclusive with occupants; saving a status clears the room's
//     occupants, and saving occupants clears any status doc.
// The blended room profile is computed live, never stored.
//
// Room scope: every Airtable room whose type is "Office - *" or
// "Laboratory - *" (all subtypes -- the broad interpretation, per Clark's
// explicit decision), minus demolished buildings; see researchSpaceRoomScope.js.
//
// Phase 6.4: this panel is the side card only -- classification progress,
// Organized Research SF, "Open F&A Compass" (FaCompassWorkspace.jsx) and
// "Classify on map", which switches the map to F&A colors and docks the
// Classifier (FaClassifier.jsx) in place of the side panel. Data, rollup and
// the editor draft live in useResearchSpaceData (`data`).
import React, { useState } from 'react';
import { CE_ORANGE_HEADER } from '../utils/brandColors';
import { MF } from '../theme/mfTokens';
import { KpiCard } from './mf';
import { mfSecondaryButtonStyle } from './mf/mfStyles';
import FaCompassWorkspace from './FaCompassWorkspace.jsx';
import { sideCardKpis } from './faCompassView';

const CLARK_ENERSEN_ORANGE = CE_ORANGE_HEADER;

const primaryButton = {
  width: '100%',
  padding: '8px 12px',
  border: 'none',
  borderRadius: 6,
  background: MF.ink.primary,
  color: MF.surface.page,
  fontFamily: 'inherit',
  fontSize: 12.5,
  fontWeight: 600,
  cursor: 'pointer'
};

// onStartClassify(): enter "Classify on map" (StakeholderMap).
// onShowRoomOnMap(room): same, opening that room on its floor (workspace Rooms tab).
// resolveRoomFloor(room) -> Promise<floor id | null>, for the workspace's
// "No floorplan" check.
export default function ResearchSpaceClassificationPanel({
  enabled = false,
  title = 'F&A Compass',
  universityName = '',
  data,
  onStartClassify,
  onShowRoomOnMap,
  resolveRoomFloor
}) {
  const [workspaceOpen, setWorkspaceOpen] = useState(false);

  if (!enabled) return null;

  const { airtableError, loadError, reload } = data;

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
      <h4 style={{ margin: 0, padding: '6px 8px', fontSize: 12.5, fontWeight: 700, color: MF.surface.page, background: CLARK_ENERSEN_ORANGE, borderRadius: 6 }}>
        {title}
      </h4>

      {loadError || airtableError ? (
        <div role="alert" style={{ marginTop: 8, fontSize: 12, color: MF.status.error }}>
          {loadError || airtableError}{' '}
          {airtableError && typeof reload === 'function' ? (
            <button
              type="button"
              className="mf-shell-button"
              onClick={reload}
              style={{ ...mfSecondaryButtonStyle, padding: '2px 8px', '--mf-focus-color': MF.util.base }}
            >
              Retry
            </button>
          ) : null}
        </div>
      ) : null}

      <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
        {sideCardKpis(data).map(({ key, ...props }) => (
          <div key={key} style={{ flex: 1, minWidth: 0 }}>
            <KpiCard {...props} compact />
          </div>
        ))}
      </div>

      <button type="button" onClick={() => setWorkspaceOpen(true)} style={{ ...primaryButton, marginTop: 8 }}>
        Open F&amp;A Compass
      </button>
      <button
        type="button"
        className="mf-shell-button"
        onClick={() => onStartClassify?.()}
        disabled={!onStartClassify}
        style={{ ...mfSecondaryButtonStyle, width: '100%', padding: '8px 12px', fontSize: 12.5, marginTop: 6, '--mf-focus-color': MF.util.base }}
      >
        Classify on map
      </button>

      {workspaceOpen ? (
        <FaCompassWorkspace
          data={data}
          universityName={universityName}
          onShowRoomOnMap={onShowRoomOnMap}
          resolveRoomFloor={resolveRoomFloor}
          onClose={() => setWorkspaceOpen(false)}
        />
      ) : null}
    </div>
  );
}
