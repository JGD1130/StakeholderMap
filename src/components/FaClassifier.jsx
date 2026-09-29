// src/components/FaClassifier.jsx
//
// F&A Compass docked Classifier: replaces the right-rail content while
// "Classify on map" is on (StakeholderMap.jsx), so the map stays clickable.
// Clicking an in-scope room on the map (or "Show on map" in the workspace, or
// "Next not started on this floor") opens it here.
//
// All data and writes go through useResearchSpaceData's draft API
// (useResearchSpaceDraft): the draft survives this component unmounting, and
// saveDraft does the Firestore writes. Validation messages appear after Save
// or once a field in that occupant loses focus -- not on every keystroke.
// Switching rooms or pressing Done with unsaved changes asks first.
//
// Props:
//   data            useResearchSpaceData result
//   selectedRoomKey StakeholderMap's selected F&A room (map click, jump)
//   onSelectRoom(roomKey)  select + highlight a room on the map
//   onDone()        leave classify mode
//   demo            client presentation mode: saves stay in the hook's
//                   in-memory overlay (useResearchSpaceData demoMode)
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MF } from '../theme/mfTokens';
import { CE_ORANGE_HEADER } from '../utils/brandColors';
import { WorkspaceShell } from './mf';
import { mfInputStyle, mfPrimaryButtonStyle, mfSecondaryButtonStyle, mfPillStyle } from './mf/mfStyles';
import { useResearchSpaceDraft } from '../utils/useResearchSpaceData';
import {
  FUNCTIONAL_CATEGORIES,
  FUNCTIONAL_CATEGORY_LABEL_BY_CODE,
  computeRoomFunctionalProfile,
  validateFootprintWeightsSumTo100
} from '../utils/researchSpaceClassification';
import { RS_STATUS, RS_STATUS_COLORS, RS_OUT_OF_SCOPE_COLOR } from '../utils/researchSpaceStatus';
import {
  CLASS_LAB_MODE,
  ROLE_OPTIONS,
  newFundingSourceRow,
  newOccupantDraft,
  draftToFundingSourcesForValidation,
  validateOccupantDraft
} from '../utils/researchSpaceDraft';
import { floorLabel, formatSf, progressKpi, statusLabel } from './faCompassView';

const MODES = [
  { value: 'occupants', label: 'Occupants' },
  { value: CLASS_LAB_MODE, label: 'Class lab (instruction)' },
  { value: 'vacant_unassigned', label: 'Vacant' },
  { value: 'ineligible_non_assignable', label: 'Ineligible' }
];

const MODE_NOTES = {
  [CLASS_LAB_MODE]: 'Saved as 100% Instruction and Departmental Research. No occupants needed.',
  vacant_unassigned: 'The room is left out of the function mix. Saving removes any occupants listed for it.',
  ineligible_non_assignable: 'The room is left out of the function mix. Saving removes any occupants listed for it.'
};

const NAMED_SOURCE_CODES = new Set(['OR', 'OSA']);

const labelStyle = { fontSize: 11, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', color: MF.ink.muted };
const noteStyle = { fontSize: 12, color: MF.ink.secondary, lineHeight: 1.45 };
const mutedStyle = { fontSize: 11, color: MF.ink.muted, lineHeight: 1.4 };
const errorStyle = { fontSize: 12, color: MF.status.error, lineHeight: 1.4 };
// Every field fills its row and never sets the dock's width (a select's
// min-content is its widest option).
const inputStyle = { ...mfInputStyle, width: '100%', minWidth: 0, maxWidth: '100%', boxSizing: 'border-box' };
const fieldLabelStyle = { display: 'block', marginTop: 6, minWidth: 0 };
const cardStyle = { border: `1px solid ${MF.line.border}`, borderRadius: 8, padding: 10, background: MF.surface.page, minWidth: 0 };
// Single-column grid whose track can shrink below its items' min-content.
const stackStyle = { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)' };

function Button({ primary = false, small = false, onClick, disabled, title, children, style }) {
  return (
    <button
      type="button"
      className="mf-shell-button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        ...(primary ? mfPrimaryButtonStyle : mfSecondaryButtonStyle),
        ...(small ? { padding: '3px 8px' } : null),
        ...(disabled ? { opacity: 0.55, cursor: 'default' } : null),
        '--mf-focus-color': MF.util.base,
        ...style
      }}
    >
      {children}
    </button>
  );
}

