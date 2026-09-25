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
// Room scope: the 342-room Lab+Office universe from researchSpaceRoomScope.js
// (275 Office + 67 Lab, confirmed 2026-09-17 against live Airtable data,
// broad "all Laboratory - * / Office - * subtypes" interpretation per
// Clark's explicit decision).
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { collection, deleteDoc, doc, serverTimestamp, setDoc, writeBatch } from 'firebase/firestore';
import { db } from '../firebaseConfig';
import {
  HASTINGS_UNIVERSITY_ID,
  RESEARCH_SPACE_OCCUPANTS_COLLECTION,
  RESEARCH_SPACE_ROOM_STATUS_COLLECTION
} from '../utils/useResearchSpaceData';
import {
  FUNCTIONAL_CATEGORIES,
  FUNCTIONAL_CATEGORY_LABEL_BY_CODE,
  ROOM_EXCLUSION_STATUSES,
  validateFundingSourcesSumTo100,
  validateFootprintWeightsSumTo100,
  validateInstructionDefaultRule,
  computeRoomFunctionalProfile,
  computeResearchSpaceRollup
} from '../utils/researchSpaceClassification';

const BATCH_CHUNK_SIZE = 400; // mirrors the existing writeBatch chunking convention elsewhere in this codebase

// Sampled directly from public/Data/Clark_Enersen_Logo.png -- same constant,
// duplicated identically, as every other panel in this codebase (not
// imported from a shared location, matching existing convention).
const CLARK_ENERSEN_ORANGE = '#f75024';

const ROLE_OPTIONS = ['PI', 'Postdoc', 'Grad Student', 'Staff', 'Other'];

function newFundingSourceRow() {
  return { source: '', percentage: '', category: '' };
}

function newOccupantDraft() {
  return {
    _draftId: `new_${Math.random().toString(36).slice(2)}`,
    id: null, // Firestore doc id -- null until first save
    occupantName: '',
    role: ROLE_OPTIONS[0],
    footprintWeight: '',
    fundingSources: [newFundingSourceRow()]
  };
}

function occupantDocToDraft(docSnap) {
  const data = docSnap.data() || {};
  return {
    _draftId: docSnap.id,
    id: docSnap.id,
    occupantName: data.occupantName || '',
    role: data.role || ROLE_OPTIONS[0],
    footprintWeight: data.footprintWeight != null ? String(data.footprintWeight) : '',
    fundingSources: Array.isArray(data.fundingSources) && data.fundingSources.length
      ? data.fundingSources.map((row) => ({
          source: row?.source || '',
          percentage: row?.percentage != null ? String(row.percentage) : '',
          category: row?.category || ''
        }))
      : [newFundingSourceRow()]
  };
}

function draftToFundingSourcesForValidation(occupant) {
  return (occupant.fundingSources || []).map((row) => ({
    source: row.source,
    percentage: Number(row.percentage),
    category: row.category
  }));
}

