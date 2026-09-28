// src/components/ResearchSpaceClassificationPanel.jsx
//
// Research Space Classification module (Hastings-only, admin-only, gated by
// config.enableResearchSpaceClassification -- off by default until the
// synthetic-scenario walkthrough is confirmed live, same "off until proven"
// posture classroomUtilizationSchema.js used for its own schema-only
// groundwork). Its own standalone section, deliberately NOT nested inside
// Classroom Utilization or Capital Priorities, per explicit instruction.
//
// F&A space-survey functional-use classification, occupant-based per
// Clark's real domain expertise (2026-09-17 spec) -- NOT simple room-level
// percentages. A room's functional profile is derived from its occupants'
// funding-source splits, weighted by each occupant's footprint share of the
// room:
//   universities/{universityId}/researchSpaceOccupants/{occupantId}
//     { roomKey, occupantName, role, fundingSources: [{source, percentage,
//       category}], footprintWeight, createdAt, updatedAt }
//   universities/{universityId}/researchSpaceRoomStatus/{roomKey}
//     { status: 'vacant_unassigned' | 'ineligible_non_assignable', updatedAt }
//     -- mutually exclusive with occupants; a room in one of these EXCLUSION
//     states carries no occupants at all (see researchSpaceClassification.js
//     header comment). Saving a status clears any existing occupants for
//     that room; adding an occupant clears any existing status doc.
//
// The blended room profile is computed live (computeRoomFunctionalProfile),
// never stored redundantly -- what's persisted is only the raw occupant
// docs; every display (room row, room detail, campus rollup) recomputes
// from them.
//
// Room scope: every Airtable room whose type is "Office - *" or
// "Laboratory - *" (all subtypes -- the broad interpretation, per Clark's
// explicit decision), minus demolished buildings; see researchSpaceRoomScope.js.
//
// Data, the campus rollup and the room editor's draft all live in
// useResearchSpaceData (`data`, mounted once in StakeholderMap.jsx): the
// panel reads the rollup, and reads/writes the draft through
// useResearchSpaceDraft(data), so unmounting the panel keeps unsaved edits.
// Reads and writes go to data.universityId.
//
// Phase 6.3: the panel opens with a compact summary (classification progress,
// Organized Research SF) and the button that opens the F&A Compass workspace
// (FaCompassWorkspace.jsx: Overview, Rooms, Method). The room list and the
// occupant editor stay here for now, inside a "Classify rooms" disclosure
// that opens by itself when a room is picked (list or map click).
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CE_ORANGE_HEADER } from '../utils/brandColors';
import { MF } from '../theme/mfTokens';
import { useResearchSpaceDraft } from '../utils/useResearchSpaceData';
import { RS_STATUS } from '../utils/researchSpaceStatus';
import { KpiCard } from './mf';
import FaCompassWorkspace from './FaCompassWorkspace.jsx';
import { sideCardKpis, statusLabel } from './faCompassView';
import {
  FUNCTIONAL_CATEGORIES,
  FUNCTIONAL_CATEGORY_LABEL_BY_CODE,
  ROOM_EXCLUSION_STATUSES,
  validateFootprintWeightsSumTo100,
  computeRoomFunctionalProfile
} from '../utils/researchSpaceClassification';
import {
  ROLE_OPTIONS,
  newFundingSourceRow,
  newOccupantDraft,
  draftToFundingSourcesForValidation,
  validateOccupantDraft
} from '../utils/researchSpaceDraft';

// Shared module header color (src/utils/brandColors.js) -- this panel used
// the undarkened logo orange (#f75024) while every other module used #cb421e.
const CLARK_ENERSEN_ORANGE = CE_ORANGE_HEADER;

// Airtable numeric floor (0 = basement) -> short label.
function formatFloorLabel(floor) {
  if (floor == null) return '--';
  return Number(floor) === 0 ? 'Bsmt' : `L${floor}`;
}

function formatPct(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '--';
  return `${Math.round(n * 100) / 100}%`;
}

function formatSF(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '--';
  return `${Math.round(n).toLocaleString()} SF`;
}