function DiscardDialog({ onKeep, onDiscard }) {
  return (
    <WorkspaceShell size="dialog" title="Discard unsaved changes?" onClose={onKeep}>
      <div style={{ fontSize: 13, color: MF.ink.primary, lineHeight: 1.5 }}>
        This room has changes that haven&apos;t been saved. Leaving it now discards them.
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 20 }}>
        <Button onClick={onKeep}>Keep editing</Button>
        <Button primary onClick={onDiscard}>Discard changes</Button>
      </div>
    </WorkspaceShell>
  );
}

// Legend for the empty state, same colors as the map.
function StatusLegend() {
  const items = [
    ...[RS_STATUS.NOT_STARTED, RS_STATUS.CLASSIFIED, RS_STATUS.EXCLUDED].map((s) => ({ key: s, label: statusLabel(s), color: RS_STATUS_COLORS[s] })),
    { key: 'out', label: 'Not in scope', color: RS_OUT_OF_SCOPE_COLOR }
  ];
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, fontSize: 11, color: MF.ink.muted }}>
      {items.map((item) => (
        <span key={item.key}>
          <span aria-hidden="true" style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 2, background: item.color, border: `1px solid ${MF.line.border}`, marginRight: 5, verticalAlign: '-1px' }} />
          {item.label}
        </span>
      ))}
    </div>
  );
}

// Small function-mix preview: one thin bar per function with a share.
function MixPreview({ mode, occupants }) {
  let profile = null;
  if (mode === CLASS_LAB_MODE) {
    profile = { categoryPercentages: { IDR: 100 }, totalPercent: 100 };
  } else if (mode === 'occupants') {
    profile = computeRoomFunctionalProfile((occupants || []).map((o) => ({
      footprintWeight: Number(o.footprintWeight) || 0,
      fundingSources: draftToFundingSourcesForValidation(o).filter((r) => r.category && Number.isFinite(r.percentage))
    })));
  }
  const entries = profile
    ? Object.entries(profile.categoryPercentages).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1])
    : [];
  return (
    <div>
      <div style={labelStyle}>Function mix</div>
      {!profile ? (
        <div style={{ ...mutedStyle, marginTop: 4 }}>Excluded rooms aren&apos;t part of the function mix.</div>
      ) : !entries.length ? (
        <div style={{ ...mutedStyle, marginTop: 4 }}>Add occupants and funding to see the mix.</div>
      ) : (
        <div style={{ marginTop: 6, display: 'grid', gap: 5 }}>
          {entries.map(([code, pct]) => (
            <div key={code}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 12, color: MF.ink.secondary }}>
                <span>{FUNCTIONAL_CATEGORY_LABEL_BY_CODE[code] || code}</span>
                <span style={{ fontVariantNumeric: 'tabular-nums', color: MF.ink.primary, fontWeight: 600 }}>{Math.round(pct * 10) / 10}%</span>
              </div>
              <div style={{ height: 5, borderRadius: 3, background: MF.line.hairline, overflow: 'hidden', marginTop: 2 }}>
                <div style={{ width: `${Math.max(0, Math.min(100, pct))}%`, height: '100%', background: MF.util.base }} />
              </div>
            </div>
          ))}
          {Math.abs(profile.totalPercent - 100) > 0.01 ? (
            <div style={mutedStyle}>Adds up to {Math.round(profile.totalPercent * 10) / 10}% so far.</div>
          ) : null}
        </div>
      )}
    </div>
  );
}

