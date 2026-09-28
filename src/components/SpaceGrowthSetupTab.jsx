// src/components/SpaceGrowthSetupTab.jsx
//
// Setup tab of the Space Growth workspace (admin tools, moved out of the side
// panel's old <details> sections in Phase 5.5). Four cards, each with the same
// load / suggest / validate / save logic it had in ClassroomUtilizationPanel.jsx:
//   - Space targets (spaceConfig): one row per space category, SF/station +
//     target utilization %, or SF/FTE (Office).
//   - Room tagging (roomUtilizationMeta): space category, primary department
//     and notes per room, with Airtable suggestions, search and filters.
//   - Department targets (spaceConfigDepartmentOverrides): per-department
//     targets for Classroom / Lab / Office, pre-filled from the master plan.
//   - Enrollment projections upload (enrollmentProjections): parse → preview →
//     confirm dialog → replace all saved records.
// Reads come from the useSpaceGrowthData result (`data`); writes go to
// data.universityId, and each save reloads the collection it changed.
//
// Unsaved edits: each card reports whether it has any through
// onDirtyChange(cardId, bool), so the workspace can ask before a tab switch
// or close throws them away. Suggestions pre-filled automatically (Airtable,
// master plan) don't count -- they come back the next time the card opens.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { collection, doc, getDocs, serverTimestamp, setDoc, writeBatch } from 'firebase/firestore';
import { db } from '../firebaseConfig';
import { COURSE_MEETINGS_COLLECTION } from '../utils/classroomUtilizationSchema';
import { deriveDistinctRoomsFromCourseMeetings } from '../utils/roomUtilizationMeta';
import { asSnapshot } from '../utils/useSpaceGrowthData';
import { isAbortError } from '../utils/fetchWithTimeout';
import { buildAirtableRoomTypeMap, suggestSpaceCategoryFromRoomType, deriveOfficeRoomsFromAirtable } from '../utils/roomTypeSuggestion';
import {
  buildAirtableDepartmentMap,
  suggestPrimaryDepartmentFromAirtableDepartment,
  AIRTABLE_DEPARTMENT_TO_ENROLLMENT_DEPARTMENT
} from '../utils/departmentSuggestion';
import { parseEnrollmentProjectionsFile, toEnrollmentProjectionDocs } from '../utils/enrollmentProjectionsImport';
import { MASTER_PLAN_DEPARTMENT_LABELS, getMasterPlanSpaceTarget, getMasterPlanOfficeSpaceTarget } from '../utils/masterPlanSpaceTargets';
import { MF } from '../theme/mfTokens';
import { WorkspaceShell, MfGrid, MfCol, ChartCard } from './mf';
import {
  mfPrimaryButtonStyle,
  mfSecondaryButtonStyle,
  mfInputStyle,
  mfTableHeaderCell,
  mfTableBodyCell,
  mfPillStyle
} from './mf/mfStyles';
import { OVERRIDE_TAG } from './spaceGrowthView';

const BATCH_CHUNK_SIZE = 400; // Firestore's cap is 500 ops per batch

export const OFFICE_TARGET_NOTE = 'Not used in the gap until staff FTE is available.';