// `data` is the shared useResearchSpaceData() result owned by
// StakeholderMap.jsx (also read by the floorplan color mode), so the list here
// and the map coloring can't drift apart.
//
// Selection is controlled-optional: pass `selectedRoomKey` +
// `onSelectedRoomKeyChange` and the map can open a room's editor directly
// (click-to-classify); omit them and the panel selects internally as before.
// `onJumpToFloor(room)` (optional) loads the room's floorplan floor.
// `resolveRoomFloor(room)` (optional) -> Promise<floor id | null>, used by the
// workspace to show "No floorplan" instead of a failing Show on map.
export default function ResearchSpaceClassificationPanel({
  enabled = false,
  title = 'F&A Compass',
  universityName = '',
  data,
  selectedRoomKey: controlledRoomKey,
  onSelectedRoomKeyChange,
  onJumpToFloor,
  resolveRoomFloor
}) {
  const {
    scopeRooms: airtableRooms,
    airtableError,
    loadError,
    reload,
    roomRows
  } = data;
  // The open room's draft lives in the hook (survives this panel unmounting).
  const { draft, openDraft, setDraft, discardDraft, saveDraft } = useResearchSpaceDraft(data);
  const selectedRoomKey = draft?.roomKey || '';
  const draftOccupants = draft ? draft.occupants : null; // null = no room open
  const draftMode = draft ? draft.mode : 'occupants'; // 'occupants' | 'vacant_unassigned' | 'ineligible_non_assignable'
  const setDraftMode = useCallback((mode) => setDraft({ mode }), [setDraft]);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState('');
  const [saveError, setSaveError] = useState('');
  const [filterText, setFilterText] = useState('');
  const [statusFilter, setStatusFilter] = useState('all'); // 'all' | 'classified' | 'remaining'
  // "Classify rooms" disclosure (room list + editor).
  const [classifyOpen, setClassifyOpen] = useState(false);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const rootRef = useRef(null);

  // Picking a room (list or map click) opens the disclosure so the editor
  // is visible; closing it by hand afterwards is left alone.
  useEffect(() => {
    if (selectedRoomKey) setClassifyOpen(true);
  }, [selectedRoomKey]);

  const filteredRoomRows = useMemo(() => {
    const text = filterText.trim().toLowerCase();
    return roomRows.filter((r) => {
      if (statusFilter === 'classified' && !r.isClassified) return false;
      if (statusFilter === 'remaining' && r.isClassified) return false;
      if (!text) return true;
      return r.building.toLowerCase().includes(text) || r.room.toLowerCase().includes(text);
    });
  }, [roomRows, filterText, statusFilter]);

  const selectedRoom = roomRows.find((r) => r.roomKey === selectedRoomKey) || null;

  const openRoom = useCallback((room) => {
    openDraft(room.roomKey);
    onSelectedRoomKeyChange?.(room.roomKey);
    setSaveMessage('');
    setSaveError('');
  }, [openDraft, onSelectedRoomKeyChange]);

  const closeRoom = useCallback(() => {
    discardDraft();
    onSelectedRoomKeyChange?.('');
    setSaveMessage('');
    setSaveError('');
  }, [discardDraft, onSelectedRoomKeyChange]);

  // Parent-driven selection (map click). Acts only when the parent's key
  // actually changes -- not on every render or remount -- and only when it
  // differs from the room already open, so a remount (panel collapsed and
  // re-expanded) or a snapshot-driven identity change can never re-open the
  // room and clobber an in-progress draft. On mount the "previous" key is the
  // open draft's room, so a map click made while the panel was unmounted
  // still opens that room.
  const lastControlledKeyRef = useRef(selectedRoomKey);
  useEffect(() => {
    if (controlledRoomKey === undefined) return;
    if (controlledRoomKey === lastControlledKeyRef.current) return;
    if (!controlledRoomKey) {
      lastControlledKeyRef.current = controlledRoomKey;
      if (selectedRoomKey) closeRoom();
      return;
    }
    if (controlledRoomKey === selectedRoomKey) {
      lastControlledKeyRef.current = controlledRoomKey;
      return;
    }
    const room = roomRows.find((r) => r.roomKey === controlledRoomKey);
    if (!room) return; // scope still loading -- try again when roomRows arrives
    lastControlledKeyRef.current = controlledRoomKey;
    openRoom(room);
    try { rootRef.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' }); } catch {}
  }, [controlledRoomKey, selectedRoomKey, roomRows, openRoom, closeRoom]);

  // Every draft edit goes through setDraft (the hook's store).
  const updateOccupants = useCallback((mapOccupants) => {
    setDraft((prev) => ({ occupants: mapOccupants(prev.occupants || []) }));
  }, [setDraft]);

  const updateOccupant = useCallback((draftId, patch) => {
    updateOccupants((list) => list.map((o) => (o._draftId === draftId ? { ...o, ...patch } : o)));
  }, [updateOccupants]);

  const updateFundingSourceRow = useCallback((draftId, rowIndex, patch) => {
    updateOccupants((list) => list.map((o) => {
      if (o._draftId !== draftId) return o;
      const fundingSources = o.fundingSources.map((row, idx) => (idx === rowIndex ? { ...row, ...patch } : row));
      return { ...o, fundingSources };
    }));
  }, [updateOccupants]);

  const addFundingSourceRow = useCallback((draftId) => {
    updateOccupants((list) => list.map((o) => (
      o._draftId === draftId ? { ...o, fundingSources: [...o.fundingSources, newFundingSourceRow()] } : o
    )));
  }, [updateOccupants]);

  const removeFundingSourceRow = useCallback((draftId, rowIndex) => {
    updateOccupants((list) => list.map((o) => {
      if (o._draftId !== draftId) return o;
      const fundingSources = o.fundingSources.filter((_, idx) => idx !== rowIndex);
      return { ...o, fundingSources: fundingSources.length ? fundingSources : [newFundingSourceRow()] };
    }));
  }, [updateOccupants]);

  const addOccupant = useCallback(() => {
    updateOccupants((list) => [...list, newOccupantDraft()]);
  }, [updateOccupants]);

  const removeOccupant = useCallback((draftId) => {
    updateOccupants((list) => list.filter((o) => o._draftId !== draftId));
  }, [updateOccupants]);

  // Live validation of the draft, recomputed every render off current draft
  // state -- both Golden Rules plus the Instruction Default guardrail, all
  // enforced before Save is enabled, not just suggested.
  const occupantValidations = useMemo(() => {
    if (draftMode !== 'occupants' || !draftOccupants) return [];
    return draftOccupants.map((o) => ({ draftId: o._draftId, messages: validateOccupantDraft(o) }));
  }, [draftMode, draftOccupants]);

  const footprintWeightCheck = useMemo(() => {
    if (draftMode !== 'occupants' || !draftOccupants) return { valid: true, total: 0 };
    return validateFootprintWeightsSumTo100(draftOccupants.map((o) => ({ footprintWeight: Number(o.footprintWeight) })));
  }, [draftMode, draftOccupants]);

  const allOccupantsValid = occupantValidations.every((v) => v.messages.length === 0);
  const canSaveOccupants = draftMode === 'occupants' && allOccupantsValid && footprintWeightCheck.valid && draftOccupants && draftOccupants.length > 0;

  const livePreviewProfile = useMemo(() => {
    if (draftMode !== 'occupants' || !draftOccupants || !canSaveOccupants) return null;
    const occupantsForCalc = draftOccupants.map((o) => ({
      footprintWeight: Number(o.footprintWeight),
      fundingSources: draftToFundingSourcesForValidation(o)
    }));
    return computeRoomFunctionalProfile(occupantsForCalc);
  }, [draftMode, draftOccupants, canSaveOccupants]);

  // Writes happen in the hook (saveDraft); this only shows the outcome.
  const handleSave = useCallback(async () => {
    if (!selectedRoom || saving) return;
    setSaving(true);
    setSaveMessage('');
    setSaveError('');
    try {
      setSaveMessage(await saveDraft());
    } catch (error) {
      setSaveError(String(error?.message || 'Failed to save.'));
    } finally {
      setSaving(false);
    }
  }, [selectedRoom, saving, saveDraft]);

  if (!enabled) return null;

  return (
    <div
      ref={rootRef}
      className="control-section"
      style={{
        background: '#fff',
        padding: 8,
        border: '1px solid #d8e0ea',
        borderRadius: 6,
        marginTop: 6,
        display: 'flex',
        flexDirection: 'column',
        height: '100%'
      }}
    >
      <h4 style={{ margin: '0 0 6px 0', padding: '6px 8px', fontSize: 12.5, fontWeight: 700, color: '#fff', background: CLARK_ENERSEN_ORANGE, borderRadius: 6 }}>
        {title}
      </h4>

      {loadError && <div style={{ color: '#b42318', fontSize: 12, marginBottom: 6 }}>{loadError}</div>}
      {airtableError && (
        <div style={{ color: '#b42318', fontSize: 12, marginBottom: 6 }}>
          {airtableError}{' '}
          {typeof reload === 'function' && (
            <button type="button" onClick={reload} style={{ fontSize: 12, padding: '0 6px' }}>Retry</button>
          )}
        </div>
      )}

      {/* Summary: the two headline figures + the workspace. */}
      <div style={{ display: 'flex', gap: 8 }}>
        {sideCardKpis(data).map(({ key, ...props }) => (
          <div key={key} style={{ flex: 1, minWidth: 0 }}>
            <KpiCard {...props} compact />
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={() => setWorkspaceOpen(true)}
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
          cursor: 'pointer'
        }}
      >
        Open F&amp;A Compass
      </button>
      {workspaceOpen ? (
        <FaCompassWorkspace
          data={data}
          universityName={universityName}
          onJumpToFloor={onJumpToFloor}
          resolveRoomFloor={resolveRoomFloor}
          onClose={() => setWorkspaceOpen(false)}
        />
      ) : null}

      <details open={classifyOpen} onToggle={(e) => setClassifyOpen(e.currentTarget.open)} style={{ marginTop: 10 }}>
        <summary style={{ cursor: 'pointer', fontSize: 12.5, fontWeight: 600, color: MF.ink.primary, marginBottom: 6 }}>
          Classify rooms
        </summary>

      {/* Room list */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
        <input
          type="text"
          placeholder="Filter by building or room..."
          value={filterText}
          onChange={(e) => setFilterText(e.target.value)}
          style={{ flex: '1 1 200px', padding: '4px 6px', fontSize: 12, border: '1px solid #cbd5e1', borderRadius: 4 }}
        />
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} style={{ padding: '4px 6px', fontSize: 12, border: '1px solid #cbd5e1', borderRadius: 4 }}>
          <option value="all">All rooms</option>
          <option value="classified">Classified only</option>
          <option value="remaining">Remaining only</option>
        </select>
      </div>

      {airtableRooms === null ? (
        <div style={{ fontSize: 12, color: '#64748b' }}>Loading room inventory...</div>
      ) : (
        <div style={{ maxHeight: 320, overflowY: 'auto', border: '1px solid #e2e8f0', borderRadius: 6 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11.5 }}>
            <thead style={{ position: 'sticky', top: 0, background: '#f8fafc' }}>
              <tr style={{ textAlign: 'left', borderBottom: '1px solid #e2e8f0' }}>
                <th style={{ padding: '4px 6px' }}>Building</th>
                <th style={{ padding: '4px 6px' }}>Room</th>
                <th style={{ padding: '4px 6px' }}>Floor</th>
                <th style={{ padding: '4px 6px' }}>Type</th>
                <th style={{ padding: '4px 6px' }}>Status</th>
                <th style={{ padding: '4px 6px' }}></th>
              </tr>
            </thead>
            <tbody>
              {filteredRoomRows.map((room) => {
                const roomStatusLabel = statusLabel(room.status);
                return (
                  <tr key={room.roomKey} style={{ borderBottom: '1px solid #f1f5f9', background: selectedRoomKey === room.roomKey ? '#fff7ed' : undefined }}>
                    <td style={{ padding: '4px 6px' }}>{room.building}</td>
                    <td style={{ padding: '4px 6px' }}>{room.room}</td>
                    <td style={{ padding: '4px 6px', whiteSpace: 'nowrap' }}>
                      {formatFloorLabel(room.floor)}
                      {onJumpToFloor && room.folder && room.floor != null ? (
                        <button
                          type="button"
                          title="Load this floor on the map"
                          onClick={() => onJumpToFloor(room)}
                          style={{ marginLeft: 4, fontSize: 10.5, padding: '1px 5px', cursor: 'pointer' }}
                        >
                          Map
                        </button>
                      ) : null}
                    </td>
                    <td style={{ padding: '4px 6px', color: '#64748b' }}>{room.source === 'lab' ? 'Lab' : 'Office'}</td>
                    <td style={{ padding: '4px 6px', color: room.status === RS_STATUS.NOT_STARTED ? MF.ink.muted : MF.ink.primary }}>{roomStatusLabel}</td>
                    <td style={{ padding: '4px 6px' }}>
                      <button type="button" onClick={() => openRoom(room)} style={{ fontSize: 11, padding: '2px 8px', cursor: 'pointer' }}>
                        {room.isClassified ? 'Edit' : 'Classify'}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Room detail editor */}
      {selectedRoom && draftOccupants && (
        <div style={{ marginTop: 10, border: '1px solid #fed7aa', borderRadius: 6, padding: 8, background: '#fffbf5' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <div style={{ fontSize: 13, fontWeight: 700 }}>{selectedRoom.building} -- {selectedRoom.room} <span style={{ fontWeight: 400, color: '#64748b' }}>({formatSF(selectedRoom.areaSF)})</span></div>
            <button type="button" onClick={closeRoom} style={{ fontSize: 11, padding: '2px 8px', cursor: 'pointer' }}>Close</button>
          </div>

          <div style={{ marginBottom: 8 }}>
            <label style={{ fontSize: 11.5, fontWeight: 600, marginRight: 8 }}>Classification mode:</label>
            <select value={draftMode} onChange={(e) => setDraftMode(e.target.value)} style={{ fontSize: 12, padding: '3px 6px' }}>
              <option value="occupants">Occupant-based (funding source split)</option>
              {ROOM_EXCLUSION_STATUSES.map((s) => (
                <option key={s.code} value={s.code}>{s.label}</option>
              ))}
            </select>
          </div>

          {draftMode === 'occupants' && (
            <>
              {draftOccupants.map((occupant, occIdx) => {
                const validation = occupantValidations.find((v) => v.draftId === occupant._draftId);
                const rowSum = draftToFundingSourcesForValidation(occupant).reduce((s, r) => s + (Number.isFinite(r.percentage) ? r.percentage : 0), 0);
                return (
                  <div key={occupant._draftId} style={{ border: '1px solid #e2e8f0', borderRadius: 6, padding: 8, marginBottom: 8, background: '#fff' }}>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 6 }}>
                      <input
                        type="text"
                        placeholder="Occupant name"
                        value={occupant.occupantName}
                        onChange={(e) => updateOccupant(occupant._draftId, { occupantName: e.target.value })}
                        style={{ flex: '1 1 160px', padding: '4px 6px', fontSize: 12, border: '1px solid #cbd5e1', borderRadius: 4 }}
                      />
                      <select
                        value={occupant.role}
                        onChange={(e) => updateOccupant(occupant._draftId, { role: e.target.value })}
                        style={{ padding: '4px 6px', fontSize: 12 }}
                      >
                        {ROLE_OPTIONS.map((r) => <option key={r} value={r}>{r}</option>)}
                      </select>
                      <label style={{ fontSize: 11.5 }}>
                        Footprint weight:{' '}
                        <input
                          type="number"
                          value={occupant.footprintWeight}
                          onChange={(e) => updateOccupant(occupant._draftId, { footprintWeight: e.target.value })}
                          style={{ width: 60, padding: '4px 6px', fontSize: 12, border: '1px solid #cbd5e1', borderRadius: 4 }}
                        />%
                      </label>
                      <button type="button" onClick={() => removeOccupant(occupant._draftId)} style={{ fontSize: 11, padding: '2px 8px', cursor: 'pointer', marginLeft: 'auto' }}>
                        Remove occupant
                      </button>
                    </div>

                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11.5, marginBottom: 4 }}>
                      <thead>
                        <tr style={{ textAlign: 'left' }}>
                          <th style={{ padding: '2px 4px' }}>Funding source</th>
                          <th style={{ padding: '2px 4px' }}>%</th>
                          <th style={{ padding: '2px 4px' }}>Functional category</th>
                          <th style={{ padding: '2px 4px' }}></th>
                        </tr>
                      </thead>
                      <tbody>
                        {occupant.fundingSources.map((row, rowIdx) => (
                          <tr key={rowIdx}>
                            <td style={{ padding: '2px 4px' }}>
                              <input
                                type="text"
                                placeholder="e.g. NSF Grant, Institutional"
                                value={row.source}
                                onChange={(e) => updateFundingSourceRow(occupant._draftId, rowIdx, { source: e.target.value })}
                                style={{ width: '100%', padding: '3px 5px', fontSize: 11.5, border: '1px solid #cbd5e1', borderRadius: 4 }}
                              />
                            </td>
                            <td style={{ padding: '2px 4px' }}>
                              <input
                                type="number"
                                value={row.percentage}
                                onChange={(e) => updateFundingSourceRow(occupant._draftId, rowIdx, { percentage: e.target.value })}
                                style={{ width: 55, padding: '3px 5px', fontSize: 11.5, border: '1px solid #cbd5e1', borderRadius: 4 }}
                              />
                            </td>
                            <td style={{ padding: '2px 4px' }}>
                              <select
                                value={row.category}
                                onChange={(e) => updateFundingSourceRow(occupant._draftId, rowIdx, { category: e.target.value })}
                                style={{ padding: '3px 5px', fontSize: 11.5 }}
                              >
                                <option value="">Select...</option>
                                {FUNCTIONAL_CATEGORIES.map((cat) => (
                                  <option key={cat.code} value={cat.code}>{cat.label}</option>
                                ))}
                              </select>
                            </td>
                            <td style={{ padding: '2px 4px' }}>
                              <button type="button" onClick={() => removeFundingSourceRow(occupant._draftId, rowIdx)} style={{ fontSize: 10.5, padding: '1px 6px', cursor: 'pointer' }}>x</button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <button type="button" onClick={() => addFundingSourceRow(occupant._draftId)} style={{ fontSize: 11, padding: '2px 8px', cursor: 'pointer' }}>+ Add funding source</button>
                    <span style={{ marginLeft: 10, fontSize: 11, color: Math.abs(rowSum - 100) <= 0.01 ? '#166534' : '#b42318' }}>
                      Sum: {Math.round(rowSum * 100) / 100}% {Math.abs(rowSum - 100) <= 0.01 ? '(OK)' : '(must equal 100%)'}
                    </span>

                    {validation && validation.messages.length > 0 && (
                      <ul style={{ margin: '6px 0 0 0', paddingLeft: 18, color: '#b42318', fontSize: 11 }}>
                        {validation.messages.map((m, i) => <li key={i}>{m}</li>)}
                      </ul>
                    )}
                  </div>
                );
              })}

              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <button type="button" onClick={addOccupant} style={{ fontSize: 11.5, padding: '3px 10px', cursor: 'pointer' }}>+ Add occupant</button>
                <span style={{ fontSize: 11.5, color: footprintWeightCheck.valid ? '#166534' : '#b42318' }}>
                  Footprint weight total: {footprintWeightCheck.total}% {footprintWeightCheck.valid ? '(OK)' : '(must equal 100%)'}
                </span>
              </div>

              {livePreviewProfile && (
                <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 6, padding: 8, marginBottom: 8 }}>
                  <div style={{ fontSize: 11.5, fontWeight: 700, marginBottom: 4, color: '#14532d' }}>Computed blended room profile</div>
                  {Object.entries(livePreviewProfile.categoryPercentages).map(([code, pct]) => (
                    <div key={code} style={{ fontSize: 11.5 }}>{FUNCTIONAL_CATEGORY_LABEL_BY_CODE[code] || code}: {formatPct(pct)}</div>
                  ))}
                  <div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>Total: {formatPct(livePreviewProfile.totalPercent)}</div>
                </div>
              )}
            </>
          )}

          {draftMode !== 'occupants' && (
            <div style={{ fontSize: 12, color: '#64748b', marginBottom: 8 }}>
              Saving will remove any existing occupants for this room and mark it {ROOM_EXCLUSION_STATUSES.find((s) => s.code === draftMode)?.label} instead.
            </div>
          )}

          <button
            type="button"
            onClick={handleSave}
            disabled={saving || (draftMode === 'occupants' && !canSaveOccupants)}
            style={{ fontSize: 12.5, fontWeight: 600, padding: '5px 14px', cursor: saving ? 'default' : 'pointer' }}
          >
            {saving ? 'Saving...' : 'Save'}
          </button>
          {saveMessage && <span style={{ marginLeft: 10, fontSize: 11.5, color: '#166534' }}>{saveMessage}</span>}
          {saveError && <span style={{ marginLeft: 10, fontSize: 11.5, color: '#b42318' }}>{saveError}</span>}
        </div>
      )}
      </details>
    </div>
  );
}