function OccupantCard({ occupant, index, showErrors, onChange, onRowChange, onAddRow, onRemoveRow, onRemove, onTouched }) {
  const messages = showErrors ? validateOccupantDraft(occupant) : [];
  const roles = ROLE_OPTIONS.includes(occupant.role) ? ROLE_OPTIONS : [...ROLE_OPTIONS, occupant.role];
  const id = occupant._draftId;
  return (
    <div style={cardStyle} onBlur={() => onTouched(id)}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
        <span style={labelStyle}>Occupant {index + 1}</span>
        <Button small onClick={() => onRemove(id)}>Remove</Button>
      </div>
      <input
        type="text"
        aria-label={`Occupant ${index + 1} name`}
        placeholder="Name"
        value={occupant.occupantName}
        onChange={(e) => onChange(id, { occupantName: e.target.value })}
        style={inputStyle}
      />
      <label style={fieldLabelStyle}>
        <span style={mutedStyle}>Role</span>
        <select value={occupant.role} onChange={(e) => onChange(id, { role: e.target.value })} style={{ ...inputStyle, display: 'block', marginTop: 2 }}>
          {roles.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
      </label>
      <label style={fieldLabelStyle}>
        <span style={mutedStyle}>Share of room</span>
        <span style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', alignItems: 'center', gap: 4, marginTop: 2 }}>
          <input
            type="number"
            min="0"
            max="100"
            aria-label={`Occupant ${index + 1} share of room, percent`}
            value={occupant.footprintWeight}
            onChange={(e) => onChange(id, { footprintWeight: e.target.value })}
            style={inputStyle}
          />
          <span style={noteStyle}>%</span>
        </span>
      </label>
      <div style={{ ...mutedStyle, marginTop: 2 }}>How much of this room this person uses</div>

      <div style={{ ...labelStyle, marginTop: 10 }}>Funding</div>
      <div style={{ ...stackStyle, gap: 8, marginTop: 4 }}>
        {occupant.fundingSources.map((row, rowIdx) => (
          <div key={rowIdx} style={{ minWidth: 0, borderTop: rowIdx ? `1px solid ${MF.line.hairline}` : 'none', paddingTop: rowIdx ? 8 : 0 }}>
            <input
              type="text"
              aria-label={`Funding row ${rowIdx + 1} source`}
              placeholder="Sponsor, grant or research account"
              value={row.source}
              onChange={(e) => onRowChange(id, rowIdx, { source: e.target.value })}
              style={inputStyle}
            />
            {/* Second line: % | function | remove. */}
            <div style={{ display: 'grid', gridTemplateColumns: '60px auto minmax(0, 1fr) auto', gap: 6, marginTop: 4, alignItems: 'center' }}>
              <input
                type="number"
                min="0"
                max="100"
                aria-label={`Funding row ${rowIdx + 1} percent`}
                value={row.percentage}
                onChange={(e) => onRowChange(id, rowIdx, { percentage: e.target.value })}
                style={inputStyle}
              />
              <span style={noteStyle}>%</span>
              <select
                aria-label={`Funding row ${rowIdx + 1} function`}
                value={row.category}
                onChange={(e) => onRowChange(id, rowIdx, { category: e.target.value })}
                style={inputStyle}
              >
                <option value="">Function…</option>
                <optgroup label="Direct">
                  {FUNCTIONAL_CATEGORIES.filter((c) => c.group === 'direct').map((c) => <option key={c.code} value={c.code}>{c.label}</option>)}
                </optgroup>
                <optgroup label="Indirect">
                  {FUNCTIONAL_CATEGORIES.filter((c) => c.group === 'indirect').map((c) => <option key={c.code} value={c.code}>{c.label}</option>)}
                </optgroup>
              </select>
              <Button small onClick={() => onRemoveRow(id, rowIdx)} title="Remove this funding row" style={{ flex: '0 0 auto' }}>×</Button>
            </div>
            {NAMED_SOURCE_CODES.has(row.category) ? (
              <div style={{ ...mutedStyle, marginTop: 3 }}>Name the sponsor or grant, or the internal research account.</div>
            ) : null}
          </div>
        ))}
      </div>
      <div style={{ marginTop: 8 }}>
        <Button small onClick={() => onAddRow(id)}>Add funding row</Button>
      </div>
      {messages.length ? (
        <ul style={{ margin: '8px 0 0', paddingLeft: 18 }}>
          {messages.map((m) => <li key={m} style={errorStyle}>{m}</li>)}
        </ul>
      ) : null}
    </div>
  );
}

export default function FaClassifier({ data, selectedRoomKey: controlledKey, onSelectRoom, onDone, demo = false }) {
  const { draft, isDirty, openDraft, setDraft, discardDraft, saveDraft } = useResearchSpaceDraft(data);
  const roomKey = draft?.roomKey || '';
  const room = useMemo(() => data.roomRows.find((r) => r.roomKey === roomKey) || null, [data.roomRows, roomKey]);
  const mode = draft?.mode || 'occupants';
  const occupants = draft?.occupants || [];

  // { roomKey } (switch rooms) or { done: true }, waiting on the discard dialog.
  const [pending, setPending] = useState(null);
  const [submitted, setSubmitted] = useState(false);
  const [touched, setTouched] = useState(() => new Set());
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState('');
  const [saveError, setSaveError] = useState('');
  const isDirtyRef = useRef(isDirty);
  isDirtyRef.current = isDirty;

  // Fresh feedback for each room.
  useEffect(() => {
    setSubmitted(false);
    setTouched(new Set());
    setSaveMessage('');
    setSaveError('');
  }, [roomKey]);

  const goToRoom = useCallback((key) => {
    openDraft(key);
    onSelectRoom?.(key);
  }, [openDraft, onSelectRoom]);

  // Selection from the map (click, jump). Acts only when StakeholderMap's key
  // actually changes, so a remount never reopens the room over a draft; an
  // unsaved draft asks before switching.
  const lastKeyRef = useRef(roomKey);
  useEffect(() => {
    if (controlledKey === undefined || controlledKey === lastKeyRef.current) return;
    if (!controlledKey || controlledKey === roomKey) {
      lastKeyRef.current = controlledKey;
      return;
    }
    if (!data.roomRows.some((r) => r.roomKey === controlledKey)) return; // scope still loading
    lastKeyRef.current = controlledKey;
    if (isDirtyRef.current) {
      setPending({ roomKey: controlledKey });
      return;
    }
    openDraft(controlledKey);
  }, [controlledKey, roomKey, data.roomRows, openDraft]);

  const requestRoom = (key) => {
    if (!key || key === roomKey) return;
    if (isDirty) { setPending({ roomKey: key }); return; }
    goToRoom(key);
  };
  const requestDone = () => {
    if (isDirty) { setPending({ done: true }); return; }
    discardDraft();
    onDone?.();
  };
  const handleKeep = () => {
    setPending(null);
    // A map click already moved StakeholderMap's selection -- move it back.
    if (roomKey && controlledKey !== roomKey) onSelectRoom?.(roomKey);
  };
  const handleDiscard = () => {
    const target = pending;
    setPending(null);
    discardDraft();
    if (target?.done) { onDone?.(); return; }
    if (target?.roomKey) goToRoom(target.roomKey);
  };

  // Next "Not started" room on the same building floor, after this one.
  const nextNotStarted = useMemo(() => {
    if (!room) return null;
    const sameFloor = data.roomRows.filter((r) => r.building === room.building && r.floor === room.floor);
    const idx = sameFloor.findIndex((r) => r.roomKey === room.roomKey);
    const ordered = [...sameFloor.slice(idx + 1), ...sameFloor.slice(0, Math.max(0, idx))];
    return ordered.find((r) => r.status === RS_STATUS.NOT_STARTED) || null;
  }, [data.roomRows, room]);

  // --- Draft edits ---------------------------------------------------------
  const setOccupants = useCallback((fn) => setDraft((prev) => ({ occupants: fn(prev.occupants || []) })), [setDraft]);
  const changeOccupant = useCallback((id, patch) => setOccupants((list) => list.map((o) => (o._draftId === id ? { ...o, ...patch } : o))), [setOccupants]);
  const changeRow = useCallback((id, rowIdx, patch) => setOccupants((list) => list.map((o) => (
    o._draftId === id ? { ...o, fundingSources: o.fundingSources.map((r, i) => (i === rowIdx ? { ...r, ...patch } : r)) } : o
  ))), [setOccupants]);
  const addRow = useCallback((id) => setOccupants((list) => list.map((o) => (
    o._draftId === id ? { ...o, fundingSources: [...o.fundingSources, newFundingSourceRow()] } : o
  ))), [setOccupants]);
  const removeRow = useCallback((id, rowIdx) => setOccupants((list) => list.map((o) => {
    if (o._draftId !== id) return o;
    const rows = o.fundingSources.filter((_, i) => i !== rowIdx);
    return { ...o, fundingSources: rows.length ? rows : [newFundingSourceRow()] };
  })), [setOccupants]);
  const addOccupant = useCallback(() => setOccupants((list) => [...list, newOccupantDraft()]), [setOccupants]);
  const removeOccupant = useCallback((id) => setOccupants((list) => list.filter((o) => o._draftId !== id)), [setOccupants]);
  const markTouched = useCallback((id) => setTouched((prev) => (prev.has(id) ? prev : new Set(prev).add(id))), []);

  const shareCheck = validateFootprintWeightsSumTo100(occupants.map((o) => ({ footprintWeight: Number(o.footprintWeight) })));
  const occupantsValid = occupants.length > 0
    && occupants.every((o) => validateOccupantDraft(o).length === 0)
    && shareCheck.valid;
  const showShareError = mode === 'occupants' && (submitted || touched.size > 0) && !shareCheck.valid;

  const handleSave = async () => {
    if (!draft || saving) return;
    setSubmitted(true);
    setSaveMessage('');
    setSaveError('');
    if (mode === 'occupants' && !occupantsValid) {
      setSaveError(occupants.length ? 'Fix the highlighted fields before saving.' : 'Add at least one occupant.');
      return;
    }
    setSaving(true);
    try {
      setSaveMessage(await saveDraft());
      setSubmitted(false);
      setTouched(new Set());
    } catch (error) {
      setSaveError(String(error?.message || 'Failed to save.'));
    } finally {
      setSaving(false);
    }
  };

  const progress = progressKpi(data);

  return (
    <div className="control-section" style={{ background: MF.surface.page, padding: 8, border: `1px solid ${MF.line.border}`, borderRadius: 6, marginTop: 6, display: 'flex', flexDirection: 'column', gap: 10, fontFamily: MF.type.family, boxSizing: 'border-box', minWidth: 0, maxWidth: '100%', overflowX: 'hidden', overflowWrap: 'anywhere' }}>
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', background: CE_ORANGE_HEADER, borderRadius: 6 }}>
          <h4 style={{ margin: 0, flex: '1 1 auto', fontSize: 12.5, fontWeight: 700, color: MF.surface.page }}>F&amp;A Compass · Classify</h4>
          <button
            type="button"
            className="mf-shell-button"
            onClick={requestDone}
            style={{ padding: '3px 10px', borderRadius: 6, border: `1px solid ${MF.surface.page}`, background: 'transparent', color: MF.surface.page, fontFamily: 'inherit', fontSize: 12, fontWeight: 600, cursor: 'pointer', '--mf-focus-color': MF.surface.page }}
          >
            Done
          </button>
        </div>
        {demo ? <div style={{ fontSize: 11, color: MF.ink.muted, margin: '4px 2px 0' }}>Demo — changes aren&apos;t saved</div> : null}
      </div>

      {!room ? (
        <div style={{ display: 'grid', gap: 10, padding: '0 2px' }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: MF.ink.primary }}>Click a room on the map</div>
          <div style={noteStyle}>
            Load a building floor, then click any colored office or lab to classify it. The map is colored by status:
          </div>
          <StatusLegend />
          {progress.value ? <div style={mutedStyle}>{progress.value} done · {progress.context}</div> : null}
        </div>
      ) : (
        <>
          <div style={{ padding: '0 2px' }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: MF.ink.primary }}>{room.building} · {room.room}</div>
            <div style={{ ...mutedStyle, marginTop: 2 }}>
              {[room.roomType, Number.isFinite(room.areaSF) ? formatSf(room.areaSF) : 'Area unknown', floorLabel(room.floor)].join(' · ')}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
              <span style={{ ...mfPillStyle, background: room.status === RS_STATUS.NOT_STARTED ? MF.status.warningBg : MF.surface.card, border: `1px solid ${room.status === RS_STATUS.NOT_STARTED ? MF.status.warningBorder : MF.line.border}`, color: room.status === RS_STATUS.NOT_STARTED ? MF.status.warningText : MF.ink.secondary }}>
                {statusLabel(room.status)}
              </span>
              <Button small onClick={() => requestRoom(nextNotStarted?.roomKey)} disabled={!nextNotStarted}>
                Next not started on this floor
              </Button>
            </div>
          </div>

          <div role="radiogroup" aria-label="How this room is classified" style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {MODES.map((m) => {
              const active = mode === m.value;
              return (
                <button
                  key={m.value}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  className="mf-shell-button"
                  onClick={() => setDraft({ mode: m.value })}
                  style={{
                    padding: '4px 9px',
                    borderRadius: 999,
                    border: `1px solid ${active ? MF.ink.primary : MF.line.border}`,
                    background: active ? MF.ink.primary : MF.surface.page,
                    color: active ? MF.surface.page : MF.ink.secondary,
                    fontFamily: 'inherit',
                    fontSize: 12,
                    fontWeight: 600,
                    cursor: 'pointer',
                    '--mf-focus-color': MF.util.base
                  }}
                >
                  {m.label}
                </button>
              );
            })}
          </div>

          {mode === 'occupants' ? (
            <div style={{ ...stackStyle, gap: 8 }}>
              {occupants.map((o, i) => (
                <OccupantCard
                  key={o._draftId}
                  occupant={o}
                  index={i}
                  showErrors={submitted || touched.has(o._draftId)}
                  onChange={changeOccupant}
                  onRowChange={changeRow}
                  onAddRow={addRow}
                  onRemoveRow={removeRow}
                  onRemove={removeOccupant}
                  onTouched={markTouched}
                />
              ))}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                <Button small onClick={addOccupant}>Add occupant</Button>
                <span style={{ ...mutedStyle, fontVariantNumeric: 'tabular-nums' }}>Shares: {Math.round(shareCheck.total * 100) / 100}% of 100%</span>
              </div>
              {showShareError ? <div style={errorStyle}>The shares of everyone in the room must add up to 100%.</div> : null}
            </div>
          ) : (
            <div style={noteStyle}>{MODE_NOTES[mode]}</div>
          )}

          <div style={{ borderTop: `1px solid ${MF.line.hairline}`, paddingTop: 8 }}>
            <MixPreview mode={mode} occupants={occupants} />
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <Button primary onClick={() => void handleSave()} disabled={saving || !isDirty}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
            {isDirty && !saving ? <span style={{ fontSize: 12, color: MF.status.warningText }}>Unsaved changes</span> : null}
            {saveMessage && !isDirty ? <span style={noteStyle}>{saveMessage}</span> : null}
          </div>
          {saveError ? <div role="alert" style={errorStyle}>{saveError}</div> : null}
        </>
      )}

      {pending ? <DiscardDialog onKeep={handleKeep} onDiscard={handleDiscard} /> : null}
    </div>
  );
}