// --- Shared styles ------------------------------------------------------------------
const noteStyle = { fontSize: 12, color: MF.ink.secondary, lineHeight: 1.45 };
const mutedStyle = { fontSize: 12, color: MF.ink.muted, lineHeight: 1.45 };
const errorStyle = { fontSize: 12, color: MF.status.error, lineHeight: 1.45 };
const headerCell = mfTableHeaderCell;
const bodyCell = mfTableBodyCell;
const numCell = { ...bodyCell, textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' };
const warningBox = {
  padding: '8px 10px',
  borderRadius: 6,
  fontSize: 12,
  lineHeight: 1.45,
  background: MF.status.warningBg,
  border: `1px solid ${MF.status.warningBorder}`,
  color: MF.status.warningText
};
const neutralPill = { ...mfPillStyle, background: MF.surface.card, border: `1px solid ${MF.line.border}`, color: MF.ink.secondary };
const warningPill = { ...mfPillStyle, background: MF.status.warningBg, border: `1px solid ${MF.status.warningBorder}`, color: MF.status.warningText };
const numberInput = { ...mfInputStyle, width: 88 };

// Unsaved / suggested rows share the one warning style.
function rowStyle(highlight) {
  return highlight ? { background: MF.status.warningBg } : undefined;
}

function disabledStyle(disabled) {
  return disabled ? { opacity: 0.55, cursor: 'default' } : null;
}

function Button({ primary = false, onClick, disabled, title, children }) {
  return (
    <button
      type="button"
      className="mf-shell-button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{ ...(primary ? mfPrimaryButtonStyle : mfSecondaryButtonStyle), ...disabledStyle(disabled), '--mf-focus-color': MF.util.base }}
    >
      {children}
    </button>
  );
}

function Messages({ loadError, saveMessage, saveError }) {
  return (
    <>
      {loadError ? <div style={{ ...errorStyle, marginTop: 8 }}>{loadError}</div> : null}
      {saveMessage ? <div style={{ ...noteStyle, marginTop: 8 }}>{saveMessage}</div> : null}
      {saveError ? <div role="alert" style={{ ...errorStyle, marginTop: 8 }}>{saveError}</div> : null}
    </>
  );
}

// Reports `dirty` to the workspace, and clears it when the card unmounts.
function useReportDirty(onDirtyChange, cardId, dirty) {
  useEffect(() => {
    onDirtyChange?.(cardId, dirty);
  }, [onDirtyChange, cardId, dirty]);
  useEffect(() => () => onDirtyChange?.(cardId, false), [onDirtyChange, cardId]);
}

// --- Target helpers (shared by Space targets and Department targets) ------------
function pctToFraction(pctText) {
  const n = Number(pctText);
  return Number.isFinite(n) ? n / 100 : NaN;
}

function fractionToPctText(fraction) {
  return Number.isFinite(fraction) ? String(Math.round(fraction * 10000) / 100) : '';
}

// formulaType: 'station' (SF/station + target utilization %) or 'fte' (SF/FTE).
function validateTargetRow(row, formulaType = 'station') {
  const errors = [];
  if (formulaType === 'fte') {
    const sfPerFte = Number(row.sfPerFteTarget);
    if (!Number.isFinite(sfPerFte) || sfPerFte <= 0) errors.push('SF/FTE must be a positive number');
    return errors;
  }
  const sf = Number(row.sfPerStationTarget);
  const pct = Number(row.targetUtilizationRatePct);
  if (!Number.isFinite(sf) || sf <= 0) errors.push('SF/station must be a positive number');
  if (!Number.isFinite(pct) || pct <= 0 || pct > 100) errors.push('Target utilization must be more than 0% and at most 100%');
  return errors;
}

// Formula type is detected, not stored: a positive sfPerFteTarget means
// FTE-based; everything else (including a new, unsaved category) is 'station'.
function detectFormulaType(docData) {
  const sfPerFte = Number(docData?.sfPerFteTarget);
  return Number.isFinite(sfPerFte) && sfPerFte > 0 ? 'fte' : 'station';
}

function StationInputs({ row, onChange }) {
  return (
    <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
      <input
        type="number"
        min="0"
        step="1"
        aria-label="SF per station"
        placeholder="SF/station"
        value={row.sfPerStationTarget}
        onChange={(e) => onChange('sfPerStationTarget', e.target.value)}
        style={numberInput}
      />
      <span style={mutedStyle}>SF/station at</span>
      <input
        type="number"
        min="0"
        max="100"
        step="1"
        aria-label="Target utilization percent"
        placeholder="Target %"
        value={row.targetUtilizationRatePct}
        onChange={(e) => onChange('targetUtilizationRatePct', e.target.value)}
        style={{ ...numberInput, width: 72 }}
      />
      <span style={mutedStyle}>% utilization</span>
    </span>
  );
}

function FteInput({ row, onChange }) {
  return (
    <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
      <input
        type="number"
        min="0"
        step="1"
        aria-label="SF per FTE"
        placeholder="SF/FTE"
        value={row.sfPerFteTarget}
        onChange={(e) => onChange('sfPerFteTarget', e.target.value)}
        style={numberInput}
      />
      <span style={mutedStyle}>SF/FTE</span>
    </span>
  );
}

// --- Space targets ----------------------------------------------------------------
// One row per space category, fully data-driven (whatever categories exist),
// plus "Add category". Plain setDoc overwrite, so switching a category's
// formula type drops the other formula's fields on save.
function SpaceTargetsCard({ data, onDirtyChange }) {
  const [form, setForm] = useState({});
  const [persisted, setPersisted] = useState({});
  const [categoryOrder, setCategoryOrder] = useState([]);
  const [newCategoryName, setNewCategoryName] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState('');
  const [saveError, setSaveError] = useState('');

  const spaceConfigCollection = useMemo(() => data.collectionRef('spaceConfig'), [data]);
  const spaceConfigRaw = data.raw.spaceConfig;
  const firstLoadPending = data.status === 'idle' || data.status === 'loading';
  const hookError = data.status === 'error' ? data.error : '';

  // Builds form/persisted from the hook's spaceConfig docs -- when they load
  // and after every save (reloadCollection).
  const loadSpaceConfig = useCallback(async () => {
    setLoading(true);
    setLoadError(hookError);
    if (firstLoadPending) return;
    try {
      const snap = asSnapshot(spaceConfigRaw);
      const nextPersisted = {};
      const nextForm = {};
      const order = [];
      snap.docs.forEach((docSnap) => {
        const category = docSnap.id;
        const docData = docSnap.data() || {};
        const formulaType = detectFormulaType(docData);
        const sf = Number(docData.sfPerStationTarget);
        const rate = Number(docData.targetUtilizationRate);
        const sfFte = Number(docData.sfPerFteTarget);
        order.push(category);
        nextPersisted[category] = {
          formulaType,
          sfPerStationTarget: Number.isFinite(sf) ? sf : null,
          targetUtilizationRate: Number.isFinite(rate) ? rate : null,
          sfPerFteTarget: Number.isFinite(sfFte) ? sfFte : null
        };
        nextForm[category] = {
          formulaType,
          sfPerStationTarget: Number.isFinite(sf) ? String(sf) : '',
          targetUtilizationRatePct: Number.isFinite(rate) ? fractionToPctText(rate) : '',
          sfPerFteTarget: Number.isFinite(sfFte) ? String(sfFte) : ''
        };
      });
      order.sort((a, b) => a.localeCompare(b));
      setCategoryOrder(order);
      setPersisted(nextPersisted);
      setForm(nextForm);
    } catch (error) {
      setLoadError(String(error?.message || 'Failed to load space targets.'));
    } finally {
      setLoading(false);
    }
  }, [spaceConfigRaw, firstLoadPending, hookError]);

  useEffect(() => {
    void loadSpaceConfig();
  }, [loadSpaceConfig]);

  const handleFieldChange = useCallback((category, field, value) => {
    setForm((prev) => ({ ...prev, [category]: { ...prev[category], [field]: value } }));
  }, []);

  const handleAddCategory = useCallback(() => {
    const name = newCategoryName.trim();
    if (!name || categoryOrder.includes(name)) return;
    setCategoryOrder((prev) => [...prev, name].sort((a, b) => a.localeCompare(b)));
    setForm((prev) => ({ ...prev, [name]: { formulaType: 'station', sfPerStationTarget: '', targetUtilizationRatePct: '', sfPerFteTarget: '' } }));
    setNewCategoryName('');
  }, [newCategoryName, categoryOrder]);

  // Only offered for categories that were never saved -- removes the row,
  // never deletes anything saved.
  const handleRemoveUnsavedCategory = useCallback((category) => {
    setCategoryOrder((prev) => prev.filter((c) => c !== category));
    setForm((prev) => {
      const next = { ...prev };
      delete next[category];
      return next;
    });
  }, []);

  const isCategoryDirty = useCallback((category) => {
    const row = form[category];
    const saved = persisted[category];
    if (!row) return false;
    const formulaType = row.formulaType || 'station';
    if (!saved) {
      return formulaType === 'fte'
        ? Boolean(String(row.sfPerFteTarget || '').trim())
        : Boolean(String(row.sfPerStationTarget || '').trim() || String(row.targetUtilizationRatePct || '').trim());
    }
    // A formula-type switch alone needs a save (to drop the old fields).
    if (formulaType !== saved.formulaType) return true;
    if (formulaType === 'fte') return Number(row.sfPerFteTarget) !== saved.sfPerFteTarget;
    const sf = Number(row.sfPerStationTarget);
    const rate = pctToFraction(row.targetUtilizationRatePct);
    return sf !== saved.sfPerStationTarget || rate !== saved.targetUtilizationRate;
  }, [form, persisted]);

  const dirtyCategories = useMemo(
    () => categoryOrder.filter((category) => isCategoryDirty(category)),
    [categoryOrder, isCategoryDirty]
  );
  // A newly added (never saved) category counts as unsaved even while blank.
  const hasUnsaved = dirtyCategories.length > 0 || categoryOrder.some((c) => !persisted[c]);
  useReportDirty(onDirtyChange, 'spaceTargets', hasUnsaved);

  const handleSave = useCallback(async () => {
    if (saving || !dirtyCategories.length) return;
    setSaving(true);
    setSaveMessage('');
    setSaveError('');

    // Validate every changed row first -- one invalid row blocks the save.
    const invalid = dirtyCategories
      .map((category) => ({ category, errors: validateTargetRow(form[category], form[category].formulaType || 'station') }))
      .filter((entry) => entry.errors.length);
    if (invalid.length) {
      setSaveError(invalid.map((entry) => `${entry.category}: ${entry.errors.join('; ')}`).join(' · '));
      setSaving(false);
      return;
    }

    try {
      for (const category of dirtyCategories) {
        const row = form[category];
        const formulaType = row.formulaType || 'station';
        const payload = formulaType === 'fte'
          ? { sfPerFteTarget: Number(row.sfPerFteTarget), effectiveDate: serverTimestamp() }
          : {
            sfPerStationTarget: Number(row.sfPerStationTarget),
            targetUtilizationRate: pctToFraction(row.targetUtilizationRatePct),
            effectiveDate: serverTimestamp()
          };
        await setDoc(doc(spaceConfigCollection, category), payload);
      }
      setSaveMessage(`Saved ${dirtyCategories.length} space ${dirtyCategories.length === 1 ? 'category' : 'categories'}.`);
      await data.reloadCollection('spaceConfig');
    } catch (error) {
      setSaveError(String(error?.message || 'Failed to save space targets.'));
    } finally {
      setSaving(false);
    }
  }, [saving, dirtyCategories, form, spaceConfigCollection, data]);

  const saveDisabled = saving || !dirtyCategories.length;

  return (
    <ChartCard
      title="Space targets"
      subtitle="How much space each category should have. Classroom and lab use SF per station at a target utilization; office uses SF per FTE."
      actions={(
        <Button primary onClick={() => void handleSave()} disabled={saveDisabled}>
          {saving ? 'Saving…' : `Save${dirtyCategories.length ? ` (${dirtyCategories.length})` : ''}`}
        </Button>
      )}
      autoHeight
    >
      {() => (
        <div>
          {loading && !categoryOrder.length ? (
            <div style={mutedStyle}>Loading space targets…</div>
          ) : categoryOrder.length ? (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', background: MF.surface.page, fontFamily: MF.type.family }}>
                <thead>
                  <tr>
                    <th style={headerCell}>Category</th>
                    <th style={headerCell}>Formula</th>
                    <th style={headerCell}>Target</th>
                  </tr>
                </thead>
                <tbody>
                  {categoryOrder.map((category) => {
                    const row = form[category] || { formulaType: 'station', sfPerStationTarget: '', targetUtilizationRatePct: '', sfPerFteTarget: '' };
                    const formulaType = row.formulaType || 'station';
                    const dirty = isCategoryDirty(category);
                    const isUnsaved = !persisted[category];
                    const rowErrors = dirty ? validateTargetRow(row, formulaType) : [];
                    const onChange = (field, value) => handleFieldChange(category, field, value);
                    return (
                      <tr key={category} style={rowStyle(dirty || isUnsaved)}>
                        <td style={{ ...bodyCell, fontWeight: 600 }}>
                          {category}
                          {isUnsaved ? <span style={{ ...warningPill, marginLeft: 6 }}>not saved</span> : null}
                          {isUnsaved ? (
                            <button
                              type="button"
                              className="mf-shell-tab"
                              onClick={() => handleRemoveUnsavedCategory(category)}
                              style={{ marginLeft: 8, fontSize: 12, color: MF.ink.muted, textDecoration: 'underline', '--mf-focus-color': MF.util.base }}
                            >
                              Remove
                            </button>
                          ) : null}
                        </td>
                        <td style={bodyCell}>
                          <select
                            value={formulaType}
                            aria-label={`${category} formula`}
                            onChange={(e) => handleFieldChange(category, 'formulaType', e.target.value)}
                            style={mfInputStyle}
                          >
                            <option value="station">SF/station + utilization</option>
                            <option value="fte">SF/FTE</option>
                          </select>
                        </td>
                        <td style={bodyCell}>
                          {formulaType === 'fte' ? <FteInput row={row} onChange={onChange} /> : <StationInputs row={row} onChange={onChange} />}
                          {formulaType === 'fte' ? <div style={{ ...mutedStyle, marginTop: 4 }}>{OFFICE_TARGET_NOTE}</div> : null}
                          {rowErrors.length ? <div style={{ ...errorStyle, marginTop: 4 }}>{rowErrors.join('; ')}</div> : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <div style={mutedStyle}>No space categories yet — add one below.</div>
          )}

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
            <input
              type="text"
              aria-label="New space category name"
              placeholder="Add a space category (e.g. Classroom, Lab)"
              value={newCategoryName}
              onChange={(e) => setNewCategoryName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleAddCategory(); }}
              style={{ ...mfInputStyle, flex: '1 1 220px', minWidth: 180 }}
            />
            <Button onClick={handleAddCategory} disabled={!newCategoryName.trim()}>Add</Button>
          </div>

          <Messages loadError={loadError} saveMessage={saveMessage} saveError={saveError} />
        </div>
      )}
    </ChartCard>
  );
}

// --- Room tagging -------------------------------------------------------------------
// One row per room: rooms with scheduled classes (from the imported class
// schedule) plus Airtable's office rooms. Space category is picked from the
// existing categories and primary department from the enrollment projections
// -- never free text. Untagged rooms are left out of the gap but flagged here.
// Airtable suggestions are pre-filled once per visit (never saved on their own).
const EMPTY_ROOM_ROW = { spaceCategory: '', primaryDepartment: '', notes: '' };
const ALL = '__all__';
const NONE = '__none__';

function RoomTaggingCard({ data, onDirtyChange }) {
  // [{roomKey, building, room, source ('scheduled' | 'office')}]
  const [roomList, setRoomList] = useState([]);
  const [categoryOptions, setCategoryOptions] = useState([]);
  const [categoryOptionsLoaded, setCategoryOptionsLoaded] = useState(false);
  const [departmentOptions, setDepartmentOptions] = useState([]);
  const [departmentOptionsLoaded, setDepartmentOptionsLoaded] = useState(false);
  const [form, setForm] = useState({}); // roomKey -> {spaceCategory, primaryDepartment, notes}
  const [persisted, setPersisted] = useState({}); // same, only for rooms already saved
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState('');
  const [saveError, setSaveError] = useState('');
  const [suggestDeptMessage, setSuggestDeptMessage] = useState('');
  const [airtableRoomTypeByKey, setAirtableRoomTypeByKey] = useState(() => new Map());
  const [airtableDepartmentByKey, setAirtableDepartmentByKey] = useState(() => new Map());
  const [airtableSuggestionsLoaded, setAirtableSuggestionsLoaded] = useState(false);
  const [airtableSuggestionsError, setAirtableSuggestionsError] = useState('');
  // Rooms whose category / department is a pre-filled Airtable suggestion the
  // admin hasn't touched yet; editing the field removes it from the set.
  const [suggestedRoomKeys, setSuggestedRoomKeys] = useState(() => new Set());
  const [suggestedDepartmentRoomKeys, setSuggestedDepartmentRoomKeys] = useState(() => new Set());
  const suggestionsAppliedRef = useRef(false);
  // Search and filters (display only).
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState(ALL);
  const [departmentFilter, setDepartmentFilter] = useState(ALL);
  const [untaggedOnly, setUntaggedOnly] = useState(false);

  const roomUtilizationMetaCollection = useMemo(() => data.collectionRef('roomUtilizationMeta'), [data]);
  const courseMeetingsCollection = useMemo(
    () => collection(db, 'universities', data.universityId, COURSE_MEETINGS_COLLECTION),
    [data.universityId]
  );
  const dataReady = data.status === 'ready' || data.status === 'error';

  useEffect(() => {
    if (!dataReady) return;
    setCategoryOptions(data.raw.spaceConfig.map((d) => d.id).sort((a, b) => a.localeCompare(b)));
    setCategoryOptionsLoaded(true);
  }, [dataReady, data.raw.spaceConfig]);

  // Departments from the enrollment projections (no "Overall", deduped).
  useEffect(() => {
    if (!dataReady) return;
    const names = new Set();
    data.raw.enrollmentProjections.forEach((d) => {
      if (String(d.data.division || '').trim().toLowerCase() === 'overall') return;
      const department = String(d.data.department || '').trim();
      if (department) names.add(department);
    });
    setDepartmentOptions(Array.from(names).sort((a, b) => a.localeCompare(b)));
    setDepartmentOptionsLoaded(true);
  }, [dataReady, data.raw.enrollmentProjections]);

  // Once per visit: pre-fill category and department for rooms that were
  // never saved and are still blank, when Airtable's room type / department
  // maps to a category / department that already exists.
  useEffect(() => {
    if (suggestionsAppliedRef.current) return;
    if (!roomList.length || !airtableSuggestionsLoaded || !categoryOptionsLoaded || !departmentOptionsLoaded) return;
    suggestionsAppliedRef.current = true;

    const nextSuggestedKeys = new Set();
    const nextSuggestedDeptKeys = new Set();
    setForm((prev) => {
      let changed = false;
      const next = { ...prev };
      roomList.forEach(({ roomKey }) => {
        if (persisted[roomKey]) return;
        const current = next[roomKey] || EMPTY_ROOM_ROW;
        let row = current;
        if (!String(current.spaceCategory || '').trim()) {
          const suggestedCategory = suggestSpaceCategoryFromRoomType(airtableRoomTypeByKey.get(roomKey));
          if (suggestedCategory && categoryOptions.includes(suggestedCategory)) {
            row = { ...row, spaceCategory: suggestedCategory };
            nextSuggestedKeys.add(roomKey);
            changed = true;
          }
        }
        if (!String(current.primaryDepartment || '').trim()) {
          const suggestedDept = suggestPrimaryDepartmentFromAirtableDepartment(airtableDepartmentByKey.get(roomKey), departmentOptions);
          if (suggestedDept) {
            row = { ...row, primaryDepartment: suggestedDept };
            nextSuggestedDeptKeys.add(roomKey);
            changed = true;
          }
        }
        if (row !== current) next[roomKey] = row;
      });
      return changed ? next : prev;
    });
    setSuggestedRoomKeys(nextSuggestedKeys);
    setSuggestedDepartmentRoomKeys(nextSuggestedDeptKeys);
  }, [
    roomList,
    persisted,
    airtableRoomTypeByKey,
    airtableDepartmentByKey,
    airtableSuggestionsLoaded,
    categoryOptions,
    categoryOptionsLoaded,
    departmentOptions,
    departmentOptionsLoaded
  ]);

  // Room list = scheduled rooms (class schedule) + Airtable office rooms;
  // saved tags come from the hook. Re-runs after Save reloads the tags.
  // Airtable is read through a ref so a Recalculate elsewhere doesn't rebuild
  // the form and drop unsaved edits.
  const metaRaw = data.raw.roomUtilizationMeta;
  const airtableRef = useRef({ rooms: [], error: null });
  airtableRef.current = { rooms: data.airtableRooms, error: data.airtableError };
  const loadRooms = useCallback(async () => {
    if (!dataReady || !data.airtableLoaded) return;
    const { rooms: airtableRooms, error: airtableError } = airtableRef.current;
    setLoading(true);
    setLoadError('');
    try {
      const meetingsSnap = await getDocs(courseMeetingsCollection);
      const metaSnap = asSnapshot(metaRaw);
      if (airtableError) {
        setAirtableSuggestionsError(isAbortError(airtableError)
          ? 'the AI server timed out — try Recalculate shortly'
          : String(airtableError?.message || 'Airtable could not be reached'));
      } else {
        setAirtableSuggestionsError('');
      }

      const scheduledRooms = deriveDistinctRoomsFromCourseMeetings(meetingsSnap.docs.map((docSnap) => docSnap.data()));
      const officeRooms = deriveOfficeRoomsFromAirtable(airtableRooms);
      // A scheduled room wins if an office room has the same building + room.
      const roomMap = new Map();
      scheduledRooms.forEach((r) => roomMap.set(r.roomKey, r));
      officeRooms.forEach((r) => {
        if (!roomMap.has(r.roomKey)) roomMap.set(r.roomKey, r);
      });
      const rooms = Array.from(roomMap.values()).sort((a, b) => (
        a.building.localeCompare(b.building) || a.room.localeCompare(b.room, undefined, { numeric: true })
      ));

      const nextPersisted = {};
      metaSnap.docs.forEach((docSnap) => {
        const docData = docSnap.data() || {};
        nextPersisted[docSnap.id] = {
          spaceCategory: String(docData.spaceCategory || ''),
          primaryDepartment: String(docData.primaryDepartment || ''),
          notes: String(docData.notes || '')
        };
      });
      const nextForm = {};
      rooms.forEach(({ roomKey }) => {
        nextForm[roomKey] = nextPersisted[roomKey] ? { ...nextPersisted[roomKey] } : { ...EMPTY_ROOM_ROW };
      });
      setRoomList(rooms);
      setPersisted(nextPersisted);
      setForm(nextForm);
      setAirtableRoomTypeByKey(buildAirtableRoomTypeMap(airtableRooms));
      setAirtableDepartmentByKey(buildAirtableDepartmentMap(airtableRooms));
    } catch (error) {
      setLoadError(String(error?.message || 'Failed to load rooms.'));
    } finally {
      setLoading(false);
      setAirtableSuggestionsLoaded(true);
    }
  }, [dataReady, data.airtableLoaded, courseMeetingsCollection, metaRaw]);

  useEffect(() => {
    void loadRooms();
  }, [loadRooms]);

  const handleFieldChange = useCallback((roomKey, field, value) => {
    setForm((prev) => ({ ...prev, [roomKey]: { ...(prev[roomKey] || EMPTY_ROOM_ROW), [field]: value } }));
    const drop = (setter) => setter((prev) => {
      if (!prev.has(roomKey)) return prev;
      const next = new Set(prev);
      next.delete(roomKey);
      return next;
    });
    if (field === 'spaceCategory') drop(setSuggestedRoomKeys);
    if (field === 'primaryDepartment') drop(setSuggestedDepartmentRoomKeys);
  }, []);

  // Manual, repeatable: fill a blank primary department from Airtable for
  // every room (saved or not). Pre-fills only; Save confirms.
  const handleSuggestDepartments = useCallback(() => {
    let suggestedCount = 0;
    let noMatchCount = 0;
    const nextSuggestedDeptKeys = new Set(suggestedDepartmentRoomKeys);
    setForm((prev) => {
      const next = { ...prev };
      roomList.forEach(({ roomKey }) => {
        const current = next[roomKey] || EMPTY_ROOM_ROW;
        if (String(current.primaryDepartment || '').trim()) return;
        const suggestedDept = suggestPrimaryDepartmentFromAirtableDepartment(airtableDepartmentByKey.get(roomKey), departmentOptions);
        if (suggestedDept) {
          next[roomKey] = { ...current, primaryDepartment: suggestedDept };
          nextSuggestedDeptKeys.add(roomKey);
          suggestedCount += 1;
        } else {
          noMatchCount += 1;
        }
      });
      return next;
    });
    setSuggestedDepartmentRoomKeys(nextSuggestedDeptKeys);
    setSuggestDeptMessage(
      suggestedCount || noMatchCount
        ? `Suggested a department for ${suggestedCount} ${suggestedCount === 1 ? 'room' : 'rooms'}`
          + (noMatchCount ? `; ${noMatchCount} had no match in Airtable.` : '.')
        : 'Every room already has a department.'
    );
  }, [roomList, airtableDepartmentByKey, departmentOptions, suggestedDepartmentRoomKeys]);

  const isRoomDirty = useCallback((roomKey) => {
    const row = form[roomKey];
    if (!row) return false;
    const saved = persisted[roomKey] || EMPTY_ROOM_ROW;
    return row.spaceCategory !== saved.spaceCategory
      || row.primaryDepartment !== saved.primaryDepartment
      || row.notes !== saved.notes;
  }, [form, persisted]);

  const dirtyRoomKeys = useMemo(
    () => roomList.map((r) => r.roomKey).filter((roomKey) => isRoomDirty(roomKey)),
    [roomList, isRoomDirty]
  );

  // Unsaved edits the admin made, ignoring fields that only hold an
  // untouched suggestion.
  const hasManualEdits = useMemo(() => dirtyRoomKeys.some((roomKey) => {
    const row = form[roomKey];
    const saved = persisted[roomKey] || EMPTY_ROOM_ROW;
    return (row.spaceCategory !== saved.spaceCategory && !suggestedRoomKeys.has(roomKey))
      || (row.primaryDepartment !== saved.primaryDepartment && !suggestedDepartmentRoomKeys.has(roomKey))
      || row.notes !== saved.notes;
  }), [dirtyRoomKeys, form, persisted, suggestedRoomKeys, suggestedDepartmentRoomKeys]);
  useReportDirty(onDirtyChange, 'roomTagging', hasManualEdits);

  const taggedCount = useMemo(
    () => roomList.filter((r) => String(form[r.roomKey]?.spaceCategory || '').trim()).length,
    [roomList, form]
  );

  const validateRoomRow = useCallback((row) => {
    const errors = [];
    const category = String(row?.spaceCategory || '').trim();
    if (category && !categoryOptions.includes(category)) errors.push(`"${category}" is not one of the space targets`);
    const department = String(row?.primaryDepartment || '').trim();
    if (department && !departmentOptions.includes(department)) errors.push(`"${department}" is not a department in the enrollment projections`);
    return errors;
  }, [categoryOptions, departmentOptions]);

  const roomsByKey = useMemo(() => new Map(roomList.map((r) => [r.roomKey, r])), [roomList]);
  const roomLabel = useCallback((roomKey) => {
    const info = roomsByKey.get(roomKey);
    return info ? `${info.building} ${info.room}` : roomKey;
  }, [roomsByKey]);

  const handleSave = useCallback(async () => {
    if (saving || !dirtyRoomKeys.length) return;
    setSaving(true);
    setSaveMessage('');
    setSaveError('');

    const invalid = dirtyRoomKeys
      .map((roomKey) => ({ roomKey, errors: validateRoomRow(form[roomKey]) }))
      .filter((entry) => entry.errors.length);
    if (invalid.length) {
      setSaveError(invalid.map((entry) => `${roomLabel(entry.roomKey)}: ${entry.errors.join('; ')}`).join(' · '));
      setSaving(false);
      return;
    }

    try {
      for (const roomKey of dirtyRoomKeys) {
        const row = form[roomKey];
        const roomInfo = roomsByKey.get(roomKey);
        await setDoc(doc(roomUtilizationMetaCollection, roomKey), {
          building: roomInfo?.building || '',
          room: roomInfo?.room || '',
          spaceCategory: String(row.spaceCategory || '').trim(),
          primaryDepartment: String(row.primaryDepartment || '').trim(),
          notes: String(row.notes || '').trim()
        });
      }
      setSaveMessage(`Saved ${dirtyRoomKeys.length} ${dirtyRoomKeys.length === 1 ? 'room' : 'rooms'}.`);
      await data.reloadCollection('roomUtilizationMeta');
    } catch (error) {
      setSaveError(String(error?.message || 'Failed to save room tagging.'));
    } finally {
      setSaving(false);
    }
  }, [saving, dirtyRoomKeys, form, roomsByKey, roomUtilizationMetaCollection, data, validateRoomRow, roomLabel]);

  const noCategoriesYet = !loading && categoryOptionsLoaded && categoryOptions.length === 0;
  const noDepartmentsYet = departmentOptionsLoaded && departmentOptions.length === 0;

  const visibleRooms = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return roomList.filter(({ roomKey, building, room }) => {
      const row = form[roomKey] || EMPTY_ROOM_ROW;
      const category = String(row.spaceCategory || '').trim();
      const department = String(row.primaryDepartment || '').trim();
      if (untaggedOnly && category) return false;
      if (categoryFilter === NONE ? category : categoryFilter !== ALL && category !== categoryFilter) return false;
      if (departmentFilter === NONE ? department : departmentFilter !== ALL && department !== departmentFilter) return false;
      if (needle && !`${building} ${room} ${row.notes || ''}`.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [roomList, form, search, categoryFilter, departmentFilter, untaggedOnly]);

  const saveDisabled = saving || !dirtyRoomKeys.length || noCategoriesYet;
  const filtered = visibleRooms.length !== roomList.length;

  return (
    <ChartCard
      title="Room tagging"
      subtitle="Give each room a space category and, for classroom and lab space, the department that uses it. Untagged rooms aren't counted in the gap."
      actions={(
        <>
          <Button
            onClick={handleSuggestDepartments}
            disabled={!airtableSuggestionsLoaded || noDepartmentsYet}
            title="Fill in a blank department from Airtable's Department field, for every room. Review, then Save."
          >
            Suggest Departments
          </Button>
          <Button primary onClick={() => void handleSave()} disabled={saveDisabled}>
            {saving ? 'Saving…' : `Save${dirtyRoomKeys.length ? ` (${dirtyRoomKeys.length})` : ''}`}
          </Button>
        </>
      )}
      autoHeight
    >
      {() => (
        <div>
          <div style={{ fontSize: 15, fontWeight: 700, color: MF.ink.primary }}>
            {roomList.length
              ? `${taggedCount.toLocaleString()} of ${roomList.length.toLocaleString()} tagged`
              : (loading ? 'Loading rooms…' : 'No rooms yet')}
          </div>
          <div style={{ ...mutedStyle, marginTop: 2 }}>
            Rooms with scheduled classes, plus Airtable&apos;s office rooms.
            {' '}Suggestions from Airtable are filled in but not saved until you click Save.
          </div>

          {roomList.length && taggedCount < roomList.length ? (
            <div style={{ ...warningBox, marginTop: 8 }}>
              {(roomList.length - taggedCount).toLocaleString()} {roomList.length - taggedCount === 1 ? 'room is' : 'rooms are'} untagged and left out of the gap.
            </div>
          ) : null}
          {noCategoriesYet ? (
            <div style={{ ...warningBox, marginTop: 8 }}>No space categories yet — add one in Space targets before tagging rooms.</div>
          ) : null}
          {noDepartmentsYet ? (
            <div style={{ ...warningBox, marginTop: 8 }}>No departments yet — upload the enrollment projections to choose departments.</div>
          ) : null}
          {airtableSuggestionsError ? (
            <div style={{ ...mutedStyle, marginTop: 8 }}>Airtable suggestions are unavailable ({airtableSuggestionsError}); you can still tag rooms by hand.</div>
          ) : null}
          {suggestDeptMessage ? <div style={{ ...noteStyle, marginTop: 8 }}>{suggestDeptMessage}</div> : null}

          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, marginTop: 12 }}>
            <input
              type="search"
              aria-label="Search rooms"
              placeholder="Search building, room or notes"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{ ...mfInputStyle, flex: '1 1 220px', minWidth: 180 }}
            />
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600, color: MF.ink.muted }}>
              Category
              <select value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)} style={mfInputStyle}>
                <option value={ALL}>All</option>
                <option value={NONE}>Untagged</option>
                {categoryOptions.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600, color: MF.ink.muted }}>
              Department
              <select value={departmentFilter} onChange={(e) => setDepartmentFilter(e.target.value)} style={mfInputStyle}>
                <option value={ALL}>All</option>
                <option value={NONE}>No department</option>
                {departmentOptions.map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: MF.ink.secondary }}>
              <input type="checkbox" checked={untaggedOnly} onChange={(e) => setUntaggedOnly(e.target.checked)} />
              Untagged only
            </label>
          </div>
          {filtered ? (
            <div style={{ ...mutedStyle, marginTop: 6 }}>Showing {visibleRooms.length.toLocaleString()} of {roomList.length.toLocaleString()} rooms.</div>
          ) : null}

          {loading && !roomList.length ? null : visibleRooms.length ? (
            <div style={{ overflowX: 'auto', marginTop: 8 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', background: MF.surface.page, fontFamily: MF.type.family }}>
                <thead>
                  <tr>
                    <th style={headerCell}>Room</th>
                    <th style={headerCell}>Space category</th>
                    <th style={headerCell}>Department</th>
                    <th style={headerCell}>Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleRooms.map(({ roomKey, building, room, source }) => {
                    const row = form[roomKey] || EMPTY_ROOM_ROW;
                    const dirty = isRoomDirty(roomKey);
                    const rowErrors = dirty ? validateRoomRow(row) : [];
                    const isSuggested = suggestedRoomKeys.has(roomKey);
                    const isDepartmentSuggested = suggestedDepartmentRoomKeys.has(roomKey);
                    const airtableRoomType = airtableRoomTypeByKey.get(roomKey) || '';
                    const rawSuggestedCategory = suggestSpaceCategoryFromRoomType(airtableRoomType);
                    const suggestionNeedsCategory = Boolean(
                      !persisted[roomKey] && !isSuggested && rawSuggestedCategory
                      && !categoryOptions.includes(rawSuggestedCategory) && !String(row.spaceCategory || '').trim()
                    );
                    const airtableDepartment = airtableDepartmentByKey.get(roomKey) || '';
                    const rawSuggestedDepartment = AIRTABLE_DEPARTMENT_TO_ENROLLMENT_DEPARTMENT[airtableDepartment] || '';
                    const suggestionNeedsDepartment = Boolean(
                      !persisted[roomKey] && !isDepartmentSuggested && rawSuggestedDepartment
                      && !departmentOptions.includes(rawSuggestedDepartment) && !String(row.primaryDepartment || '').trim()
                    );
                    return (
                      <tr key={roomKey} style={rowStyle(dirty)}>
                        <td style={{ ...bodyCell, minWidth: 170 }}>
                          <span style={{ fontWeight: 600 }}>{building} {room}</span>
                          <span
                            style={{ ...neutralPill, marginLeft: 6 }}
                            title={source === 'office'
                              ? "From Airtable's room inventory (an office), not the class schedule"
                              : 'From the imported class schedule'}
                          >
                            {source === 'office' ? 'Office' : 'Scheduled'}
                          </span>
                          {suggestionNeedsCategory ? (
                            <div style={{ ...mutedStyle, marginTop: 4 }}>
                              Airtable suggests &quot;{rawSuggestedCategory}&quot; — add it in Space targets to use it.
                            </div>
                          ) : null}
                          {suggestionNeedsDepartment ? (
                            <div style={{ ...mutedStyle, marginTop: 4 }}>
                              Airtable suggests &quot;{rawSuggestedDepartment}&quot;, which isn&apos;t in the enrollment projections.
                            </div>
                          ) : null}
                          {rowErrors.length ? <div style={{ ...errorStyle, marginTop: 4 }}>{rowErrors.join('; ')}</div> : null}
                        </td>
                        <td style={bodyCell}>
                          <select
                            value={row.spaceCategory}
                            aria-label={`${building} ${room} space category`}
                            onChange={(e) => handleFieldChange(roomKey, 'spaceCategory', e.target.value)}
                            disabled={noCategoriesYet}
                            style={{ ...mfInputStyle, minWidth: 130 }}
                          >
                            <option value="">Untagged</option>
                            {categoryOptions.map((category) => <option key={category} value={category}>{category}</option>)}
                          </select>
                          {isSuggested ? (
                            <div style={{ marginTop: 4 }}>
                              <span style={warningPill} title={`Airtable room type: "${airtableRoomType}"`}>Suggested — not saved</span>
                            </div>
                          ) : null}
                        </td>
                        <td style={bodyCell}>
                          <select
                            value={row.primaryDepartment || ''}
                            aria-label={`${building} ${room} department`}
                            onChange={(e) => handleFieldChange(roomKey, 'primaryDepartment', e.target.value)}
                            disabled={noDepartmentsYet}
                            style={{ ...mfInputStyle, minWidth: 150 }}
                          >
                            <option value="">No department</option>
                            {departmentOptions.map((department) => <option key={department} value={department}>{department}</option>)}
                          </select>
                          {isDepartmentSuggested ? (
                            <div style={{ marginTop: 4 }}>
                              <span style={warningPill} title={`Airtable department: "${airtableDepartment}"`}>Suggested — not saved</span>
                            </div>
                          ) : null}
                        </td>
                        <td style={bodyCell}>
                          <input
                            type="text"
                            aria-label={`${building} ${room} notes`}
                            placeholder="Optional"
                            value={row.notes}
                            onChange={(e) => handleFieldChange(roomKey, 'notes', e.target.value)}
                            style={{ ...mfInputStyle, width: '100%', minWidth: 140 }}
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : roomList.length ? (
            <div style={{ ...mutedStyle, marginTop: 8 }}>No rooms match these filters.</div>
          ) : null}

          <Messages loadError={loadError} saveMessage={saveMessage} saveError={saveError} />
        </div>
      )}
    </ChartCard>
  );
}

// --- Department targets -------------------------------------------------------------
// Optional per-department targets for Classroom / Lab / Office (whichever
// exist), used instead of the category's default for that department only.
// Each pair follows its category's formula type. Pairs with no saved target
// and a master-plan reference are pre-filled (never saved on their own).
const DEPARTMENT_TARGET_CATEGORIES = ['Classroom', 'Lab', 'Office'];
const EMPTY_PAIR_ROW = { sfPerStationTarget: '', targetUtilizationRatePct: '', sfPerFteTarget: '' };

function DepartmentTargetsCard({ data, onDirtyChange }) {
  const [categoryOptions, setCategoryOptions] = useState([]);
  const [categoryOptionsLoaded, setCategoryOptionsLoaded] = useState(false);
  const [categoryFormulaTypeByCategory, setCategoryFormulaTypeByCategory] = useState(() => new Map());
  const [departmentOptions, setDepartmentOptions] = useState([]);
  const [departmentOptionsLoaded, setDepartmentOptionsLoaded] = useState(false);
  const [form, setForm] = useState({}); // pairKey -> {sfPerStationTarget, targetUtilizationRatePct, sfPerFteTarget}
  const [persisted, setPersisted] = useState({}); // pairKey -> saved values, only pairs with a saved target
  const [overridesLoaded, setOverridesLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState('');
  const [saveError, setSaveError] = useState('');
  const [suggestedPairKeys, setSuggestedPairKeys] = useState(() => new Set());

  const overridesCollection = useMemo(() => data.collectionRef('departmentOverrides'), [data]);
  const overridesRaw = data.raw.departmentOverrides;
  const dataReady = data.status === 'ready' || data.status === 'error';

  useEffect(() => {
    if (!dataReady) return;
    const docs = data.raw.spaceConfig;
    setCategoryOptions(docs.map((d) => d.id).sort((a, b) => a.localeCompare(b)));
    setCategoryFormulaTypeByCategory(new Map(docs.map((d) => [d.id, detectFormulaType(d.data)])));
    setCategoryOptionsLoaded(true);
  }, [dataReady, data.raw.spaceConfig]);

  useEffect(() => {
    if (!dataReady) return;
    const names = new Set();
    data.raw.enrollmentProjections.forEach((d) => {
      if (String(d.data.division || '').trim().toLowerCase() === 'overall') return;
      const department = String(d.data.department || '').trim();
      if (department) names.add(department);
    });
    setDepartmentOptions(Array.from(names).sort((a, b) => a.localeCompare(b)));
    setDepartmentOptionsLoaded(true);
  }, [dataReady, data.raw.enrollmentProjections]);

  const availableTargetCategories = useMemo(
    () => DEPARTMENT_TARGET_CATEGORIES.filter((category) => categoryOptions.includes(category)),
    [categoryOptions]
  );
  const pairList = useMemo(() => {
    const pairs = [];
    departmentOptions.forEach((department) => {
      availableTargetCategories.forEach((category) => {
        pairs.push({
          category,
          department,
          pairKey: `${category}||${department}`,
          formulaType: categoryFormulaTypeByCategory.get(category) || 'station'
        });
      });
    });
    return pairs;
  }, [departmentOptions, availableTargetCategories, categoryFormulaTypeByCategory]);

  const loadOverrides = useCallback(async () => {
    if (!dataReady) return;
    setLoading(true);
    setLoadError('');
    try {
      const snap = asSnapshot(overridesRaw);
      const nextPersisted = {};
      const nextPersistedForm = {};
      snap.docs.forEach((docSnap) => {
        const docData = docSnap.data() || {};
        const category = String(docData.category || '').trim();
        const department = String(docData.department || '').trim();
        if (!category || !department) return;
        const pairKey = `${category}||${department}`;
        const formulaType = detectFormulaType(docData);
        if (formulaType === 'fte') {
          const sfFte = Number(docData.sfPerFteTarget);
          nextPersisted[pairKey] = { formulaType, sfPerFteTarget: Number.isFinite(sfFte) ? sfFte : null, sfPerStationTarget: null, targetUtilizationRate: null };
          nextPersistedForm[pairKey] = { sfPerFteTarget: Number.isFinite(sfFte) ? String(sfFte) : '', sfPerStationTarget: '', targetUtilizationRatePct: '' };
        } else {
          const sf = Number(docData.sfPerStationTarget);
          const rate = Number(docData.targetUtilizationRate);
          nextPersisted[pairKey] = {
            formulaType,
            sfPerStationTarget: Number.isFinite(sf) ? sf : null,
            targetUtilizationRate: Number.isFinite(rate) ? rate : null,
            sfPerFteTarget: null
          };
          nextPersistedForm[pairKey] = {
            sfPerStationTarget: Number.isFinite(sf) ? String(sf) : '',
            targetUtilizationRatePct: Number.isFinite(rate) ? fractionToPctText(rate) : '',
            sfPerFteTarget: ''
          };
        }
      });
      setPersisted(nextPersisted);
      // Merge: keep unsaved suggestions / edits on pairs with no saved target;
      // a saved value always wins.
      setForm((prev) => ({ ...prev, ...nextPersistedForm }));
      setOverridesLoaded(true);
    } catch (error) {
      setLoadError(String(error?.message || 'Failed to load department targets.'));
      setOverridesLoaded(true);
    } finally {
      setLoading(false);
    }
  }, [dataReady, overridesRaw]);

  useEffect(() => {
    void loadOverrides();
  }, [loadOverrides]);

  // Master-plan pre-fill, tracked per (pair, formula type) so a pair whose
  // category's formula type changes is evaluated again. Never overwrites a
  // saved target for the current type or a field that already has a value.
  const suggestionAppliedFormulaTypeRef = useRef(new Map());

  useEffect(() => {
    if (!categoryOptionsLoaded || !departmentOptionsLoaded || !overridesLoaded) return;
    if (!pairList.length) return;

    const nextSuggestedAdditions = new Set();
    let changed = false;
    setForm((prev) => {
      const next = { ...prev };
      pairList.forEach(({ department, pairKey, formulaType }) => {
        if (suggestionAppliedFormulaTypeRef.current.get(pairKey) === formulaType) return;
        if (persisted[pairKey]?.formulaType === formulaType) {
          suggestionAppliedFormulaTypeRef.current.set(pairKey, formulaType);
          return;
        }
        const row = next[pairKey];
        if (formulaType === 'fte') {
          if (row && String(row.sfPerFteTarget || '').trim()) {
            suggestionAppliedFormulaTypeRef.current.set(pairKey, formulaType);
            return;
          }
          const reference = getMasterPlanOfficeSpaceTarget(department, departmentOptions);
          suggestionAppliedFormulaTypeRef.current.set(pairKey, formulaType);
          if (!reference) return;
          next[pairKey] = { ...EMPTY_PAIR_ROW, ...row, sfPerFteTarget: String(reference.sfPerFteTarget) };
        } else {
          if (row && (String(row.sfPerStationTarget || '').trim() || String(row.targetUtilizationRatePct || '').trim())) {
            suggestionAppliedFormulaTypeRef.current.set(pairKey, formulaType);
            return;
          }
          const reference = getMasterPlanSpaceTarget(department, departmentOptions);
          suggestionAppliedFormulaTypeRef.current.set(pairKey, formulaType);
          if (!reference) return;
          next[pairKey] = {
            sfPerFteTarget: '',
            ...row,
            sfPerStationTarget: String(reference.sfPerStationTarget),
            targetUtilizationRatePct: fractionToPctText(reference.targetUtilizationRate)
          };
        }
        nextSuggestedAdditions.add(pairKey);
        changed = true;
      });
      return changed ? next : prev;
    });
    if (nextSuggestedAdditions.size) {
      setSuggestedPairKeys((prev) => {
        const merged = new Set(prev);
        nextSuggestedAdditions.forEach((pairKey) => merged.add(pairKey));
        return merged;
      });
    }
  }, [categoryOptionsLoaded, departmentOptionsLoaded, overridesLoaded, pairList, persisted, departmentOptions]);

  const handleFieldChange = useCallback((pairKey, field, value) => {
    setForm((prev) => ({ ...prev, [pairKey]: { ...prev[pairKey], [field]: value } }));
    setSuggestedPairKeys((prev) => {
      if (!prev.has(pairKey)) return prev;
      const next = new Set(prev);
      next.delete(pairKey);
      return next;
    });
  }, []);

  const isPairDirty = useCallback((pairKey, formulaType) => {
    const row = form[pairKey];
    if (!row) return false;
    const saved = persisted[pairKey];
    if (!saved) {
      return formulaType === 'fte'
        ? Boolean(String(row.sfPerFteTarget || '').trim())
        : Boolean(String(row.sfPerStationTarget || '').trim() || String(row.targetUtilizationRatePct || '').trim());
    }
    // The category's formula type changed since this target was saved.
    if (formulaType !== saved.formulaType) return true;
    if (formulaType === 'fte') return Number(row.sfPerFteTarget) !== saved.sfPerFteTarget;
    const sf = Number(row.sfPerStationTarget);
    const rate = pctToFraction(row.targetUtilizationRatePct);
    return sf !== saved.sfPerStationTarget || rate !== saved.targetUtilizationRate;
  }, [form, persisted]);

  const dirtyPairs = useMemo(
    () => pairList.filter(({ pairKey, formulaType }) => isPairDirty(pairKey, formulaType)),
    [pairList, isPairDirty]
  );
  const hasManualEdits = dirtyPairs.some(({ pairKey }) => !suggestedPairKeys.has(pairKey));
  useReportDirty(onDirtyChange, 'departmentTargets', hasManualEdits);

  const handleSave = useCallback(async () => {
    if (saving || !dirtyPairs.length) return;
    setSaving(true);
    setSaveMessage('');
    setSaveError('');

    const invalid = dirtyPairs
      .map(({ category, department, pairKey, formulaType }) => ({ label: `${department} (${category})`, errors: validateTargetRow(form[pairKey], formulaType) }))
      .filter((entry) => entry.errors.length);
    if (invalid.length) {
      setSaveError(invalid.map((entry) => `${entry.label}: ${entry.errors.join('; ')}`).join(' · '));
      setSaving(false);
      return;
    }

    try {
      for (const { category, department, pairKey, formulaType } of dirtyPairs) {
        const row = form[pairKey];
        const payload = formulaType === 'fte'
          ? { category, department, sfPerFteTarget: Number(row.sfPerFteTarget), effectiveDate: serverTimestamp() }
          : {
            category,
            department,
            sfPerStationTarget: Number(row.sfPerStationTarget),
            targetUtilizationRate: pctToFraction(row.targetUtilizationRatePct),
            effectiveDate: serverTimestamp()
          };
        await setDoc(doc(overridesCollection, pairKey), payload);
      }
      setSuggestedPairKeys((prev) => {
        if (!prev.size) return prev;
        const next = new Set(prev);
        dirtyPairs.forEach(({ pairKey }) => next.delete(pairKey));
        return next;
      });
      setSaveMessage(`Saved ${dirtyPairs.length} department ${dirtyPairs.length === 1 ? 'target' : 'targets'}.`);
      await data.reloadCollection('departmentOverrides');
    } catch (error) {
      setSaveError(String(error?.message || 'Failed to save department targets.'));
    } finally {
      setSaving(false);
    }
  }, [saving, dirtyPairs, form, overridesCollection, data]);

  const departmentsWithoutReference = useMemo(
    () => departmentOptions.filter((department) => (
      !getMasterPlanSpaceTarget(department, departmentOptions) && !getMasterPlanOfficeSpaceTarget(department, departmentOptions)
    )),
    [departmentOptions]
  );

  const saveDisabled = saving || !dirtyPairs.length;
  const suggestedCount = dirtyPairs.filter(({ pairKey }) => suggestedPairKeys.has(pairKey)).length;

  return (
    <ChartCard
      title="Department targets"
      subtitle="Optional targets for one department, used instead of the category's default for that department. Blank means the category default applies."
      actions={(
        <Button primary onClick={() => void handleSave()} disabled={saveDisabled}>
          {saving ? 'Saving…' : `Save${dirtyPairs.length ? ` (${dirtyPairs.length})` : ''}`}
        </Button>
      )}
      footnote={'The master plan publishes one combined classroom/lab teaching-space target per department, so suggested classroom and lab targets use the same number. '
        + `Office targets are kept for later: ${OFFICE_TARGET_NOTE.charAt(0).toLowerCase()}${OFFICE_TARGET_NOTE.slice(1)}`}
      autoHeight
    >
      {() => (
        <div>
          {suggestedCount ? (
            <div style={{ ...warningBox, marginBottom: 10 }}>
              {suggestedCount} {suggestedCount === 1 ? 'target is' : 'targets are'} filled in from the master plan but not saved. Review them, then Save.
            </div>
          ) : null}
          {!availableTargetCategories.length && categoryOptionsLoaded ? (
            <div style={{ ...warningBox, marginBottom: 10 }}>Add Classroom, Lab or Office in Space targets to set department targets.</div>
          ) : null}
          {departmentsWithoutReference.length ? (
            <div style={{ ...mutedStyle, marginBottom: 10 }}>
              No master-plan reference for {departmentsWithoutReference.join(', ')} — enter those by hand if needed.
            </div>
          ) : null}

          {loading && !departmentOptionsLoaded ? (
            <div style={mutedStyle}>Loading department targets…</div>
          ) : !pairList.length ? (
            <div style={mutedStyle}>
              {departmentOptionsLoaded && !departmentOptions.length
                ? 'No departments yet — upload the enrollment projections first.'
                : 'Nothing to set yet.'}
            </div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', background: MF.surface.page, fontFamily: MF.type.family }}>
                <thead>
                  <tr>
                    <th style={headerCell}>Department</th>
                    <th style={headerCell}>Category</th>
                    <th style={headerCell}>Target</th>
                    <th style={headerCell}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {pairList.map(({ category, department, pairKey, formulaType }) => {
                    const row = form[pairKey] || EMPTY_PAIR_ROW;
                    const dirty = isPairDirty(pairKey, formulaType);
                    const isSuggested = suggestedPairKeys.has(pairKey);
                    const saved = persisted[pairKey];
                    const rowErrors = dirty ? validateTargetRow(row, formulaType) : [];
                    const masterPlanLabel = MASTER_PLAN_DEPARTMENT_LABELS[department];
                    const onChange = (field, value) => handleFieldChange(pairKey, field, value);
                    let status;
                    if (isSuggested) {
                      status = (
                        <span style={warningPill} title={masterPlanLabel ? `The master plan calls this department "${masterPlanLabel}".` : undefined}>
                          Suggested from master plan — not saved
                        </span>
                      );
                    } else if (dirty) {
                      status = <span style={warningPill}>Not saved</span>;
                    } else if (saved) {
                      status = <span style={neutralPill}>{OVERRIDE_TAG}</span>;
                    } else {
                      status = <span style={mutedStyle}>Category default</span>;
                    }
                    return (
                      <tr key={pairKey} style={rowStyle(dirty)}>
                        <td style={{ ...bodyCell, fontWeight: 600 }}>{department}</td>
                        <td style={bodyCell}>{category}</td>
                        <td style={bodyCell}>
                          {formulaType === 'fte' ? <FteInput row={row} onChange={onChange} /> : <StationInputs row={row} onChange={onChange} />}
                          {rowErrors.length ? <div style={{ ...errorStyle, marginTop: 4 }}>{rowErrors.join('; ')}</div> : null}
                        </td>
                        <td style={bodyCell}>{status}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          <Messages loadError={loadError} saveMessage={saveMessage} saveError={saveError} />
        </div>
      )}
    </ChartCard>
  );
}

// --- Enrollment projections upload -------------------------------------------------
// Choosing a file only parses it and shows a preview. Confirm & Save asks
// first (dialog), then clears every saved record and writes the new ones --
// so a newer workbook cleanly replaces the old one. Reloads afterwards whether
// the save succeeded or failed.
function formatEnrollmentValue(value) {
  return Number.isFinite(value) ? (Math.round(value * 100) / 100).toLocaleString('en-US') : '—';
}

function ConfirmReplaceDialog({ savedCount, newCount, onCancel, onConfirm }) {
  return (
    <WorkspaceShell size="dialog" title="Replace enrollment projections" onClose={onCancel}>
      <div style={{ fontSize: 13, color: MF.ink.primary, lineHeight: 1.5 }}>
        {savedCount
          ? `This replaces all ${savedCount} saved enrollment ${savedCount === 1 ? 'record' : 'records'} with the ${newCount} in this file. Continue?`
          : `This saves the ${newCount} enrollment ${newCount === 1 ? 'record' : 'records'} in this file. Continue?`}
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 20 }}>
        <Button onClick={onCancel}>Cancel</Button>
        <Button primary onClick={onConfirm}>{savedCount ? 'Replace records' : 'Save records'}</Button>
      </div>
    </WorkspaceShell>
  );
}

function EnrollmentTable({ rows, year }) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', background: MF.surface.page, fontFamily: MF.type.family }}>
        <thead>
          <tr>
            <th style={headerCell}>Division</th>
            <th style={headerCell}>Department</th>
            <th style={{ ...headerCell, textAlign: 'right' }}>{year ?? '—'} headcount</th>
            <th style={{ ...headerCell, textAlign: 'right' }}>{year ?? '—'} total FTE</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((entry) => {
            const isOverall = String(entry.division).trim().toLowerCase() === 'overall';
            return (
              <tr key={entry.key} style={isOverall ? { background: MF.surface.card } : undefined}>
                <td style={{ ...bodyCell, color: MF.ink.secondary }}>{isOverall ? 'Campus' : String(entry.division).trim()}</td>
                <td style={{ ...bodyCell, fontWeight: isOverall ? 700 : 600 }}>{String(entry.department).trim()}</td>
                <td style={numCell}>{formatEnrollmentValue(entry.years?.[year]?.studentHeadcount)}</td>
                <td style={numCell}>{formatEnrollmentValue(entry.years?.[year]?.totalFte)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function EnrollmentUploadCard({ data, onDirtyChange }) {
  const [parsing, setParsing] = useState(false);
  const [parseError, setParseError] = useState('');
  const [parsedResult, setParsedResult] = useState(null); // { years, instituteRecord, departmentRecords, sheetName, sourceFileName }
  const [savePhase, setSavePhase] = useState(null); // null | 'clearing' | 'writing'
  const [saveMessage, setSaveMessage] = useState('');
  const [saveError, setSaveError] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);

  const enrollmentProjectionsCollection = useMemo(() => data.collectionRef('enrollmentProjections'), [data]);
  const firstLoadPending = data.status === 'idle' || data.status === 'loading';

  // Saved records: campus first, then by division and department.
  const savedDocs = useMemo(() => {
    const docs = data.raw.enrollmentProjections.map((d) => ({
      key: d.id,
      division: String(d.data?.division || ''),
      department: String(d.data?.department || ''),
      years: d.data?.years || {}
    }));
    return docs.sort((a, b) => {
      const aOverall = a.division.trim().toLowerCase() === 'overall';
      const bOverall = b.division.trim().toLowerCase() === 'overall';
      if (aOverall !== bOverall) return aOverall ? -1 : 1;
      return a.division.localeCompare(b.division) || a.department.localeCompare(b.department);
    });
  }, [data.raw.enrollmentProjections]);

  const savedLatestYear = useMemo(() => {
    let max = null;
    savedDocs.forEach((entry) => {
      Object.keys(entry.years || {}).forEach((y) => {
        const n = Number(y);
        if (Number.isFinite(n) && (max === null || n > max)) max = n;
      });
    });
    return max;
  }, [savedDocs]);

  const previewDocs = useMemo(() => (parsedResult ? toEnrollmentProjectionDocs(parsedResult) : []), [parsedResult]);
  useReportDirty(onDirtyChange, 'enrollmentUpload', previewDocs.length > 0);

  const handleFileSelected = useCallback(async (event) => {
    const file = event.target.files?.[0] || null;
    // Reset so choosing the same file again still re-parses.
    event.target.value = '';
    if (!file) return;
    setParsing(true);
    setParseError('');
    setParsedResult(null);
    setSaveMessage('');
    setSaveError('');
    try {
      const result = await parseEnrollmentProjectionsFile(file);
      if (!result.instituteRecord && !result.departmentRecords.length) {
        throw new Error(
          "The workbook was read, but no campus or department figures were found. Check that division names are in column A, "
          + 'department names in column B, and the headcount / FTE labels in column B or C.'
        );
      }
      setParsedResult(result);
    } catch (error) {
      setParseError(String(error?.message || "Couldn't read the workbook."));
    } finally {
      setParsing(false);
    }
  }, []);

  const handleSave = useCallback(async () => {
    if (savePhase || !previewDocs.length) return;
    let phase = 'clearing';
    setSavePhase(phase);
    setSaveMessage('');
    setSaveError('');
    try {
      // Clear the saved records first, so the result is exactly this file.
      const existingSnap = await getDocs(enrollmentProjectionsCollection);
      const existingRefs = existingSnap.docs.map((docSnap) => docSnap.ref);
      for (let i = 0; i < existingRefs.length; i += BATCH_CHUNK_SIZE) {
        const chunk = existingRefs.slice(i, i + BATCH_CHUNK_SIZE);
        if (!chunk.length) continue;
        const batch = writeBatch(db);
        chunk.forEach((ref) => batch.delete(ref));
        await batch.commit();
      }

      phase = 'writing';
      setSavePhase(phase);
      for (let i = 0; i < previewDocs.length; i += BATCH_CHUNK_SIZE) {
        const chunk = previewDocs.slice(i, i + BATCH_CHUNK_SIZE);
        if (!chunk.length) continue;
        const batch = writeBatch(db);
        chunk.forEach((entry) => {
          batch.set(doc(enrollmentProjectionsCollection, entry.deptId), {
            division: entry.division,
            department: entry.department,
            years: entry.years,
            importedAt: serverTimestamp()
          }, { merge: true });
        });
        await batch.commit();
      }

      setSaveMessage(
        `Replaced ${existingRefs.length} old ${existingRefs.length === 1 ? 'record' : 'records'} with `
        + `${previewDocs.length} from "${parsedResult?.sourceFileName || 'the uploaded file'}".`
      );
      setParsedResult(null);
      await data.reloadCollection('enrollmentProjections');
    } catch (error) {
      const phaseLabel = phase === 'clearing'
        ? 'Failed while clearing the old records (nothing new was saved): '
        : 'Failed while saving the new records (the old ones were already cleared): ';
      setSaveError(phaseLabel + String(error?.message || 'unknown error.'));
      void data.reloadCollection('enrollmentProjections');
    } finally {
      setSavePhase(null);
    }
  }, [savePhase, previewDocs, enrollmentProjectionsCollection, parsedResult, data]);

  const yearRangeLabel = parsedResult?.years?.length
    ? (parsedResult.years.length === 1
      ? String(parsedResult.years[0])
      : `${parsedResult.years[0]}–${parsedResult.years[parsedResult.years.length - 1]}`)
    : '';
  const firstYear = parsedResult?.years?.[0];
  const busy = parsing || Boolean(savePhase);

  return (
    <ChartCard
      title="Enrollment projections upload"
      subtitle="Upload the enrollment and FTE projections workbook. Choosing a file shows a preview; nothing is saved until you confirm."
      autoHeight
    >
      {() => (
        <div>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
            <input
              type="file"
              accept=".xlsx,.xls"
              aria-label="Enrollment projections workbook"
              onChange={(e) => void handleFileSelected(e)}
              disabled={busy}
              style={{ fontSize: 12, fontFamily: 'inherit', color: MF.ink.primary }}
            />
            {parsing ? <span style={mutedStyle}>Reading…</span> : null}
          </div>
          {parseError ? <div role="alert" style={{ ...errorStyle, marginTop: 8 }}>{parseError}</div> : null}

          {parsedResult ? (
            <div style={{ marginTop: 12 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: MF.ink.primary }}>Preview — not saved</div>
              <div style={{ ...noteStyle, marginTop: 2 }}>
                &quot;{parsedResult.sourceFileName}&quot;: {parsedResult.departmentRecords.length}{' '}
                {parsedResult.departmentRecords.length === 1 ? 'department' : 'departments'}
                {parsedResult.instituteRecord ? ' plus the campus total' : ''}, {yearRangeLabel}.
              </div>
              {!parsedResult.instituteRecord ? (
                <div style={{ ...warningBox, marginTop: 8 }}>
                  No campus total was found (a &quot;Hastings College&quot; block with headcount and FTE rows directly under it). Check the workbook before saving.
                </div>
              ) : null}
              <div style={{ marginTop: 8 }}>
                <EnrollmentTable rows={previewDocs.map((d) => ({ ...d, key: d.deptId }))} year={firstYear} />
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 10 }}>
                <Button onClick={() => setParsedResult(null)} disabled={busy}>Discard preview</Button>
                <Button primary onClick={() => setConfirmOpen(true)} disabled={busy || !previewDocs.length}>
                  {savePhase === 'clearing' ? 'Clearing old records…'
                    : savePhase === 'writing' ? 'Saving…'
                      : `Confirm & Save (${previewDocs.length})`}
                </Button>
              </div>
            </div>
          ) : null}

          <div style={{ marginTop: 16 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: MF.ink.primary }}>
              Saved now{savedDocs.length ? ` · ${savedDocs.length} ${savedDocs.length === 1 ? 'record' : 'records'}` : ''}
            </div>
            {firstLoadPending ? (
              <div style={{ ...mutedStyle, marginTop: 4 }}>Loading…</div>
            ) : savedDocs.length ? (
              <div style={{ marginTop: 8 }}><EnrollmentTable rows={savedDocs} year={savedLatestYear} /></div>
            ) : (
              <div style={{ ...mutedStyle, marginTop: 4 }}>No enrollment projections saved yet.</div>
            )}
          </div>

          <Messages loadError={data.status === 'error' ? data.error : ''} saveMessage={saveMessage} saveError={saveError} />

          {confirmOpen ? (
            <ConfirmReplaceDialog
              savedCount={savedDocs.length}
              newCount={previewDocs.length}
              onCancel={() => setConfirmOpen(false)}
              onConfirm={() => { setConfirmOpen(false); void handleSave(); }}
            />
          ) : null}
        </div>
      )}
    </ChartCard>
  );
}

// --- Tab ---------------------------------------------------------------------------
// onDirtyChange(cardId, hasUnsavedEdits): see the header comment.
export default function SpaceGrowthSetupTab({ data, onDirtyChange }) {
  return (
    <MfGrid>
      <MfCol span={12}><SpaceTargetsCard data={data} onDirtyChange={onDirtyChange} /></MfCol>
      <MfCol span={12}><RoomTaggingCard data={data} onDirtyChange={onDirtyChange} /></MfCol>
      <MfCol span={12}><DepartmentTargetsCard data={data} onDirtyChange={onDirtyChange} /></MfCol>
      <MfCol span={12}><EnrollmentUploadCard data={data} onDirtyChange={onDirtyChange} /></MfCol>
    </MfGrid>
  );
}