// Full validation for one occupant draft -- both rules that apply within a
// single occupant. Returns null when valid, else a list of human messages.
function validateOccupantDraft(occupant) {
  const messages = [];
  if (!String(occupant.occupantName || '').trim()) messages.push('Occupant name is required.');
  const weight = Number(occupant.footprintWeight);
  if (!Number.isFinite(weight) || weight <= 0 || weight > 100) messages.push('Footprint weight must be a number between 0 and 100.');
  const rows = draftToFundingSourcesForValidation(occupant);
  if (!rows.length) messages.push('At least one funding source row is required.');
  rows.forEach((row, idx) => {
    if (!row.category) messages.push(`Row ${idx + 1}: a functional category must be selected.`);
    if (!Number.isFinite(row.percentage) || row.percentage < 0) messages.push(`Row ${idx + 1}: percentage must be a non-negative number.`);
  });
  const sumCheck = validateFundingSourcesSumTo100(rows);
  if (!sumCheck.valid) messages.push(`Funding source percentages must sum to exactly 100% (currently ${sumCheck.total}%).`);
  const instructionDefault = validateInstructionDefaultRule(rows);
  if (!instructionDefault.valid) instructionDefault.errors.forEach((e) => messages.push(e.message));
  return messages;
}

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
export default function ResearchSpaceClassificationPanel({
  enabled = false,
  title = 'F&A Compass',
  data,
  selectedRoomKey: controlledRoomKey,
  onSelectedRoomKeyChange,
  onJumpToFloor
}) {
  const {
    scopeRooms: airtableRooms,
    airtableError,
    loadError,
    reload,
    occupantsByRoomKey,
    roomStatusDocs,
    roomRows
  } = data;
  const [selectedRoomKey, setSelectedRoomKey] = useState('');
  const [draftOccupants, setDraftOccupants] = useState(null); // null = no room selected / not yet loaded into draft
  const [draftMode, setDraftMode] = useState('occupants'); // 'occupants' | 'vacant_unassigned' | 'ineligible_non_assignable'
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState('');
  const [saveError, setSaveError] = useState('');
  const [filterText, setFilterText] = useState('');
  const [statusFilter, setStatusFilter] = useState('all'); // 'all' | 'classified' | 'remaining'
  const [sectionOpen, setSectionOpen] = useState(true);
  const rootRef = useRef(null);

  const occupantsCollection = useMemo(
    () => collection(db, 'universities', HASTINGS_UNIVERSITY_ID, RESEARCH_SPACE_OCCUPANTS_COLLECTION),
    []
  );
  const roomStatusCollection = useMemo(
    () => collection(db, 'universities', HASTINGS_UNIVERSITY_ID, RESEARCH_SPACE_ROOM_STATUS_COLLECTION),
    []
  );

  const rollup = useMemo(() => {
    const entries = roomRows.map((r) => ({
      roomKey: r.roomKey,
      areaSF: r.areaSF,
      occupants: (occupantsByRoomKey.get(r.roomKey) || []).map((d) => d.data()),
      exclusionStatus: r.exclusionStatus
    }));
    return computeResearchSpaceRollup(entries);
  }, [roomRows, occupantsByRoomKey]);

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
    setSelectedRoomKey(room.roomKey);
    onSelectedRoomKeyChange?.(room.roomKey);
    setSaveMessage('');
    setSaveError('');
    const existingDocs = occupantsByRoomKey.get(room.roomKey) || [];
    const status = roomStatusDocs[room.roomKey] || '';
    setDraftMode(status || 'occupants');
    setDraftOccupants(existingDocs.length ? existingDocs.map(occupantDocToDraft) : [newOccupantDraft()]);
  }, [occupantsByRoomKey, roomStatusDocs, onSelectedRoomKeyChange]);

  const closeRoom = useCallback(() => {
    setSelectedRoomKey('');
    onSelectedRoomKeyChange?.('');
    setDraftOccupants(null);
    setSaveMessage('');
    setSaveError('');
  }, [onSelectedRoomKeyChange]);

  // Parent-driven selection (map click). Only acts when the parent's key
  // differs from what's already open, so a snapshot-driven openRoom identity
  // change can never re-open the room and clobber an in-progress draft.
  useEffect(() => {
    if (controlledRoomKey === undefined || controlledRoomKey === selectedRoomKey) return;
    if (!controlledRoomKey) { closeRoom(); return; }
    const room = roomRows.find((r) => r.roomKey === controlledRoomKey);
    if (!room) return;
    openRoom(room);
    try { rootRef.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' }); } catch {}
  }, [controlledRoomKey, selectedRoomKey, roomRows, openRoom, closeRoom]);

  const updateOccupant = useCallback((draftId, patch) => {
    setDraftOccupants((prev) => (prev || []).map((o) => (o._draftId === draftId ? { ...o, ...patch } : o)));
  }, []);

  const updateFundingSourceRow = useCallback((draftId, rowIndex, patch) => {
    setDraftOccupants((prev) => (prev || []).map((o) => {
      if (o._draftId !== draftId) return o;
      const fundingSources = o.fundingSources.map((row, idx) => (idx === rowIndex ? { ...row, ...patch } : row));
      return { ...o, fundingSources };
    }));
  }, []);

  const addFundingSourceRow = useCallback((draftId) => {
    setDraftOccupants((prev) => (prev || []).map((o) => (
      o._draftId === draftId ? { ...o, fundingSources: [...o.fundingSources, newFundingSourceRow()] } : o
    )));
  }, []);

  const removeFundingSourceRow = useCallback((draftId, rowIndex) => {
    setDraftOccupants((prev) => (prev || []).map((o) => {
      if (o._draftId !== draftId) return o;
      const fundingSources = o.fundingSources.filter((_, idx) => idx !== rowIndex);
      return { ...o, fundingSources: fundingSources.length ? fundingSources : [newFundingSourceRow()] };
    }));
  }, []);

  const addOccupant = useCallback(() => {
    setDraftOccupants((prev) => [...(prev || []), newOccupantDraft()]);
  }, []);

  const removeOccupant = useCallback((draftId) => {
    setDraftOccupants((prev) => (prev || []).filter((o) => o._draftId !== draftId));
  }, []);

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

  const handleSave = useCallback(async () => {
    if (!selectedRoom || saving) return;
    setSaving(true);
    setSaveMessage('');
    setSaveError('');
    try {
      const roomKey = selectedRoom.roomKey;
      const roomStatusRef = doc(roomStatusCollection, roomKey);
      const existingDocs = occupantsByRoomKey.get(roomKey) || [];

      if (draftMode !== 'occupants') {
        // Exclusion state: write the status doc, delete every existing
        // occupant for this room (mutually exclusive by design).
        await setDoc(roomStatusRef, { status: draftMode, updatedAt: serverTimestamp() });
        for (let i = 0; i < existingDocs.length; i += BATCH_CHUNK_SIZE) {
          const chunk = existingDocs.slice(i, i + BATCH_CHUNK_SIZE);
          const batch = writeBatch(db);
          chunk.forEach((docSnap) => batch.delete(docSnap.ref));
          await batch.commit();
        }
        setSaveMessage(`Saved as ${ROOM_EXCLUSION_STATUSES.find((s) => s.code === draftMode)?.label || draftMode}.`);
      } else {
        if (!canSaveOccupants) throw new Error('Fix the validation errors above before saving.');
        await deleteDoc(roomStatusRef).catch(() => {}); // clears any prior exclusion status; no-op if none exists

        const existingIds = new Set(existingDocs.map((d) => d.id));
        const keptIds = new Set(draftOccupants.filter((o) => o.id).map((o) => o.id));
        const removedIds = [...existingIds].filter((id) => !keptIds.has(id));

        const batch = writeBatch(db);
        draftOccupants.forEach((o) => {
          const ref = o.id ? doc(occupantsCollection, o.id) : doc(occupantsCollection);
          batch.set(ref, {
            roomKey,
            occupantName: o.occupantName.trim(),
            role: o.role,
            footprintWeight: Number(o.footprintWeight),
            fundingSources: o.fundingSources.map((row) => ({
              source: row.source.trim(),
              percentage: Number(row.percentage),
              category: row.category
            })),
            updatedAt: serverTimestamp(),
            ...(o.id ? {} : { createdAt: serverTimestamp() })
          }, { merge: true });
        });
        removedIds.forEach((id) => batch.delete(doc(occupantsCollection, id)));
        await batch.commit();
        setSaveMessage(`Saved ${draftOccupants.length} occupant${draftOccupants.length === 1 ? '' : 's'}.`);
      }
    } catch (error) {
      setSaveError(String(error?.message || 'Failed to save.'));
    } finally {
      setSaving(false);
    }
  }, [selectedRoom, saving, draftMode, draftOccupants, canSaveOccupants, occupantsByRoomKey, occupantsCollection, roomStatusCollection]);

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

      {/* Rollup summary -- always visible, this is the headline F&A figure. */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 10 }}>
        <div style={{ flex: '1 1 160px', background: '#fff7ed', border: '1px solid #fed7aa', borderRadius: 6, padding: 8 }}>
          <div style={{ fontSize: 10.5, color: '#9a3412', fontWeight: 700, textTransform: 'uppercase' }}>Total Organized Research SF</div>
          <div style={{ fontSize: 20, fontWeight: 700, color: '#7c2d12' }}>{formatSF(rollup.totalOrganizedResearchSF)}</div>
        </div>
        <div style={{ flex: '1 1 120px', background: '#f0f9ff', border: '1px solid #bae6fd', borderRadius: 6, padding: 8 }}>
          <div style={{ fontSize: 10.5, color: '#075985', fontWeight: 700, textTransform: 'uppercase' }}>Rooms in scope</div>
          <div style={{ fontSize: 20, fontWeight: 700, color: '#0c4a6e' }}>{rollup.roomCountInScope}</div>
        </div>
        <div style={{ flex: '1 1 120px', background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 6, padding: 8 }}>
          <div style={{ fontSize: 10.5, color: '#166534', fontWeight: 700, textTransform: 'uppercase' }}>Classified</div>
          <div style={{ fontSize: 20, fontWeight: 700, color: '#14532d' }}>{rollup.roomCountClassified}</div>
        </div>
        <div style={{ flex: '1 1 120px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 6, padding: 8 }}>
          <div style={{ fontSize: 10.5, color: '#991b1b', fontWeight: 700, textTransform: 'uppercase' }}>Remaining</div>
          <div style={{ fontSize: 20, fontWeight: 700, color: '#7f1d1d' }}>{rollup.roomCountRemaining}</div>
        </div>
      </div>

      <details open={sectionOpen} onToggle={(e) => setSectionOpen(e.currentTarget.open)}>
        <summary style={{ cursor: 'pointer', fontSize: 12.5, fontWeight: 600, marginBottom: 6 }}>
          Category breakdown ({Object.keys(rollup.categoryTotalsSF).length} categor{Object.keys(rollup.categoryTotalsSF).length === 1 ? 'y' : 'ies'} in use, {formatSF(rollup.knownAreaSF)} known area)
        </summary>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11.5, marginBottom: 10 }}>
          <thead>
            <tr style={{ textAlign: 'left', borderBottom: '1px solid #e2e8f0' }}>
              <th style={{ padding: '3px 6px' }}>Category</th>
              <th style={{ padding: '3px 6px' }}>SF</th>
              <th style={{ padding: '3px 6px' }}>% of known area</th>
            </tr>
          </thead>
          <tbody>
            {FUNCTIONAL_CATEGORIES.map((cat) => {
              const sf = rollup.categoryTotalsSF[cat.code] || 0;
              const pctOfKnown = rollup.knownAreaSF > 0 ? (sf / rollup.knownAreaSF) * 100 : 0;
              if (!sf) return null;
              return (
                <tr key={cat.code} style={{ borderBottom: '1px solid #f1f5f9' }}>
                  <td style={{ padding: '3px 6px' }}>{cat.label}</td>
                  <td style={{ padding: '3px 6px' }}>{formatSF(sf)}</td>
                  <td style={{ padding: '3px 6px' }}>{formatPct(pctOfKnown)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </details>

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
                const statusLabel = room.exclusionStatus
                  ? ROOM_EXCLUSION_STATUSES.find((s) => s.code === room.exclusionStatus)?.label
                  : room.occupantCount > 0
                    ? `${room.occupantCount} occupant${room.occupantCount === 1 ? '' : 's'}`
                    : 'Not started';
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
                    <td style={{ padding: '4px 6px', color: room.isClassified ? '#166534' : '#94a3b8' }}>{statusLabel}</td>
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
    </div>
  );
}
