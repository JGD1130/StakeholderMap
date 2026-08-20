// src/components/ClassroomUtilizationPanel.jsx
//
// Classroom Utilization module (Hastings-only, admin-only, gated by
// config.enableClassroomUtilization -- off by default, same convention as
// CapitalPrioritiesPanel/enableCapitalPriorities). Exports TWO top-level
// panel components, each its own .dashboard-box in StakeholderMap.jsx, both
// gated by the same enableClassroomUtilization flag (no second flag) -- see
// the split comment directly above each export for the full reasoning:
//   - `ClassroomUtilizationPanel` (default export, title "Classroom
//     Utilization"): Import Schedule, Terms, Utilization Results.
//   - `SpaceGrowthProjectionsPanel` (named export, title "Space Growth
//     Projections"): Space Configuration, Room Utilization Tagging,
//     Enrollment & FTE Projections, Space Growth / Right-Sizing.
// Every section function in between is unchanged from before the split --
// only which of the two exported components renders which sections moved.
//
// "Import Schedule" fetches the existing, read-only /class-schedule endpoint
// and writes the deduped result into universities/hastings/courseMeetings --
// the only collection either panel ever writes to via that action. Nothing
// here touches server.js or any other panel.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Timestamp, collection, doc, getDocs, onSnapshot, serverTimestamp, setDoc, writeBatch } from 'firebase/firestore';
import { db } from '../firebaseConfig';
import {
  COURSE_MEETINGS_COLLECTION,
  ENROLLMENT_PROJECTIONS_COLLECTION,
  ROOM_UTILIZATION_META_COLLECTION,
  SPACE_CONFIG_COLLECTION,
  TERMS_COLLECTION
} from '../utils/classroomUtilizationSchema';
import {
  buildCourseMeetingId,
  dedupeCrossTalliedScheduleRows,
  fetchClassScheduleRows,
  mapScheduleEntryToCourseMeetingDoc
} from '../utils/classroomScheduleImport';
import { deriveDistinctRoomsFromCourseMeetings } from '../utils/roomUtilizationMeta';
import { computeClassroomUtilization, fetchAirtableRoomsForUtilization, buildAirtableAreaMap } from '../utils/classroomUtilizationCalc';
import { buildAirtableRoomTypeMap, suggestSpaceCategoryFromRoomType } from '../utils/roomTypeSuggestion';
import { parseEnrollmentProjectionsFile, toEnrollmentProjectionDocs } from '../utils/enrollmentProjectionsImport';
import { computeSpaceGrowth } from '../utils/spaceGrowthCalc';

const HASTINGS_UNIVERSITY_ID = 'hastings';
const BATCH_CHUNK_SIZE = 400; // mirrors the existing writeBatch chunking convention elsewhere in this codebase (Firestore's own cap is 500 ops/batch)

function summarizeDocs(docs) {
  const rooms = new Set();
  docs.forEach((data) => {
    const building = String(data?.building || '').trim().toLowerCase();
    const room = String(data?.room || '').trim().toLowerCase();
    if (building || room) rooms.add(`${building}||${room}`);
  });
  return { meetingCount: docs.length, roomCount: rooms.size };
}

// Space Configuration -- one row per space category (universities/hastings/
// spaceConfig/{spaceCategory}), sfPerStationTarget + targetUtilizationRate.
//
// classroomUtilizationSchema.js does NOT actually define a space-category
// list -- only prose examples ("e.g. 'Classroom', 'Lab'") in its JSDoc, no
// exported array. Rather than invent a fixed category list on Clark's
// behalf (this module is meant to generalize to future clients, and the
// real categories are his call, not a guess baked into this build step),
// this section is fully data-driven: it renders one row per spaceConfig doc
// that already exists in Firestore, plus a small "add category" control to
// create new ones by name. Nothing here assumes any particular count or set
// of categories -- extending the list later means typing a new name in the
// UI, not touching code.
function pctToFraction(pctText) {
  const n = Number(pctText);
  return Number.isFinite(n) ? n / 100 : NaN;
}

function fractionToPctText(fraction) {
  return Number.isFinite(fraction) ? String(Math.round(fraction * 10000) / 100) : '';
}

function validateSpaceConfigRow(row) {
  const sf = Number(row.sfPerStationTarget);
  const pct = Number(row.targetUtilizationRatePct);
  const errors = [];
  if (!Number.isFinite(sf) || sf <= 0) errors.push('SF/station must be a positive number');
  if (!Number.isFinite(pct) || pct <= 0 || pct > 100) errors.push('Target utilization must be > 0% and <= 100%');
  return errors;
}

function SpaceConfigSection() {
  // form: current editable text-field values, keyed by category name.
  // persisted: last known Firestore-saved values for the same categories
  // (numeric, not text) -- diffing form against persisted is how "changed
  // since load/last save" (dirty) is determined, per the save button only
  // writing categories that actually changed.
  const [form, setForm] = useState({});
  const [persisted, setPersisted] = useState({});
  const [categoryOrder, setCategoryOrder] = useState([]);
  const [newCategoryName, setNewCategoryName] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState('');
  const [saveError, setSaveError] = useState('');
  // Collapsed by default -- same disclosure pattern as RoomUtilizationMetaSection
  // (layout-only addition; loadSpaceConfig()'s useEffect below still runs
  // unconditionally on mount regardless of open/collapsed state).
  const [sectionOpen, setSectionOpen] = useState(false);

  const spaceConfigCollection = useMemo(
    () => collection(db, 'universities', HASTINGS_UNIVERSITY_ID, SPACE_CONFIG_COLLECTION),
    []
  );

  const loadSpaceConfig = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      const snap = await getDocs(spaceConfigCollection);
      const nextPersisted = {};
      const nextForm = {};
      const order = [];
      snap.docs.forEach((docSnap) => {
        const category = docSnap.id;
        const data = docSnap.data() || {};
        const sf = Number(data.sfPerStationTarget);
        const rate = Number(data.targetUtilizationRate);
        order.push(category);
        nextPersisted[category] = {
          sfPerStationTarget: Number.isFinite(sf) ? sf : null,
          targetUtilizationRate: Number.isFinite(rate) ? rate : null
        };
        nextForm[category] = {
          sfPerStationTarget: Number.isFinite(sf) ? String(sf) : '',
          targetUtilizationRatePct: Number.isFinite(rate) ? fractionToPctText(rate) : ''
        };
      });
      order.sort((a, b) => a.localeCompare(b));
      setCategoryOrder(order);
      setPersisted(nextPersisted);
      setForm(nextForm);
    } catch (error) {
      setLoadError(String(error?.message || 'Failed to load space configuration.'));
    } finally {
      setLoading(false);
    }
  }, [spaceConfigCollection]);

  useEffect(() => {
    void loadSpaceConfig();
  }, [loadSpaceConfig]);

  const handleFieldChange = useCallback((category, field, value) => {
    setForm((prev) => ({
      ...prev,
      [category]: { ...prev[category], [field]: value }
    }));
  }, []);

  const handleAddCategory = useCallback(() => {
    const name = newCategoryName.trim();
    if (!name || categoryOrder.includes(name)) return;
    setCategoryOrder((prev) => [...prev, name].sort((a, b) => a.localeCompare(b)));
    setForm((prev) => ({ ...prev, [name]: { sfPerStationTarget: '', targetUtilizationRatePct: '' } }));
    setNewCategoryName('');
  }, [newCategoryName, categoryOrder]);

  const handleRemoveUnsavedCategory = useCallback((category) => {
    // Only ever offered for categories with no persisted doc yet (see the
    // render below) -- removes the in-progress row, never deletes anything
    // from Firestore.
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
    if (!saved) {
      return Boolean(String(row.sfPerStationTarget || '').trim() || String(row.targetUtilizationRatePct || '').trim());
    }
    const sf = Number(row.sfPerStationTarget);
    const rate = pctToFraction(row.targetUtilizationRatePct);
    return sf !== saved.sfPerStationTarget || rate !== saved.targetUtilizationRate;
  }, [form, persisted]);

  const dirtyCategories = useMemo(
    () => categoryOrder.filter((category) => isCategoryDirty(category)),
    [categoryOrder, isCategoryDirty]
  );

  const handleSave = useCallback(async () => {
    if (saving || !dirtyCategories.length) return;
    setSaving(true);
    setSaveMessage('');
    setSaveError('');

    // Validate every changed row before writing anything -- one invalid row
    // blocks the whole save rather than silently writing the valid ones and
    // skipping the rest.
    const invalid = dirtyCategories
      .map((category) => ({ category, errors: validateSpaceConfigRow(form[category]) }))
      .filter((entry) => entry.errors.length);
    if (invalid.length) {
      setSaveError(invalid.map((entry) => `${entry.category}: ${entry.errors.join('; ')}`).join(' | '));
      setSaving(false);
      return;
    }

    try {
      // Plain overwrite (no {merge: true}) -- per Clark's "simple overwrite
      // model, one doc per space category, no history" decision. The form
      // always supplies both fields together, so there's no partial-update
      // case to preserve; a full setDoc also means a field that silently
      // failed to reach the form can't hide behind a stale merged value.
      for (const category of dirtyCategories) {
        const row = form[category];
        const payload = {
          sfPerStationTarget: Number(row.sfPerStationTarget),
          targetUtilizationRate: pctToFraction(row.targetUtilizationRatePct),
          effectiveDate: serverTimestamp()
        };
        await setDoc(doc(spaceConfigCollection, category), payload);
      }
      setSaveMessage(
        `Saved ${dirtyCategories.length.toLocaleString()} space categor${dirtyCategories.length === 1 ? 'y' : 'ies'}.`
      );
      await loadSpaceConfig();
    } catch (error) {
      setSaveError(String(error?.message || 'Failed to save space configuration.'));
    } finally {
      setSaving(false);
    }
  }, [saving, dirtyCategories, form, spaceConfigCollection, loadSpaceConfig]);

  // Category count visible in the summary label without expanding, same
  // "state visible collapsed" convention RoomUtilizationMetaSection's
  // tagged/untagged count already established.
  const summaryLabel = categoryOrder.length
    ? `Space Configuration (${categoryOrder.length} categor${categoryOrder.length === 1 ? 'y' : 'ies'})`
    : 'Space Configuration';

  return (
    <div style={{ marginTop: 10, borderTop: '1px solid #edf2f7', paddingTop: 8 }}>
      {/* Collapsed by default, Save button kept OUTSIDE <summary> -- same
          reasoning as RoomUtilizationMetaSection: a nested interactive
          element inside <summary> fights the native click-to-toggle. */}
      <details open={sectionOpen} onToggle={(event) => setSectionOpen(event.currentTarget.open)}>
        <summary style={{ fontWeight: 700, fontSize: 12.5, cursor: 'pointer', color: '#1d2939' }}>
          {summaryLabel}
        </summary>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, marginTop: 6 }}>
          <button
            className="btn"
            type="button"
            onClick={() => void handleSave()}
            disabled={saving || !dirtyCategories.length}
          >
            {saving ? 'Saving...' : `Save Space Configuration${dirtyCategories.length ? ` (${dirtyCategories.length})` : ''}`}
          </button>
        </div>

        <div style={{ marginTop: 4, fontSize: 10.5, color: '#667085', lineHeight: 1.35 }}>
          SF/station target and target utilization rate per space category. Changed rows are highlighted and
          saved together with the button above.
        </div>

        {loading && !categoryOrder.length ? (
        <div style={{ marginTop: 8, fontSize: 11, color: '#667085' }}>Loading space configuration...</div>
      ) : (
        <div style={{ marginTop: 8, display: 'grid', gap: 6 }}>
          {categoryOrder.map((category) => {
            const row = form[category] || { sfPerStationTarget: '', targetUtilizationRatePct: '' };
            const dirty = isCategoryDirty(category);
            const isUnsaved = !persisted[category];
            const rowErrors = dirty ? validateSpaceConfigRow(row) : [];
            return (
              <div
                key={category}
                style={{
                  // flex-wrap (was a fixed-column grid) -- the grid's
                  // "1fr 90px 90px auto" columns had no way to reflow, so a
                  // narrow column forced the row wider than its container
                  // instead of wrapping. Each field below gets a minWidth so
                  // it stays legible; the row itself never forces the
                  // column wider, it just wraps to a second line instead.
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: 6,
                  alignItems: 'center',
                  padding: 6,
                  background: dirty ? '#fffbeb' : '#f8fafc',
                  border: `1px solid ${dirty ? '#fde68a' : '#e5e7eb'}`,
                  borderRadius: 6
                }}
              >
                <div style={{ flex: '1 1 100px', minWidth: 100, fontSize: 11, fontWeight: 600, overflowWrap: 'anywhere' }}>
                  {category}
                  {isUnsaved ? <span style={{ color: '#b45309', fontWeight: 500 }}> (unsaved)</span> : null}
                </div>
                <input
                  type="number"
                  min="0"
                  step="1"
                  placeholder="SF/station"
                  value={row.sfPerStationTarget}
                  onChange={(e) => handleFieldChange(category, 'sfPerStationTarget', e.target.value)}
                  style={{ flex: '0 1 90px', minWidth: 80, fontSize: 11, padding: '3px 5px' }}
                />
                <input
                  type="number"
                  min="0"
                  max="100"
                  step="1"
                  placeholder="Target %"
                  value={row.targetUtilizationRatePct}
                  onChange={(e) => handleFieldChange(category, 'targetUtilizationRatePct', e.target.value)}
                  style={{ flex: '0 1 90px', minWidth: 80, fontSize: 11, padding: '3px 5px' }}
                />
                {isUnsaved ? (
                  <button
                    type="button"
                    onClick={() => handleRemoveUnsavedCategory(category)}
                    style={{ flex: '0 0 auto', background: 'none', border: 'none', color: '#b42318', fontSize: 10.5, cursor: 'pointer', padding: 0 }}
                  >
                    Remove
                  </button>
                ) : null}
                {rowErrors.length ? (
                  <div style={{ flex: '1 1 100%', fontSize: 10, color: '#b42318' }}>{rowErrors.join('; ')}</div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}

      {/* Already flex (not a fixed grid), so this row was never at risk of
          the same overflow -- flex: 1 on the input just shrinks to fit
          rather than forcing extra width. Adding flexWrap + a minWidth
          here anyway, defensively, in case this row grows more fields
          later (same reasoning as the two grid->flex-wrap fixes above). */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
        <input
          type="text"
          placeholder="Add space category (e.g. Classroom, Lab)"
          value={newCategoryName}
          onChange={(e) => setNewCategoryName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') handleAddCategory(); }}
          style={{ flex: '1 1 140px', minWidth: 140, fontSize: 11, padding: '4px 6px' }}
        />
        <button className="btn" type="button" onClick={handleAddCategory} disabled={!newCategoryName.trim()}>
          Add
        </button>
      </div>

      {loadError ? <div style={{ marginTop: 6, fontSize: 10.5, color: '#b42318' }}>{loadError}</div> : null}
      {saveMessage ? <div style={{ marginTop: 6, fontSize: 10.5, color: '#15803d' }}>{saveMessage}</div> : null}
      {saveError ? <div style={{ marginTop: 6, fontSize: 10.5, color: '#b42318' }}>{saveError}</div> : null}
      </details>
    </div>
  );
}

// Terms -- one row per academic term/session (universities/hastings/terms/
// {termId}), per-session grain per Clark's decision: each doc is one
// academicYear + term + sessionNumber combination with its own
// standardWeeklyHours. Mirrors SpaceConfigSection's structure/conventions
// (dirty-tracking against a persisted snapshot, single "Save" button for
// whichever rows changed, validate-before-write, plain setDoc overwrite --
// no {merge: true}, same reasoning as spaceConfig: no partial-update case
// to preserve, and a full overwrite can't hide a field that silently failed
// to reach the form). Same data-driven "Add" flow, no hardcoded term list,
// for the same future-clients reason spaceConfig has no hardcoded category
// list.
//
// termId is deterministic (year-term-session, e.g. "2026-fall-1") rather
// than a random Firestore auto-id, both so it's recognizable in the
// Firestore console and so re-adding the same year/term/session can't
// silently create a duplicate doc -- it's caught before it's even added
// to the local unsaved-row list, let alone written.
function buildTermId({ academicYear, term, sessionNumber }) {
  const yearPart = String(academicYear ?? '').trim() || 'x';
  const termPart = String(term ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'x';
  const sessionPart = String(sessionNumber ?? '').trim() || 'x';
  return `${yearPart}-${termPart}-${sessionPart}`;
}

function dateInputToTimestamp(dateStr) {
  if (!dateStr) return null;
  const [y, m, d] = String(dateStr).split('-').map(Number);
  if (!y || !m || !d) return null;
  // Constructed at UTC midnight (not local midnight) so the round trip back
  // through timestampToDateInput below can't drift a day depending on the
  // browser's timezone -- these are calendar dates, not moments in time.
  return Timestamp.fromDate(new Date(Date.UTC(y, m - 1, d)));
}

function timestampToDateInput(ts) {
  if (!ts?.toDate) return '';
  const d = ts.toDate();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function validateTermRow(row) {
  const errors = [];
  const hours = Number(row.standardWeeklyHours);
  if (!Number.isFinite(hours) || hours <= 0) errors.push('Standard weekly hours must be a positive number');
  const session = Number(row.sessionNumber);
  if (!Number.isInteger(session) || session <= 0) errors.push('Session number must be a positive integer');
  if (!row.startDate) errors.push('Start date is required');
  if (!row.endDate) errors.push('End date is required');
  // ISO "YYYY-MM-DD" strings sort correctly with plain string comparison.
  if (row.startDate && row.endDate && !(row.endDate > row.startDate)) errors.push('End date must be after start date');
  return errors;
}

function TermsSection() {
  const [form, setForm] = useState({});
  const [persisted, setPersisted] = useState({});
  const [termOrder, setTermOrder] = useState([]);
  const [newTermInputs, setNewTermInputs] = useState({ academicYear: '', term: '', sessionNumber: '' });
  const [addError, setAddError] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState('');
  const [saveError, setSaveError] = useState('');
  // Collapsed by default -- same disclosure pattern as RoomUtilizationMetaSection
  // (layout-only addition; loadTerms()'s useEffect below still runs
  // unconditionally on mount regardless of open/collapsed state).
  const [sectionOpen, setSectionOpen] = useState(false);

  const termsCollection = useMemo(
    () => collection(db, 'universities', HASTINGS_UNIVERSITY_ID, TERMS_COLLECTION),
    []
  );

  const loadTerms = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      const snap = await getDocs(termsCollection);
      const nextPersisted = {};
      const nextForm = {};
      const order = [];
      snap.docs.forEach((docSnap) => {
        const termId = docSnap.id;
        const data = docSnap.data() || {};
        const rowValues = {
          academicYear: data.academicYear ?? '',
          term: String(data.term || ''),
          sessionNumber: data.sessionNumber ?? '',
          startDate: timestampToDateInput(data.startDate),
          endDate: timestampToDateInput(data.endDate),
          standardWeeklyHours: Number.isFinite(Number(data.standardWeeklyHours)) ? String(data.standardWeeklyHours) : '',
          isHistorical: Boolean(data.isHistorical)
        };
        order.push(termId);
        nextPersisted[termId] = rowValues;
        nextForm[termId] = rowValues;
      });
      order.sort((a, b) => a.localeCompare(b));
      setTermOrder(order);
      setPersisted(nextPersisted);
      setForm(nextForm);
    } catch (error) {
      setLoadError(String(error?.message || 'Failed to load terms.'));
    } finally {
      setLoading(false);
    }
  }, [termsCollection]);

  useEffect(() => {
    void loadTerms();
  }, [loadTerms]);

  const handleFieldChange = useCallback((termId, field, value) => {
    setForm((prev) => ({
      ...prev,
      [termId]: { ...prev[termId], [field]: value }
    }));
  }, []);

  const handleQuickFill = useCallback((sessionNumber) => {
    setNewTermInputs({ academicYear: '2026', term: 'FALL', sessionNumber: String(sessionNumber) });
    setAddError('');
  }, []);

  const handleAddTerm = useCallback(() => {
    setAddError('');
    const academicYear = Number(newTermInputs.academicYear);
    const term = newTermInputs.term.trim();
    const sessionNumber = Number(newTermInputs.sessionNumber);
    if (!Number.isFinite(academicYear) || academicYear <= 0) { setAddError('Enter a valid academic year.'); return; }
    if (!term) { setAddError('Enter a term (e.g. FALL).'); return; }
    if (!Number.isInteger(sessionNumber) || sessionNumber <= 0) { setAddError('Enter a valid session number.'); return; }

    const termId = buildTermId({ academicYear, term, sessionNumber });
    if (termOrder.includes(termId)) { setAddError(`Term already exists: ${termId}`); return; }

    setTermOrder((prev) => [...prev, termId].sort((a, b) => a.localeCompare(b)));
    setForm((prev) => ({
      ...prev,
      [termId]: {
        academicYear,
        term: term.toUpperCase(),
        sessionNumber,
        startDate: '',
        endDate: '',
        standardWeeklyHours: '',
        // New terms are never historical by default -- this flag is for a
        // future backfill of old Excel-era terms, not needed today.
        isHistorical: false
      }
    }));
    setNewTermInputs({ academicYear: '', term: '', sessionNumber: '' });
  }, [newTermInputs, termOrder]);

  const handleRemoveUnsavedTerm = useCallback((termId) => {
    setTermOrder((prev) => prev.filter((t) => t !== termId));
    setForm((prev) => {
      const next = { ...prev };
      delete next[termId];
      return next;
    });
  }, []);

  const isTermDirty = useCallback((termId) => {
    const row = form[termId];
    const saved = persisted[termId];
    if (!row) return false;
    if (!saved) {
      return Boolean(row.startDate || row.endDate || String(row.standardWeeklyHours || '').trim() || row.isHistorical);
    }
    return (
      row.startDate !== saved.startDate
      || row.endDate !== saved.endDate
      || String(row.standardWeeklyHours) !== String(saved.standardWeeklyHours)
      || Boolean(row.isHistorical) !== Boolean(saved.isHistorical)
    );
  }, [form, persisted]);

  const dirtyTermIds = useMemo(
    () => termOrder.filter((termId) => isTermDirty(termId)),
    [termOrder, isTermDirty]
  );

  const handleSave = useCallback(async () => {
    if (saving || !dirtyTermIds.length) return;
    setSaving(true);
    setSaveMessage('');
    setSaveError('');

    const invalid = dirtyTermIds
      .map((termId) => ({ termId, errors: validateTermRow(form[termId]) }))
      .filter((entry) => entry.errors.length);
    if (invalid.length) {
      setSaveError(invalid.map((entry) => `${entry.termId}: ${entry.errors.join('; ')}`).join(' | '));
      setSaving(false);
      return;
    }

    try {
      for (const termId of dirtyTermIds) {
        const row = form[termId];
        const payload = {
          academicYear: Number(row.academicYear),
          term: String(row.term).trim().toUpperCase(),
          sessionNumber: Number(row.sessionNumber),
          startDate: dateInputToTimestamp(row.startDate),
          endDate: dateInputToTimestamp(row.endDate),
          standardWeeklyHours: Number(row.standardWeeklyHours),
          isHistorical: Boolean(row.isHistorical)
        };
        // Plain overwrite (no {merge: true}) -- mirrors spaceConfig's save:
        // the form supplies every field together, so there's no partial
        // update to preserve.
        await setDoc(doc(termsCollection, termId), payload);
      }
      setSaveMessage(`Saved ${dirtyTermIds.length.toLocaleString()} term${dirtyTermIds.length === 1 ? '' : 's'}.`);
      await loadTerms();
    } catch (error) {
      setSaveError(String(error?.message || 'Failed to save terms.'));
    } finally {
      setSaving(false);
    }
  }, [saving, dirtyTermIds, form, termsCollection, loadTerms]);

  // Term count visible in the summary label without expanding, same
  // convention as SpaceConfigSection above.
  const summaryLabel = termOrder.length
    ? `Terms (${termOrder.length} term${termOrder.length === 1 ? '' : 's'})`
    : 'Terms';

  return (
    <div style={{ marginTop: 10, borderTop: '1px solid #edf2f7', paddingTop: 8 }}>
      <details open={sectionOpen} onToggle={(event) => setSectionOpen(event.currentTarget.open)}>
        <summary style={{ fontWeight: 700, fontSize: 12.5, cursor: 'pointer', color: '#1d2939' }}>
          {summaryLabel}
        </summary>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, marginTop: 6 }}>
          <button
            className="btn"
            type="button"
            onClick={() => void handleSave()}
            disabled={saving || !dirtyTermIds.length}
          >
            {saving ? 'Saving...' : `Save Terms${dirtyTermIds.length ? ` (${dirtyTermIds.length})` : ''}`}
          </button>
        </div>

        <div style={{ marginTop: 4, fontSize: 10.5, color: '#667085', lineHeight: 1.35 }}>
          One row per academic year + term + session. Changed rows are highlighted and saved together with the button above.
        </div>

        {loading && !termOrder.length ? (
        <div style={{ marginTop: 8, fontSize: 11, color: '#667085' }}>Loading terms...</div>
      ) : (
        <div style={{ marginTop: 8, display: 'grid', gap: 6 }}>
          {termOrder.map((termId) => {
            const row = form[termId] || {};
            const dirty = isTermDirty(termId);
            const isUnsaved = !persisted[termId];
            const rowErrors = dirty ? validateTermRow(row) : [];
            return (
              <div
                key={termId}
                style={{
                  padding: 6,
                  background: dirty ? '#fffbeb' : '#f8fafc',
                  border: `1px solid ${dirty ? '#fde68a' : '#e5e7eb'}`,
                  borderRadius: 6
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                  <div style={{ fontSize: 11, fontWeight: 600, overflowWrap: 'anywhere' }}>
                    {termId}
                    {isUnsaved ? <span style={{ color: '#b45309', fontWeight: 500 }}> (unsaved)</span> : null}
                  </div>
                  {isUnsaved ? (
                    <button
                      type="button"
                      onClick={() => handleRemoveUnsavedTerm(termId)}
                      style={{ background: 'none', border: 'none', color: '#b42318', fontSize: 10.5, cursor: 'pointer', padding: 0 }}
                    >
                      Remove
                    </button>
                  ) : null}
                </div>

                {/* flex-wrap (was a fixed "1fr 1fr 1fr" grid) -- date
                    inputs have a real intrinsic minimum width (the native
                    picker UI), so three equal grid columns could get
                    squeezed narrower than that and force the row wider than
                    the column instead of wrapping. Each field gets a
                    minWidth and wraps to its own line if there isn't room. */}
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
                  <label style={{ flex: '1 1 100px', minWidth: 100, fontSize: 10, color: '#667085' }}>
                    Start date
                    <input
                      type="date"
                      value={row.startDate || ''}
                      onChange={(e) => handleFieldChange(termId, 'startDate', e.target.value)}
                      style={{ display: 'block', width: '100%', fontSize: 11, padding: '3px 5px', marginTop: 2 }}
                    />
                  </label>
                  <label style={{ flex: '1 1 100px', minWidth: 100, fontSize: 10, color: '#667085' }}>
                    End date
                    <input
                      type="date"
                      value={row.endDate || ''}
                      onChange={(e) => handleFieldChange(termId, 'endDate', e.target.value)}
                      style={{ display: 'block', width: '100%', fontSize: 11, padding: '3px 5px', marginTop: 2 }}
                    />
                  </label>
                  <label style={{ flex: '1 1 100px', minWidth: 100, fontSize: 10, color: '#667085' }}>
                    Weekly hours
                    <input
                      type="number"
                      min="0"
                      step="0.5"
                      value={row.standardWeeklyHours || ''}
                      onChange={(e) => handleFieldChange(termId, 'standardWeeklyHours', e.target.value)}
                      style={{ display: 'block', width: '100%', fontSize: 11, padding: '3px 5px', marginTop: 2 }}
                    />
                  </label>
                </div>

                <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, fontSize: 10.5 }}>
                  <input
                    type="checkbox"
                    checked={Boolean(row.isHistorical)}
                    onChange={(e) => handleFieldChange(termId, 'isHistorical', e.target.checked)}
                  />
                  Historical (backfilled from old Excel-era terms, not current/upcoming)
                </label>

                {rowErrors.length ? (
                  <div style={{ marginTop: 4, fontSize: 10, color: '#b42318' }}>{rowErrors.join('; ')}</div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}

      <div style={{ marginTop: 8, padding: 6, background: '#f8fafc', border: '1px solid #e5e7eb', borderRadius: 6 }}>
        <div style={{ fontSize: 10.5, fontWeight: 600, color: '#344054', marginBottom: 4 }}>Add Term</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 6 }}>
          <button type="button" className="btn" onClick={() => handleQuickFill(1)}>Fall 2026 Block 1</button>
          <button type="button" className="btn" onClick={() => handleQuickFill(2)}>Fall 2026 Block 2</button>
        </div>
        {/* flex-wrap (was a fixed "80px 1fr 90px auto" grid) -- this is the
            row that was actually reported overflowing: four fields plus a
            button had no way to reflow at the column's width. Each field
            gets a minWidth and wraps instead of forcing the row wider. */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          <input
            type="number"
            placeholder="Year"
            value={newTermInputs.academicYear}
            onChange={(e) => setNewTermInputs((prev) => ({ ...prev, academicYear: e.target.value }))}
            style={{ flex: '0 1 70px', minWidth: 60, fontSize: 11, padding: '4px 6px' }}
          />
          <input
            type="text"
            placeholder="Term (e.g. FALL)"
            value={newTermInputs.term}
            onChange={(e) => setNewTermInputs((prev) => ({ ...prev, term: e.target.value }))}
            style={{ flex: '1 1 110px', minWidth: 100, fontSize: 11, padding: '4px 6px' }}
          />
          <input
            type="number"
            placeholder="Session #"
            value={newTermInputs.sessionNumber}
            onChange={(e) => setNewTermInputs((prev) => ({ ...prev, sessionNumber: e.target.value }))}
            style={{ flex: '0 1 90px', minWidth: 80, fontSize: 11, padding: '4px 6px' }}
          />
          <button className="btn" type="button" onClick={handleAddTerm} style={{ flex: '0 0 auto' }}>
            Add
          </button>
        </div>
        {addError ? <div style={{ marginTop: 4, fontSize: 10, color: '#b42318' }}>{addError}</div> : null}
      </div>

      {loadError ? <div style={{ marginTop: 6, fontSize: 10.5, color: '#b42318' }}>{loadError}</div> : null}
      {saveMessage ? <div style={{ marginTop: 6, fontSize: 10.5, color: '#15803d' }}>{saveMessage}</div> : null}
      {saveError ? <div style={{ marginTop: 6, fontSize: 10.5, color: '#b42318' }}>{saveError}</div> : null}
      </details>
    </div>
  );
}

// Room Utilization Tagging -- one row per physical room that actually has
// scheduled classes (universities/hastings/roomUtilizationMeta/{roomKey}),
// per Clark's decisions: (1) only rooms with real courseMeetings entries are
// offered for tagging, not every Airtable room -- this section never reads
// Airtable at all, the room list comes entirely from the already-imported
// schedule; (2) spaceCategory is picked from spaceConfig's existing category
// ids, never free text, so a mistyped category can't silently fail to match
// anything downstream; (3) untagged rooms are excluded from the future calc
// engine but flagged visibly here (the summary banner below) rather than
// blocking the whole module until every room is tagged -- see
// classroomUtilizationSchema.js's RoomUtilizationMetaDoc comment for the
// original decision writeup.
//
// Mirrors SpaceConfigSection/TermsSection's conventions: dirty-tracking
// against a persisted snapshot, single "Save" button for whichever rows
// changed, validate-before-write, plain setDoc overwrite (no {merge: true}).
function RoomUtilizationMetaSection() {
  // Collapsed by default -- one-time setup task, not something checked
  // repeatedly, and the panel has grown crowded (Import Schedule, Space
  // Config, Terms, Room Tagging, Utilization Results all stacked). Same
  // native <details>/<summary> disclosure pattern CapitalPrioritiesPanel.jsx
  // already uses (collapse-by-default, added 2026-08-13) -- this only gates
  // visibility below; loadRooms()/the live spaceConfig listener both still
  // run unconditionally via their own useEffects regardless of open/collapsed
  // state, so expanding never has to trigger a load, it just reveals data
  // (and the tagged/untagged count) that's already there.
  const [sectionOpen, setSectionOpen] = useState(false);
  const [roomList, setRoomList] = useState([]); // [{roomKey, building, room}], derived from courseMeetings
  const [categoryOptions, setCategoryOptions] = useState([]); // spaceConfig doc ids, kept live -- see onSnapshot below
  const [categoryOptionsLoaded, setCategoryOptionsLoaded] = useState(false);
  const [form, setForm] = useState({}); // roomKey -> {spaceCategory, notes}
  const [persisted, setPersisted] = useState({}); // roomKey -> {spaceCategory, notes}, only for rooms with an existing doc
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState('');
  const [saveError, setSaveError] = useState('');

  // Airtable Room Type Description -> suggested spaceCategory, per Clark's
  // 2026-08-19 request. Read-only against the existing /ai/api/rooms
  // endpoint (same one UtilizationResultsSection already uses below) --
  // fetched once on mount, not live, since a suggestion is only ever applied
  // once per untagged room (see suggestionsAppliedRef below), not kept in
  // continuous sync with Airtable.
  const [airtableRoomTypeByKey, setAirtableRoomTypeByKey] = useState(() => new Map());
  const [airtableSuggestionsLoaded, setAirtableSuggestionsLoaded] = useState(false);
  const [airtableSuggestionsError, setAirtableSuggestionsError] = useState('');
  // roomKeys whose current form.spaceCategory value was pre-filled by the
  // suggestion effect below and has NOT since been manually changed by the
  // admin -- drives the distinct "suggested, unconfirmed" row styling versus
  // the existing amber "manually edited, unsaved" styling. Manually picking
  // a category (even re-picking the same one) clears a roomKey from this set
  // in handleFieldChange, downgrading it to a normal dirty row.
  const [suggestedRoomKeys, setSuggestedRoomKeys] = useState(() => new Set());
  // Suggestions are applied at most once per mount, per Clark's "on mount"
  // spec -- this guards the effect below from re-running (and re-clobbering
  // a since-edited field) every time roomList/categoryOptions changes, e.g.
  // after a Save reloads roomList.
  const suggestionsAppliedRef = useRef(false);

  const roomUtilizationMetaCollection = useMemo(
    () => collection(db, 'universities', HASTINGS_UNIVERSITY_ID, ROOM_UTILIZATION_META_COLLECTION),
    []
  );
  const spaceConfigCollection = useMemo(
    () => collection(db, 'universities', HASTINGS_UNIVERSITY_ID, SPACE_CONFIG_COLLECTION),
    []
  );
  const courseMeetingsCollection = useMemo(
    () => collection(db, 'universities', HASTINGS_UNIVERSITY_ID, COURSE_MEETINGS_COLLECTION),
    []
  );

  // Live, not a one-time load -- per Clark's requirement that the category
  // dropdown reflect whatever spaceConfig categories exist right now
  // (currently just "Classroom"), not a list hardcoded into this component.
  // Read-only listener; this section never writes to spaceConfig.
  useEffect(() => {
    const unsubscribe = onSnapshot(
      spaceConfigCollection,
      (snap) => {
        setCategoryOptions(snap.docs.map((docSnap) => docSnap.id).sort((a, b) => a.localeCompare(b)));
        setCategoryOptionsLoaded(true);
      },
      (error) => setLoadError(String(error?.message || 'Failed to load space categories.'))
    );
    return () => unsubscribe();
  }, [spaceConfigCollection]);

  // Fetch Airtable rooms once on mount (read-only, existing endpoint -- see
  // fetchAirtableRoomsForUtilization's own header comment for why this is
  // already considered safe/established: UtilizationResultsSection below
  // calls the exact same function). A failed fetch degrades to "no
  // suggestions offered" rather than blocking the section -- same fail-soft
  // convention UtilizationResultsSection already uses for this endpoint.
  useEffect(() => {
    let cancelled = false;
    fetchAirtableRoomsForUtilization()
      .then((rooms) => {
        if (cancelled) return;
        setAirtableRoomTypeByKey(buildAirtableRoomTypeMap(rooms));
      })
      .catch((error) => {
        if (cancelled) return;
        console.warn('Airtable rooms fetch failed for room-type suggestions:', error);
        setAirtableSuggestionsError(String(error?.message || 'Failed to load Airtable room-type suggestions.'));
      })
      .finally(() => {
        if (!cancelled) setAirtableSuggestionsLoaded(true);
      });
    return () => { cancelled = true; };
  }, []);

  // One-time suggestion application, per Clark's "on mount" spec: once the
  // room list, spaceConfig categories, and Airtable data have all loaded,
  // pre-fill spaceCategory for any room that (a) has no existing
  // roomUtilizationMeta doc yet, (b) is still blank/untouched, and (c) has
  // an Airtable Room Type Description that maps to a category that ALREADY
  // EXISTS in spaceConfig -- never creates a new spaceConfig category, per
  // explicit instruction; if the suggested category doesn't exist yet, this
  // skips the pre-fill entirely and the render below shows an "add it first"
  // hint instead (computed live from categoryOptions, not frozen here).
  useEffect(() => {
    if (suggestionsAppliedRef.current) return;
    if (!roomList.length || !airtableSuggestionsLoaded || !categoryOptionsLoaded) return;
    suggestionsAppliedRef.current = true;

    const nextSuggestedKeys = new Set();
    setForm((prev) => {
      let changed = false;
      const next = { ...prev };
      roomList.forEach(({ roomKey }) => {
        if (persisted[roomKey]) return; // only rooms with no existing doc yet
        const current = next[roomKey] || { spaceCategory: '', notes: '' };
        if (String(current.spaceCategory || '').trim()) return; // only blank/untouched
        const roomType = airtableRoomTypeByKey.get(roomKey);
        const suggestedCategory = suggestSpaceCategoryFromRoomType(roomType);
        if (!suggestedCategory || !categoryOptions.includes(suggestedCategory)) return;
        next[roomKey] = { ...current, spaceCategory: suggestedCategory };
        nextSuggestedKeys.add(roomKey);
        changed = true;
      });
      return changed ? next : prev;
    });
    setSuggestedRoomKeys(nextSuggestedKeys);
  }, [roomList, persisted, airtableRoomTypeByKey, airtableSuggestionsLoaded, categoryOptions, categoryOptionsLoaded]);

  const loadRooms = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      const [meetingsSnap, metaSnap] = await Promise.all([
        getDocs(courseMeetingsCollection),
        getDocs(roomUtilizationMetaCollection)
      ]);
      const rooms = deriveDistinctRoomsFromCourseMeetings(
        meetingsSnap.docs.map((docSnap) => docSnap.data())
      );
      const nextPersisted = {};
      metaSnap.docs.forEach((docSnap) => {
        const data = docSnap.data() || {};
        nextPersisted[docSnap.id] = {
          spaceCategory: String(data.spaceCategory || ''),
          notes: String(data.notes || '')
        };
      });
      const nextForm = {};
      rooms.forEach(({ roomKey }) => {
        nextForm[roomKey] = nextPersisted[roomKey]
          ? { ...nextPersisted[roomKey] }
          : { spaceCategory: '', notes: '' };
      });
      setRoomList(rooms);
      setPersisted(nextPersisted);
      setForm(nextForm);
    } catch (error) {
      setLoadError(String(error?.message || 'Failed to load rooms.'));
    } finally {
      setLoading(false);
    }
  }, [courseMeetingsCollection, roomUtilizationMetaCollection]);

  useEffect(() => {
    void loadRooms();
  }, [loadRooms]);

  const handleFieldChange = useCallback((roomKey, field, value) => {
    setForm((prev) => ({
      ...prev,
      [roomKey]: { ...(prev[roomKey] || { spaceCategory: '', notes: '' }), [field]: value }
    }));
    // Any manual change to spaceCategory -- even re-picking the same
    // suggested value -- converts this from an unconfirmed suggestion into a
    // normal manual edit, per Clark's "different highlight than dirty/
    // unsaved amber" requirement: once touched, it's no longer "suggested,
    // not yet reviewed", it's a deliberate admin choice like any other.
    if (field === 'spaceCategory') {
      setSuggestedRoomKeys((prev) => {
        if (!prev.has(roomKey)) return prev;
        const next = new Set(prev);
        next.delete(roomKey);
        return next;
      });
    }
  }, []);

  const isRoomDirty = useCallback((roomKey) => {
    const row = form[roomKey];
    if (!row) return false;
    const saved = persisted[roomKey] || { spaceCategory: '', notes: '' };
    return row.spaceCategory !== saved.spaceCategory || row.notes !== saved.notes;
  }, [form, persisted]);

  const dirtyRoomKeys = useMemo(
    () => roomList.map((r) => r.roomKey).filter((roomKey) => isRoomDirty(roomKey)),
    [roomList, isRoomDirty]
  );

  // Read from the live form (not just `persisted`) so the summary updates
  // the instant an admin picks a category -- not only after Save -- per
  // Clark's "impossible to miss, updates as rooms get tagged/saved" ask.
  // Reloading after a successful save repopulates form from the fresh
  // persisted snapshot, so this stays correct post-save too.
  const taggedCount = useMemo(
    () => roomList.filter((r) => String(form[r.roomKey]?.spaceCategory || '').trim()).length,
    [roomList, form]
  );
  const untaggedCount = roomList.length - taggedCount;

  const validateRoomRow = useCallback((row) => {
    const category = String(row?.spaceCategory || '').trim();
    if (!category) return []; // explicitly untagged/blank is always valid
    if (!categoryOptions.includes(category)) {
      return [`"${category}" is not a space category defined in Space Configuration`];
    }
    return [];
  }, [categoryOptions]);

  const handleSave = useCallback(async () => {
    if (saving || !dirtyRoomKeys.length) return;
    setSaving(true);
    setSaveMessage('');
    setSaveError('');

    // Validate every changed row before writing anything -- same
    // fail-fast-the-whole-batch convention as SpaceConfigSection/TermsSection.
    const invalid = dirtyRoomKeys
      .map((roomKey) => ({ roomKey, errors: validateRoomRow(form[roomKey]) }))
      .filter((entry) => entry.errors.length);
    if (invalid.length) {
      setSaveError(invalid.map((entry) => `${entry.roomKey}: ${entry.errors.join('; ')}`).join(' | '));
      setSaving(false);
      return;
    }

    try {
      const roomsByKey = new Map(roomList.map((r) => [r.roomKey, r]));
      for (const roomKey of dirtyRoomKeys) {
        const row = form[roomKey];
        const roomInfo = roomsByKey.get(roomKey);
        const payload = {
          building: roomInfo?.building || '',
          room: roomInfo?.room || '',
          spaceCategory: String(row.spaceCategory || '').trim(),
          notes: String(row.notes || '').trim()
        };
        // Plain overwrite (no {merge: true}) -- same reasoning as
        // SpaceConfigSection/TermsSection: the form supplies every field
        // together, so there's no partial-update case to preserve.
        await setDoc(doc(roomUtilizationMetaCollection, roomKey), payload);
      }
      setSaveMessage(
        `Saved ${dirtyRoomKeys.length.toLocaleString()} room${dirtyRoomKeys.length === 1 ? '' : 's'}.`
      );
      await loadRooms();
    } catch (error) {
      setSaveError(String(error?.message || 'Failed to save room tagging.'));
    } finally {
      setSaving(false);
    }
  }, [saving, dirtyRoomKeys, form, roomList, roomUtilizationMetaCollection, loadRooms, validateRoomRow]);

  // Edge case: spaceConfig has zero categories defined. Shouldn't happen
  // today ("Classroom" already exists), but show a clear message and
  // disable tagging instead of rendering empty/broken dropdowns.
  const noCategoriesYet = !loading && categoryOptions.length === 0;

  // Tagged count baked into the summary text itself -- per the "visible
  // without expanding" requirement -- so the collapsed state still answers
  // "is this done yet" at a glance. Mirrors the same numbers the full banner
  // below shows, just as plain text instead of the colored box (native
  // <summary> content is best kept simple/inline).
  const summaryLabel = roomList.length
    ? `Room Utilization Tagging (${taggedCount} of ${roomList.length} tagged)`
    : 'Room Utilization Tagging';

  return (
    <div style={{ marginTop: 10, borderTop: '1px solid #edf2f7', paddingTop: 8 }}>
      {/* Collapsed by default -- same disclosure pattern as
          CapitalPrioritiesPanel.jsx: title/count as the summary, everything
          else (including the full colored tagged/untagged banner) as
          children. The Save button is deliberately kept OUTSIDE <summary>,
          not alongside the title inside it -- a nested interactive element
          inside <summary> would fight the native click-to-toggle behavior,
          same reasoning CapitalPrioritiesPanel.jsx's own Refresh button
          followed. */}
      <details open={sectionOpen} onToggle={(event) => setSectionOpen(event.currentTarget.open)}>
        <summary style={{ fontWeight: 700, fontSize: 12.5, cursor: 'pointer', color: '#1d2939' }}>
          {summaryLabel}
        </summary>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, marginTop: 6 }}>
          <button
            className="btn"
            type="button"
            onClick={() => void handleSave()}
            disabled={saving || !dirtyRoomKeys.length || noCategoriesYet}
          >
            {saving ? 'Saving...' : `Save Room Tagging${dirtyRoomKeys.length ? ` (${dirtyRoomKeys.length})` : ''}`}
          </button>
        </div>

        <div style={{ marginTop: 4, fontSize: 10.5, color: '#667085', lineHeight: 1.35 }}>
          One row per room with scheduled classes (from the imported class schedule, not the full room inventory).
          Tag each room with a space category so the future utilization calc engine knows how to score it.
        </div>

        <div style={{ marginTop: 4, fontSize: 10.5, color: '#1d4ed8', lineHeight: 1.35 }}>
          Untagged rooms with a matching Airtable Room Type Description show a <strong>suggested</strong> category
          (blue) pre-filled but not yet saved -- change it or click Save to accept it. This never auto-saves and
          never creates a new space category on its own.
        </div>

        {airtableSuggestionsError ? (
          <div style={{ marginTop: 4, fontSize: 10, color: '#98a2b3' }}>
            Airtable suggestions unavailable ({airtableSuggestionsError}) -- manual tagging below still works normally.
          </div>
        ) : null}

        {/* Prominent, can't-miss tagged/untagged summary -- per Clark's
            "flag visibly" requirement, not a footnote. Still shown in full
            here (unchanged) once expanded; the same count also lives in the
            summary label above so it's visible without expanding at all. */}
        <div
          style={{
            marginTop: 8,
            padding: '8px 10px',
            borderRadius: 6,
            fontSize: 12.5,
            fontWeight: 700,
            textAlign: 'center',
            background: untaggedCount > 0 ? '#fffbeb' : '#f0fdf4',
            border: `1px solid ${untaggedCount > 0 ? '#fde68a' : '#bbf7d0'}`,
            color: untaggedCount > 0 ? '#92400e' : '#15803d'
          }}
        >
          {roomList.length
            ? `${taggedCount} of ${roomList.length} room${roomList.length === 1 ? '' : 's'} tagged, ${untaggedCount} untagged`
            : (loading ? 'Loading rooms...' : 'No rooms found in the imported class schedule yet.')}
        </div>

        {noCategoriesYet ? (
          <div style={{ marginTop: 8, fontSize: 11, color: '#b42318' }}>
            No space categories are defined yet. Add at least one category in Space Configuration above before tagging rooms.
          </div>
        ) : null}

        {loading && !roomList.length ? (
          <div style={{ marginTop: 8, fontSize: 11, color: '#667085' }}>Loading rooms...</div>
        ) : (
          <div style={{ marginTop: 8, display: 'grid', gap: 6 }}>
            {roomList.map(({ roomKey, building, room }) => {
              const row = form[roomKey] || { spaceCategory: '', notes: '' };
              const dirty = isRoomDirty(roomKey);
              const rowErrors = dirty ? validateRoomRow(row) : [];

              // Suggestion state -- computed live from categoryOptions (not
              // frozen at the one-time apply above) so an "add it first"
              // hint automatically stops being relevant if the admin adds
              // the missing category later, without needing its own effect.
              const isSuggested = suggestedRoomKeys.has(roomKey);
              const airtableRoomType = airtableRoomTypeByKey.get(roomKey) || '';
              const rawSuggestedCategory = suggestSpaceCategoryFromRoomType(airtableRoomType);
              const suggestionNeedsCategory = Boolean(
                !persisted[roomKey]
                && !isSuggested
                && rawSuggestedCategory
                && !categoryOptions.includes(rawSuggestedCategory)
                && !String(row.spaceCategory || '').trim()
              );

              const rowBackground = isSuggested ? '#eff6ff' : (dirty ? '#fffbeb' : '#f8fafc');
              const rowBorder = isSuggested ? '#bfdbfe' : (dirty ? '#fde68a' : '#e5e7eb');

              return (
                <div
                  key={roomKey}
                  style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: 6,
                    alignItems: 'center',
                    padding: 6,
                    background: rowBackground,
                    border: `1px solid ${rowBorder}`,
                    borderRadius: 6
                  }}
                >
                  <div style={{ flex: '1 1 140px', minWidth: 140, fontSize: 11, fontWeight: 600, overflowWrap: 'anywhere' }}>
                    {building} — {room}
                  </div>
                  <select
                    value={row.spaceCategory}
                    onChange={(e) => handleFieldChange(roomKey, 'spaceCategory', e.target.value)}
                    disabled={noCategoriesYet}
                    style={{ flex: '0 1 150px', minWidth: 130, fontSize: 11, padding: '3px 5px' }}
                  >
                    <option value="">-- untagged --</option>
                    {categoryOptions.map((category) => (
                      <option key={category} value={category}>{category}</option>
                    ))}
                  </select>
                  <input
                    type="text"
                    placeholder="Notes (optional)"
                    value={row.notes}
                    onChange={(e) => handleFieldChange(roomKey, 'notes', e.target.value)}
                    style={{ flex: '1 1 140px', minWidth: 140, fontSize: 11, padding: '3px 5px' }}
                  />
                  {isSuggested ? (
                    <span
                      style={{
                        flex: '0 0 auto',
                        fontSize: 9.5,
                        fontWeight: 700,
                        color: '#1d4ed8',
                        background: '#dbeafe',
                        border: '1px solid #bfdbfe',
                        borderRadius: 4,
                        padding: '1px 5px',
                        whiteSpace: 'nowrap'
                      }}
                      title={`Airtable Room Type Description: "${airtableRoomType}"`}
                    >
                      Suggested from Airtable — not yet saved
                    </span>
                  ) : null}
                  {suggestionNeedsCategory ? (
                    <div style={{ flex: '1 1 100%', fontSize: 10, color: '#475467' }}>
                      Airtable suggests "{rawSuggestedCategory}" (from "{airtableRoomType}") — add "{rawSuggestedCategory}"
                      as a category in Space Configuration above to enable this suggestion.
                    </div>
                  ) : null}
                  {rowErrors.length ? (
                    <div style={{ flex: '1 1 100%', fontSize: 10, color: '#b42318' }}>{rowErrors.join('; ')}</div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}

        {loadError ? <div style={{ marginTop: 6, fontSize: 10.5, color: '#b42318' }}>{loadError}</div> : null}
        {saveMessage ? <div style={{ marginTop: 6, fontSize: 10.5, color: '#15803d' }}>{saveMessage}</div> : null}
        {saveError ? <div style={{ marginTop: 6, fontSize: 10.5, color: '#b42318' }}>{saveError}</div> : null}
      </details>
    </div>
  );
}

// Enrollment & FTE Projections upload -- the data layer the future growth/
// right-sizing module needs (universities/hastings/enrollmentProjections/
// {deptId}, one doc per department plus one institution-wide overall doc).
// Same "confirm before write" discipline as Import Schedule above: selecting
// a file only parses it client-side and shows a preview -- nothing is
// written to Firestore until Clark reviews the preview and clicks Confirm &
// Save. Same delete-then-write idempotency as Import Schedule too, so
// re-uploading a newer version of the workbook cleanly replaces the old
// data rather than accumulating stale docs under old deptIds.
//
// Parsing itself lives entirely in enrollmentProjectionsImport.js (label-
// driven, not fixed row/column offsets -- see that file's header comment
// for the full verified structure). This section only owns the file input,
// the preview UI, and the Firestore write.
function formatEnrollmentValue(value) {
  return Number.isFinite(value) ? (Math.round(value * 100) / 100).toLocaleString() : '—';
}

function EnrollmentProjectionsSection() {
  const [sectionOpen, setSectionOpen] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [parseError, setParseError] = useState('');
  const [parsedResult, setParsedResult] = useState(null); // { years, instituteRecord, departmentRecords, sheetName, sourceFileName }
  const [savePhase, setSavePhase] = useState(null); // null | 'clearing' | 'writing'
  const [saveMessage, setSaveMessage] = useState('');
  const [saveError, setSaveError] = useState('');
  // Actual persisted enrollmentProjections docs -- loaded on mount (and
  // reloaded after a successful save), same getDocs-on-mount pattern
  // SpaceConfigSection/TermsSection already use. This replaces the earlier
  // lastSavedCount local-state approach, which only reflected a save that
  // happened earlier in the SAME session and went back to "unsaved" text on
  // reload even though the data was still sitting in Firestore.
  const [savedDocs, setSavedDocs] = useState([]);
  const [savedLoading, setSavedLoading] = useState(false);
  const [savedLoadError, setSavedLoadError] = useState('');

  const enrollmentProjectionsCollection = useMemo(
    () => collection(db, 'universities', HASTINGS_UNIVERSITY_ID, ENROLLMENT_PROJECTIONS_COLLECTION),
    []
  );

  const loadSavedProjections = useCallback(async () => {
    setSavedLoading(true);
    setSavedLoadError('');
    try {
      const snap = await getDocs(enrollmentProjectionsCollection);
      const docs = snap.docs.map((docSnap) => {
        const data = docSnap.data() || {};
        return {
          id: docSnap.id,
          division: String(data.division || ''),
          department: String(data.department || ''),
          years: data.years || {}
        };
      });
      // Overall (institution-wide) row first, then alphabetical -- mirrors
      // toEnrollmentProjectionDocs' institute-record-first ordering below
      // without depending on Firestore's arbitrary doc order.
      docs.sort((a, b) => {
        if (a.division !== b.division) {
          if (a.division === 'Overall') return -1;
          if (b.division === 'Overall') return 1;
          return a.division.localeCompare(b.division);
        }
        return a.department.localeCompare(b.department);
      });
      setSavedDocs(docs);
    } catch (error) {
      setSavedLoadError(String(error?.message || 'Failed to load saved enrollment projections.'));
    } finally {
      setSavedLoading(false);
    }
  }, [enrollmentProjectionsCollection]);

  useEffect(() => {
    void loadSavedProjections();
  }, [loadSavedProjections]);

  // Latest year present across the saved docs -- the summary table shows
  // just this one year as a quick "is my data here" check, not all 11.
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

  const previewDocs = useMemo(
    () => (parsedResult ? toEnrollmentProjectionDocs(parsedResult) : []),
    [parsedResult]
  );

  const handleFileSelected = useCallback(async (event) => {
    const file = event.target.files?.[0] || null;
    // Reset the input value immediately so re-selecting the SAME file name
    // (e.g. after fixing the workbook and re-exporting under the same name)
    // still fires a change event and re-parses, instead of being a no-op.
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
          'Parsed the workbook but found no recognizable institution-wide or department data. '
          + 'Check that the row/column labels still match the expected shape (division names in '
          + 'column A, department names in column B, metric labels in column B/C).'
        );
      }
      setParsedResult(result);
    } catch (error) {
      setParseError(String(error?.message || 'Failed to parse workbook.'));
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
      // Clear existing docs first, same reasoning as Import Schedule above:
      // makes re-running idempotent (always lands on exactly len(previewDocs)
      // docs) instead of merge-only accumulating orphaned deptIds from a
      // prior workbook version's department list. If this fails partway, we
      // stop here and never reach the write step below.
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
        `Cleared ${existingRefs.length.toLocaleString()} old record${existingRefs.length === 1 ? '' : 's'}, `
        + `imported ${previewDocs.length.toLocaleString()} department record${previewDocs.length === 1 ? '' : 's'} `
        + `from "${parsedResult?.sourceFileName || 'the uploaded file'}".`
      );
      // Clear the preview after a successful save -- requires a fresh file
      // selection (and a fresh look at the preview) before Save can be
      // clicked again, so the same parse can't be accidentally re-submitted.
      setParsedResult(null);
      // Reload the persisted docs so the summary label and saved-data table
      // below reflect the actual new Firestore state, not a locally-guessed
      // count -- same source of truth the initial mount load uses, so a
      // reload of the page afterward shows exactly the same thing.
      await loadSavedProjections();
    } catch (error) {
      const phaseLabel = phase === 'clearing'
        ? 'Failed while clearing old data (nothing new was written): '
        : 'Failed while writing new data (old data was already cleared): ';
      setSaveError(phaseLabel + String(error?.message || 'unknown error.'));
    } finally {
      setSavePhase(null);
    }
  }, [savePhase, previewDocs, enrollmentProjectionsCollection, parsedResult, loadSavedProjections]);

  const yearRangeLabel = parsedResult?.years?.length
    ? (parsedResult.years.length === 1
      ? String(parsedResult.years[0])
      : `${parsedResult.years[0]}–${parsedResult.years[parsedResult.years.length - 1]} (${parsedResult.years.length} years)`)
    : '';
  const firstYear = parsedResult?.years?.[0];

  // An unsaved preview takes priority (still previewing, not saved yet),
  // otherwise reflects savedDocs -- the actual persisted Firestore state,
  // loaded on mount and refreshed after every save -- so this is true
  // immediately on page load/reopen, not just transiently right after a
  // save action in the same session.
  const summaryLabel = previewDocs.length
    ? `Enrollment & FTE Projections (previewing ${previewDocs.length} unsaved record${previewDocs.length === 1 ? '' : 's'})`
    : savedDocs.length
      ? `Enrollment & FTE Projections (${savedDocs.length.toLocaleString()} record${savedDocs.length === 1 ? '' : 's'} saved)`
      : 'Enrollment & FTE Projections';

  return (
    <div style={{ marginTop: 10, borderTop: '1px solid #edf2f7', paddingTop: 8 }}>
      <details open={sectionOpen} onToggle={(event) => setSectionOpen(event.currentTarget.open)}>
        <summary style={{ fontWeight: 700, fontSize: 12.5, cursor: 'pointer', color: '#1d2939' }}>
          {summaryLabel}
        </summary>

        <div style={{ marginTop: 4, fontSize: 10.5, color: '#667085', lineHeight: 1.35 }}>
          Upload the Enrollment & FTE Projections workbook (one doc per department plus one
          institution-wide overall doc). Selecting a file only parses it and shows a preview below --
          nothing is written until you review it and click Confirm & Save.
        </div>

        <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
          <input
            type="file"
            accept=".xlsx,.xls"
            onChange={(e) => void handleFileSelected(e)}
            disabled={parsing || Boolean(savePhase)}
            style={{ fontSize: 11 }}
          />
          {parsing ? <span style={{ fontSize: 11, color: '#667085' }}>Parsing...</span> : null}
        </div>

        {/* Read-only view of the ALREADY-SAVED data (savedDocs, loaded via
            loadSavedProjections on mount and after every save) -- distinct
            from the upload preview below, which only exists transiently
            between choosing a file and clicking Confirm & Save. This is what
            makes "13 records saved" verifiable on a fresh page load instead
            of taken on faith. */}
        {savedLoading && !savedDocs.length ? (
          <div style={{ marginTop: 8, fontSize: 11, color: '#667085' }}>Loading saved projections...</div>
        ) : savedDocs.length ? (
          <div style={{ marginTop: 10 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: '#344054' }}>
              Currently saved ({savedDocs.length.toLocaleString()} record{savedDocs.length === 1 ? '' : 's'})
            </div>
            <div style={{ marginTop: 4, overflowX: 'auto' }}>
              <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 11 }}>
                <thead>
                  <tr style={{ textAlign: 'left', borderBottom: '1px solid #d0d7e2' }}>
                    <th style={{ padding: '4px 6px' }}>Division</th>
                    <th style={{ padding: '4px 6px' }}>Department</th>
                    <th style={{ padding: '4px 6px' }}>{savedLatestYear ?? '—'} Headcount</th>
                    <th style={{ padding: '4px 6px' }}>{savedLatestYear ?? '—'} Total FTE</th>
                  </tr>
                </thead>
                <tbody>
                  {savedDocs.map((entry) => (
                    <tr key={entry.id} style={{ borderBottom: '1px solid #f1f5f9' }}>
                      <td style={{ padding: '4px 6px' }}>{entry.division}</td>
                      <td style={{ padding: '4px 6px', fontWeight: entry.department.endsWith('Overall') ? 700 : 400 }}>
                        {entry.department}
                      </td>
                      <td style={{ padding: '4px 6px' }}>{formatEnrollmentValue(entry.years?.[savedLatestYear]?.studentHeadcount)}</td>
                      <td style={{ padding: '4px 6px' }}>{formatEnrollmentValue(entry.years?.[savedLatestYear]?.totalFte)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : !savedLoading ? (
          <div style={{ marginTop: 8, fontSize: 11, color: '#667085' }}>No enrollment projections saved yet.</div>
        ) : null}

        {savedLoadError ? (
          <div style={{ marginTop: 6, fontSize: 10.5, color: '#b42318' }}>{savedLoadError}</div>
        ) : null}

        {parseError ? (
          <div style={{ marginTop: 8, fontSize: 10.5, color: '#b42318' }}>{parseError}</div>
        ) : null}

        {parsedResult ? (
          <div style={{ marginTop: 10 }}>
            <div
              style={{
                padding: '8px 10px',
                borderRadius: 6,
                fontSize: 11.5,
                background: '#eff6ff',
                border: '1px solid #bfdbfe',
                color: '#1e3a8a',
                lineHeight: 1.5
              }}
            >
              <strong>Preview</strong> — "{parsedResult.sourceFileName}" (sheet "{parsedResult.sheetName}"): {' '}
              {parsedResult.departmentRecords.length} department record{parsedResult.departmentRecords.length === 1 ? '' : 's'}
              {parsedResult.instituteRecord ? ', plus 1 institution-wide overall record' : ''}, years {yearRangeLabel}.
              {!parsedResult.instituteRecord ? (
                <div style={{ marginTop: 4, color: '#b42318', fontWeight: 600 }}>
                  No institution-wide overall record was found -- expected one (e.g. a "Hastings College" row with
                  Net Student Headcount/FTE rows directly beneath it, no department in between). Double-check the
                  workbook before saving.
                </div>
              ) : null}
            </div>

            <div style={{ marginTop: 8, overflowX: 'auto' }}>
              <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 11 }}>
                <thead>
                  <tr style={{ textAlign: 'left', borderBottom: '1px solid #d0d7e2' }}>
                    <th style={{ padding: '4px 6px' }}>Division</th>
                    <th style={{ padding: '4px 6px' }}>Department</th>
                    <th style={{ padding: '4px 6px' }}>{firstYear} Headcount</th>
                    <th style={{ padding: '4px 6px' }}>{firstYear} Total FTE</th>
                  </tr>
                </thead>
                <tbody>
                  {previewDocs.map((entry) => (
                    <tr key={entry.deptId} style={{ borderBottom: '1px solid #f1f5f9' }}>
                      <td style={{ padding: '4px 6px' }}>{entry.division}</td>
                      <td style={{ padding: '4px 6px', fontWeight: entry.department.endsWith('Overall') ? 700 : 400 }}>
                        {entry.department}
                      </td>
                      <td style={{ padding: '4px 6px' }}>{formatEnrollmentValue(entry.years?.[firstYear]?.studentHeadcount)}</td>
                      <td style={{ padding: '4px 6px' }}>{formatEnrollmentValue(entry.years?.[firstYear]?.totalFte)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
              <button
                className="btn"
                type="button"
                onClick={() => void handleSave()}
                disabled={Boolean(savePhase) || !previewDocs.length}
              >
                {savePhase === 'clearing' ? 'Clearing old data...'
                  : savePhase === 'writing' ? 'Saving...'
                  : `Confirm & Save (${previewDocs.length})`}
              </button>
            </div>
          </div>
        ) : null}

        {saveMessage ? <div style={{ marginTop: 6, fontSize: 10.5, color: '#15803d' }}>{saveMessage}</div> : null}
        {saveError ? <div style={{ marginTop: 6, fontSize: 10.5, color: '#b42318' }}>{saveError}</div> : null}
      </details>
    </div>
  );
}

// Space Growth / Right-Sizing -- roadmap item beyond the original 6, the
// first consumer of enrollmentProjections. Strictly read-only against
// spaceConfig, roomUtilizationMeta, enrollmentProjections, and Airtable
// (/ai/api/rooms, same endpoint UtilizationResultsSection already uses) --
// nothing here writes anything. Per Clark's explicit decision, this first
// version uses INSTITUTION-WIDE enrollment only, not department-specific --
// see spaceGrowthCalc.js's header comment. "Ideal NSF/Student" reuses
// spaceConfig's existing sfPerStationTarget field (no new spaceConfig field
// added, Space Configuration itself untouched).
const BASELINE_ENROLLMENT_YEAR = 2026;
const TARGET_YEAR_OPTIONS = Array.from({ length: 10 }, (_, i) => 2027 + i); // 2027-2036

function formatGrowthSF(value) {
  return Number.isFinite(value) ? `${Math.round(value).toLocaleString()} SF` : '—';
}

function formatGrowthGap(value) {
  if (!Number.isFinite(value)) return '—';
  const rounded = Math.round(value);
  return `${rounded >= 0 ? '+' : ''}${rounded.toLocaleString()} SF`;
}

function SpaceGrowthSection() {
  const [sectionOpen, setSectionOpen] = useState(false);
  const [targetYear, setTargetYear] = useState(TARGET_YEAR_OPTIONS[TARGET_YEAR_OPTIONS.length - 1]);
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');

  const spaceConfigCollection = useMemo(
    () => collection(db, 'universities', HASTINGS_UNIVERSITY_ID, SPACE_CONFIG_COLLECTION),
    []
  );
  const roomUtilizationMetaCollection = useMemo(
    () => collection(db, 'universities', HASTINGS_UNIVERSITY_ID, ROOM_UTILIZATION_META_COLLECTION),
    []
  );
  const enrollmentProjectionsCollection = useMemo(
    () => collection(db, 'universities', HASTINGS_UNIVERSITY_ID, ENROLLMENT_PROJECTIONS_COLLECTION),
    []
  );

  const runCalculation = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      const [spaceConfigSnap, roomMetaSnap, enrollmentSnap, airtableRooms] = await Promise.all([
        getDocs(spaceConfigCollection),
        getDocs(roomUtilizationMetaCollection),
        getDocs(enrollmentProjectionsCollection),
        // Airtable is area-only input here (Current SF). A failed fetch
        // shouldn't block the rest of the table from computing -- every
        // category just falls back to 0 tagged/resolved SF instead of the
        // whole section erroring out, same fail-soft convention
        // UtilizationResultsSection already uses for this endpoint.
        fetchAirtableRoomsForUtilization().catch((error) => {
          console.warn('Airtable rooms fetch failed for space growth calc:', error);
          return [];
        })
      ]);

      const spaceConfigDocs = spaceConfigSnap.docs.map((docSnap) => ({
        category: docSnap.id,
        sfPerStationTarget: docSnap.data()?.sfPerStationTarget,
        targetUtilizationRate: docSnap.data()?.targetUtilizationRate
      }));
      const roomUtilizationMetaDocs = roomMetaSnap.docs.map((docSnap) => ({
        roomKey: docSnap.id,
        ...docSnap.data()
      }));
      const enrollmentProjectionDocs = enrollmentSnap.docs.map((docSnap) => docSnap.data());
      const airtableAreaByRoomKey = buildAirtableAreaMap(airtableRooms);

      setResult(computeSpaceGrowth({
        spaceConfigDocs,
        roomUtilizationMetaDocs,
        airtableAreaByRoomKey,
        baselineYear: BASELINE_ENROLLMENT_YEAR,
        targetYear,
        enrollmentProjectionDocs
      }));
    } catch (error) {
      setLoadError(String(error?.message || 'Failed to compute space growth.'));
    } finally {
      setLoading(false);
    }
  }, [spaceConfigCollection, roomUtilizationMetaCollection, enrollmentProjectionsCollection, targetYear]);

  // Re-runs whenever targetYear changes (it's a dependency of runCalculation
  // above), not just on mount -- picking a new target year in the selector
  // below recalculates automatically, no separate "apply" step needed.
  useEffect(() => {
    void runCalculation();
  }, [runCalculation]);

  const missingBaselineEnrollment = result && !Number.isFinite(result.baselineEnrollment);
  const missingTargetEnrollment = result && !Number.isFinite(result.targetEnrollment);

  return (
    <div style={{ marginTop: 10, borderTop: '1px solid #edf2f7', paddingTop: 8 }}>
      <details open={sectionOpen} onToggle={(event) => setSectionOpen(event.currentTarget.open)}>
        <summary style={{ fontWeight: 700, fontSize: 12.5, cursor: 'pointer', color: '#1d2939' }}>
          Space Growth / Right-Sizing
        </summary>

        <div style={{ marginTop: 4, fontSize: 10.5, color: '#667085', lineHeight: 1.35 }}>
          Per space category: Current SF (Airtable area summed across rooms tagged with that category above),
          Ideal SF (that category's Ideal NSF/Student -- Space Configuration's SF/station target divided by its
          target utilization rate above -- times enrollment), and the gap between them, now and at a target
          year. Read-only; nothing here is written anywhere.
        </div>

        <div style={{ marginTop: 4, fontSize: 10.5, color: '#b45309', fontWeight: 600, lineHeight: 1.35 }}>
          Uses institution-wide enrollment only, not department-specific -- these numbers are a rough,
          whole-campus estimate, not a precise per-program breakdown.
        </div>

        <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
          <label style={{ fontSize: 11, color: '#344054', display: 'flex', alignItems: 'center', gap: 6 }}>
            Target year
            <select
              value={targetYear}
              onChange={(e) => setTargetYear(Number(e.target.value))}
              style={{ fontSize: 11, padding: '3px 5px' }}
            >
              {TARGET_YEAR_OPTIONS.map((year) => (
                <option key={year} value={year}>{year}</option>
              ))}
            </select>
          </label>
          <button className="btn" type="button" onClick={() => void runCalculation()} disabled={loading}>
            {loading ? 'Calculating...' : 'Recalculate'}
          </button>
        </div>

        {missingBaselineEnrollment ? (
          <div style={{ marginTop: 8, padding: '6px 8px', borderRadius: 6, fontSize: 11, background: '#fef2f2', border: '1px solid #fecaca', color: '#b42318' }}>
            No institution-wide enrollment found for {BASELINE_ENROLLMENT_YEAR} in Enrollment & FTE Projections above --
            upload that workbook first. Ideal SF / gap columns can't be computed without it.
          </div>
        ) : missingTargetEnrollment ? (
          <div style={{ marginTop: 8, padding: '6px 8px', borderRadius: 6, fontSize: 11, background: '#fffbeb', border: '1px solid #fde68a', color: '#92400e' }}>
            No institution-wide enrollment found for {targetYear} -- the {targetYear} Ideal SF / gap columns
            will show "—" until that year's row is imported.
          </div>
        ) : null}

        {loading && !result ? (
          <div style={{ marginTop: 8, fontSize: 11, color: '#667085' }}>Calculating...</div>
        ) : result && result.rows.length ? (
          <div style={{ marginTop: 8, overflowX: 'auto' }}>
            <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 11 }}>
              <thead>
                <tr style={{ textAlign: 'left', borderBottom: '1px solid #d0d7e2' }}>
                  <th style={{ padding: '4px 6px' }}>Category</th>
                  <th style={{ padding: '4px 6px' }}>Ideal NSF/Student</th>
                  <th style={{ padding: '4px 6px' }}>Tagged Rooms</th>
                  <th style={{ padding: '4px 6px' }}>Current SF</th>
                  <th style={{ padding: '4px 6px' }}>Ideal SF ({BASELINE_ENROLLMENT_YEAR})</th>
                  <th style={{ padding: '4px 6px' }}>Gap ({BASELINE_ENROLLMENT_YEAR})</th>
                  <th style={{ padding: '4px 6px' }}>Ideal SF ({targetYear})</th>
                  <th style={{ padding: '4px 6px' }}>Gap ({targetYear})</th>
                </tr>
              </thead>
              <tbody>
                {result.rows.map((row) => {
                  // Low/zero tagged-room count is flagged visibly (per
                  // explicit instruction) rather than letting a category
                  // with only 1-2 tagged rooms look just as authoritative
                  // as one built from a real sample.
                  const lowConfidence = row.taggedRoomCount <= 2;
                  return (
                    <tr
                      key={row.category}
                      style={{
                        borderBottom: '1px solid #f1f5f9',
                        background: lowConfidence ? '#fffbeb' : 'transparent'
                      }}
                    >
                      <td style={{ padding: '4px 6px', fontWeight: 600 }}>{row.category}</td>
                      <td style={{ padding: '4px 6px' }}>
                        {row.idealNsfPerStudent != null ? (
                          <>
                            {(Math.round(row.idealNsfPerStudent * 100) / 100).toLocaleString()}
                            <div style={{ fontSize: 9, color: '#98a2b3' }}>
                              ({row.sfPerStationTarget.toLocaleString()} SF/station ÷ {Math.round(row.targetUtilizationRate * 100)}%)
                            </div>
                          </>
                        ) : (
                          <span style={{ color: '#94a3b8', fontStyle: 'italic' }}>
                            not set
                            <div style={{ fontSize: 9 }}>
                              (SF/station: {row.sfPerStationTarget != null ? row.sfPerStationTarget.toLocaleString() : 'not set'},
                              {' '}target utilization: {row.targetUtilizationRate != null ? `${Math.round(row.targetUtilizationRate * 100)}%` : 'not set'})
                            </div>
                          </span>
                        )}
                      </td>
                      <td style={{ padding: '4px 6px', color: lowConfidence ? '#92400e' : 'inherit', fontWeight: lowConfidence ? 700 : 400 }}>
                        {row.taggedRoomCount}
                        {row.taggedRoomCount === 0 ? ' (no tagged rooms)' : lowConfidence ? ' (low sample)' : ''}
                      </td>
                      <td style={{ padding: '4px 6px' }}>{formatGrowthSF(row.currentSF)}</td>
                      <td style={{ padding: '4px 6px' }}>{formatGrowthSF(row.idealSfNow)}</td>
                      <td style={{ padding: '4px 6px' }}>{formatGrowthGap(row.gapNow)}</td>
                      <td style={{ padding: '4px 6px' }}>{formatGrowthSF(row.idealSfTarget)}</td>
                      <td style={{ padding: '4px 6px' }}>{formatGrowthGap(row.gapTarget)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div style={{ marginTop: 8, fontSize: 11, color: '#667085' }}>
            No space categories defined yet -- add at least one in Space Configuration above.
          </div>
        )}

        {loadError ? <div style={{ marginTop: 6, fontSize: 10.5, color: '#b42318' }}>{loadError}</div> : null}
      </details>
    </div>
  );
}

// Utilization Calc Engine (roadmap item 6/6) -- the first real output of
// this module. Strictly read-only against courseMeetings/terms/Airtable;
// nothing here writes anything, unlike every section above. Does NOT depend
// on roomUtilizationMeta tagging -- Time/Seat Utilization are computed from
// courseMeetings+terms+Airtable capacity alone, per Clark's confirmation
// this session that space-category tagging only matters for the future
// growth/right-sizing module, not this one.
//
// Per Clark's decision, results are room+term grain, not room-level: a room
// used in both Fall 2026 Block 1 and Block 2 produces two separate rows,
// each scored only against that term's own meetings and standardWeeklyHours
// -- never blended. See classroomUtilizationCalc.js's computeClassroomUtilization
// header comment for the full reasoning, including why a term-unmatched
// meeting has no row to belong to at all (not just no Time Utilization).
//
// Live Firestore verification of courseMeetings/terms field shapes was
// attempted via a browser-console snippet this session but blocked by a
// DevTools paste/autoclose issue unrelated to the snippet itself (confirmed
// clean via node -c, no BOM, no non-ASCII, no CRLF). This section is built
// defensively against the two conditions that couldn't be pre-verified --
// see classroomUtilizationCalc.js's header comment for the full reasoning:
// a courseMeetings doc whose sessionRaw doesn't resolve to any terms doc is
// excluded from Time Utilization and counted in the visible banner below,
// never silently dropped or defaulted; enrollment/capacity being null/absent
// per meeting or room shows as an explicit "pending enrollment data" /
// "capacity unknown" label, never a blank cell or a fabricated 0%.
function formatPct(value) {
  return Number.isFinite(value) ? `${Math.round(value)}%` : '—';
}

function UtilizationResultsSection() {
  const [result, setResult] = useState(null); // { rooms, buildingSummary, unmatchedMeetings }
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  // Collapsed by default -- same disclosure pattern as RoomUtilizationMetaSection
  // (layout-only addition; runCalculation()'s useEffect below still runs
  // unconditionally on mount regardless of open/collapsed state). No count in
  // the summary label -- this section's content is a full calculation result
  // table, not a simple count, same reasoning Space Growth below follows.
  const [sectionOpen, setSectionOpen] = useState(false);

  const courseMeetingsCollection = useMemo(
    () => collection(db, 'universities', HASTINGS_UNIVERSITY_ID, COURSE_MEETINGS_COLLECTION),
    []
  );
  const termsCollection = useMemo(
    () => collection(db, 'universities', HASTINGS_UNIVERSITY_ID, TERMS_COLLECTION),
    []
  );

  const runCalculation = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      // Airtable fetched via the existing, already-read-only /ai/api/rooms
      // endpoint (same one StakeholderMap.jsx's Airtable sync uses) -- not
      // fetched in parallel with the two Firestore reads below on purpose,
      // no shared failure-handling need, but Promise.all is fine here since
      // none of the three depends on another's result.
      const [meetingsSnap, termsSnap, airtableRooms] = await Promise.all([
        getDocs(courseMeetingsCollection),
        getDocs(termsCollection),
        fetchAirtableRoomsForUtilization().catch((error) => {
          // Airtable is capacity-only input here (Seat Utilization). A
          // failed fetch shouldn't block Time Utilization from computing --
          // every room just falls back to "capacity unknown" instead of the
          // whole section erroring out. The error is still surfaced below.
          console.warn('Airtable rooms fetch failed for utilization calc:', error);
          return [];
        })
      ]);
      const courseMeetingDocs = meetingsSnap.docs.map((docSnap) => docSnap.data());
      const termDocs = termsSnap.docs.map((docSnap) => ({ id: docSnap.id, data: docSnap.data() }));
      setResult(computeClassroomUtilization({ courseMeetingDocs, termDocs, airtableRooms }));
    } catch (error) {
      setLoadError(String(error?.message || 'Failed to compute utilization.'));
    } finally {
      setLoading(false);
    }
  }, [courseMeetingsCollection, termsCollection]);

  useEffect(() => {
    void runCalculation();
  }, [runCalculation]);

  const unmatchedCount = result?.unmatchedMeetings?.length || 0;

  return (
    <div style={{ marginTop: 10, borderTop: '1px solid #edf2f7', paddingTop: 8 }}>
      <details open={sectionOpen} onToggle={(event) => setSectionOpen(event.currentTarget.open)}>
        <summary style={{ fontWeight: 700, fontSize: 12.5, cursor: 'pointer', color: '#1d2939' }}>
          Utilization Results
        </summary>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, marginTop: 6 }}>
          <button className="btn" type="button" onClick={() => void runCalculation()} disabled={loading}>
            {loading ? 'Calculating...' : 'Recalculate'}
          </button>
        </div>

        <div style={{ marginTop: 4, fontSize: 10.5, color: '#667085', lineHeight: 1.35 }}>
          One row per room per term -- a room used in both Fall 2026 Block 1 and Block 2 shows as two rows.
          Read-only -- does not require room tagging above.
        </div>

        <div style={{ marginTop: 6, fontSize: 10.5, color: '#667085', lineHeight: 1.4 }}>
          <strong style={{ color: '#475467' }}>Time Utilization</strong> compares scheduled class hours against that
          term's Standard Weekly Hours -- the baseline you set in the Terms section above for what counts as a
          fully-booked week (e.g., an 8-hour teaching day × 5 days). A room scheduled beyond that baseline (over 100%)
          means it's booked more than your defined standard, which may indicate a scheduling conflict worth checking.
          Each row's actual standard is shown next to its term below.
          (Formula: that term's weekly hours scheduled ÷ that term's standard weekly hours.)
        </div>

        <div style={{ marginTop: 4, fontSize: 10.5, color: '#667085', lineHeight: 1.4 }}>
          <strong style={{ color: '#475467' }}>Seat Utilization</strong> shows how full a room's classes run on
          average relative to how many seats it has -- a room at 100% is filling every seat, on average, across
          its scheduled classes. Only shown once both enrollment and capacity are known.
          (Formula: average enrollment ÷ Airtable seat capacity.)
        </div>

        {unmatchedCount > 0 ? (
          <div
            style={{
              marginTop: 8,
              padding: '8px 10px',
              borderRadius: 6,
              fontSize: 12,
              fontWeight: 700,
              background: '#fffbeb',
              border: '1px solid #fde68a',
              color: '#92400e'
            }}
          >
            {unmatchedCount} meeting{unmatchedCount === 1 ? '' : 's'} couldn't be matched to a term
            (excluded from these results entirely -- no term means no row to belong to) -- see details below.
          </div>
        ) : null}

      {loading && !result ? (
        <div style={{ marginTop: 8, fontSize: 11, color: '#667085' }}>Calculating utilization...</div>
      ) : result && result.rooms.length ? (
        <div style={{ marginTop: 8, overflowX: 'auto' }}>
          <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 11 }}>
            <thead>
              <tr style={{ textAlign: 'left', borderBottom: '1px solid #d0d7e2' }}>
                <th style={{ padding: '4px 6px' }}>Building</th>
                <th style={{ padding: '4px 6px' }}>Room</th>
                <th style={{ padding: '4px 6px' }}>Term</th>
                <th style={{ padding: '4px 6px' }}>Time Util.</th>
                <th style={{ padding: '4px 6px' }}>Seat Util.</th>
                <th style={{ padding: '4px 6px' }}>Meetings</th>
              </tr>
            </thead>
            <tbody>
              {result.rooms.map((r) => (
                <tr key={r.rowKey} style={{ borderBottom: '1px solid #f1f5f9' }}>
                  <td style={{ padding: '4px 6px' }}>{r.building}</td>
                  <td style={{ padding: '4px 6px' }}>{r.room}</td>
                  <td style={{ padding: '4px 6px' }}>
                    {r.termLabel}
                    {r.standardWeeklyHoursAvailable > 0 ? (
                      <div style={{ fontSize: 9.5, color: '#98a2b3' }}>
                        ({r.standardWeeklyHoursAvailable} hrs/wk standard)
                      </div>
                    ) : null}
                  </td>
                  <td style={{ padding: '4px 6px' }}>{formatPct(r.timeUtilizationPct)}</td>
                  <td style={{ padding: '4px 6px', color: r.seatUtilizationStatus === 'computed' ? 'inherit' : '#94a3b8', fontStyle: r.seatUtilizationStatus === 'computed' ? 'normal' : 'italic' }}>
                    {r.seatUtilizationStatus === 'computed'
                      ? formatPct(r.seatUtilizationPct)
                      : r.seatUtilizationStatus === 'capacity-unknown'
                        ? 'capacity unknown'
                        : 'pending enrollment data'}
                  </td>
                  <td style={{ padding: '4px 6px' }}>{r.meetingCount}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {result.buildingSummary.length ? (
            <>
              <div style={{ marginTop: 10, fontSize: 11, fontWeight: 600, color: '#344054' }}>By building</div>
              <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 11, marginTop: 4 }}>
                <thead>
                  <tr style={{ textAlign: 'left', borderBottom: '1px solid #d0d7e2' }}>
                    <th style={{ padding: '4px 6px' }}>Building</th>
                    <th style={{ padding: '4px 6px' }}>Time Util.</th>
                    <th style={{ padding: '4px 6px' }}>Rooms</th>
                  </tr>
                </thead>
                <tbody>
                  {result.buildingSummary.map((b) => (
                    <tr key={b.building} style={{ borderBottom: '1px solid #f1f5f9' }}>
                      <td style={{ padding: '4px 6px' }}>{b.building}</td>
                      <td style={{ padding: '4px 6px' }}>{formatPct(b.timeUtilizationPct)}</td>
                      <td style={{ padding: '4px 6px' }}>{b.roomCount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          ) : null}

          {unmatchedCount > 0 ? (
            <details style={{ marginTop: 10, fontSize: 10.5 }}>
              <summary style={{ cursor: 'pointer', color: '#92400e', fontWeight: 600 }}>
                Unmatched meetings ({unmatchedCount})
              </summary>
              <div style={{ marginTop: 6, display: 'grid', gap: 4 }}>
                {result.unmatchedMeetings.map((m, i) => (
                  <div key={i} style={{ padding: 6, background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 4 }}>
                    {m.building} — {m.room} — {m.courseCode || '(no course code)'} — sessionRaw: "{m.sessionRaw}"
                    {m.sessionLabel ? ` (${m.sessionLabel})` : ''} — {m.reason}
                    {m.derivedTermId ? ` (looked for term "${m.derivedTermId}")` : ''}
                  </div>
                ))}
              </div>
            </details>
          ) : null}
        </div>
      ) : (
        <div style={{ marginTop: 8, fontSize: 11, color: '#667085' }}>
          No courseMeetings data to compute against yet -- run Import Schedule above first.
        </div>
      )}

        {loadError ? <div style={{ marginTop: 6, fontSize: 10.5, color: '#b42318' }}>{loadError}</div> : null}
      </details>
    </div>
  );
}

// Structural split (2026-08-19), per Clark's decision: what used to be one
// combined panel mounting all six sections below is now two separate
// dashboard boxes in StakeholderMap.jsx -- ClassroomUtilizationPanel (this
// component: Import Schedule, Terms, Utilization Results) and
// SpaceGrowthProjectionsPanel (below: Space Configuration, Room Utilization
// Tagging, Enrollment & FTE Projections, Space Growth / Right-Sizing).
// Deliberately kept as two exports from this ONE file rather than two
// files: every section function above (SpaceConfigSection, TermsSection,
// etc.) and the shared constants/helpers at the top (HASTINGS_UNIVERSITY_ID,
// BATCH_CHUNK_SIZE, summarizeDocs) are used by whichever of the two panels
// needs them -- splitting into separate files would force either duplicating
// those or introducing a third shared-helpers file, neither of which this
// reorganization needs. Both panels are still gated by the exact same
// enableClassroomUtilization flag -- no second flag introduced, per
// explicit instruction; StakeholderMap.jsx now mounts both as separate
// .dashboard-box elements under that one existing condition. Pure layout
// reorganization -- no section's internal state, effects, Firestore reads/
// writes, or calculation logic changed; each section still fetches on
// mount exactly as before, just now as a child of a different parent.
export default function ClassroomUtilizationPanel({
  enabled = false,
  // Deliberately distinct from SpaceDashboardPanel's pre-existing, unrelated
  // "Classroom Utilization" section (static-CSV-backed, always on for
  // non-Sarpy tenants) so the two aren't mistaken for one another in the UI.
  title = 'Classroom Utilization'
}) {
  const [summary, setSummary] = useState(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summaryError, setSummaryError] = useState('');
  // Collapsed by default -- same disclosure pattern as every section below.
  // Layout-only: refreshSummary()'s useEffect further down still runs
  // unconditionally on mount regardless of open/collapsed state.
  const [importSectionOpen, setImportSectionOpen] = useState(false);

  // null | 'fetching' | 'clearing' | 'writing' -- distinct phases so the
  // button/status text never looks like a silent pause, especially during
  // 'clearing' (the new delete-then-write step, see handleImportSchedule).
  const [importPhase, setImportPhase] = useState(null);
  const [importMessage, setImportMessage] = useState('');
  const [importError, setImportError] = useState('');

  const refreshSummary = useCallback(async () => {
    if (!enabled) return;
    setSummaryLoading(true);
    setSummaryError('');
    try {
      const snap = await getDocs(
        collection(db, 'universities', HASTINGS_UNIVERSITY_ID, COURSE_MEETINGS_COLLECTION)
      );
      setSummary(summarizeDocs(snap.docs.map((docSnap) => docSnap.data())));
    } catch (error) {
      setSummaryError(String(error?.message || 'Failed to load imported schedule summary.'));
    } finally {
      setSummaryLoading(false);
    }
  }, [enabled]);

  useEffect(() => {
    void refreshSummary();
  }, [refreshSummary]);

  const handleImportSchedule = useCallback(async () => {
    if (!enabled || importPhase) return;
    // Local mirror of importPhase (not just the React state) so the catch
    // block below can name exactly which phase failed without depending on
    // a state update having flushed yet.
    let phase = 'fetching';
    setImportPhase(phase);
    setImportMessage('');
    setImportError('');
    try {
      const rawRows = await fetchClassScheduleRows();
      const dedupedRows = dedupeCrossTalliedScheduleRows(rawRows);

      const meetingsCollection = collection(
        db, 'universities', HASTINGS_UNIVERSITY_ID, COURSE_MEETINGS_COLLECTION
      );

      // Clear existing docs first so stale docs written under a since-changed
      // meetingId scheme (or just stale data in general) can never coexist
      // with the fresh batch below -- makes re-running the import idempotent
      // (always lands on exactly len(dedupedRows) docs) instead of merge-only
      // accumulating orphans. If this fails partway, we stop here and never
      // reach the write step below, rather than writing fresh data on top of
      // a partially-cleared collection.
      phase = 'clearing';
      setImportPhase(phase);
      const existingSnap = await getDocs(meetingsCollection);
      const existingRefs = existingSnap.docs.map((docSnap) => docSnap.ref);
      for (let i = 0; i < existingRefs.length; i += BATCH_CHUNK_SIZE) {
        const chunk = existingRefs.slice(i, i + BATCH_CHUNK_SIZE);
        if (!chunk.length) continue;
        const batch = writeBatch(db);
        chunk.forEach((ref) => batch.delete(ref));
        await batch.commit();
      }

      phase = 'writing';
      setImportPhase(phase);
      for (let i = 0; i < dedupedRows.length; i += BATCH_CHUNK_SIZE) {
        const chunk = dedupedRows.slice(i, i + BATCH_CHUNK_SIZE);
        if (!chunk.length) continue;
        const batch = writeBatch(db);
        chunk.forEach((entry) => {
          const meetingId = buildCourseMeetingId(entry);
          batch.set(doc(meetingsCollection, meetingId), {
            ...mapScheduleEntryToCourseMeetingDoc(entry),
            importedAt: serverTimestamp()
          }, { merge: true });
        });
        await batch.commit();
      }

      const roomKeys = new Set(
        dedupedRows.map((entry) => (
          `${String(entry?.building || '').trim().toLowerCase()}||${String(entry?.room || '').trim().toLowerCase()}`
        ))
      );
      setImportMessage(
        `Cleared ${existingRefs.length.toLocaleString()} old record${existingRefs.length === 1 ? '' : 's'}, `
        + `imported ${dedupedRows.length.toLocaleString()} course meeting${dedupedRows.length === 1 ? '' : 's'} `
        + `across ${roomKeys.size.toLocaleString()} room${roomKeys.size === 1 ? '' : 's'} `
        + `(${rawRows.length.toLocaleString()} raw rows deduped).`
      );
      await refreshSummary();
    } catch (error) {
      const phaseLabel = phase === 'clearing'
        ? 'Failed while clearing old data (nothing new was written): '
        : phase === 'writing'
          ? 'Failed while writing new data (old data was already cleared): '
          : 'Failed to fetch schedule: ';
      setImportError(phaseLabel + String(error?.message || 'unknown error.'));
    } finally {
      setImportPhase(null);
    }
  }, [enabled, importPhase, refreshSummary]);

  if (!enabled) return null;

  const hasImportedData = Boolean(summary && summary.meetingCount > 0);

  // Meeting/room count visible in the summary label without expanding, same
  // convention as SpaceConfigSection/TermsSection above.
  const importSummaryLabel = hasImportedData
    ? `Import Schedule (${summary.meetingCount.toLocaleString()} meeting${summary.meetingCount === 1 ? '' : 's'}, ${summary.roomCount.toLocaleString()} room${summary.roomCount === 1 ? '' : 's'})`
    : 'Import Schedule';

  return (
    <div
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
      {/* Panel title stays always-visible (it names the whole module, not a
          collapsible sub-section) -- "Import Schedule" itself becomes its
          own collapsible section directly below, same pattern as every
          other section in this panel. */}
      <h4 style={{ margin: 0, fontSize: 12.5 }}>{title}</h4>

      <div style={{ marginTop: 10, borderTop: '1px solid #edf2f7', paddingTop: 8 }}>
        <details open={importSectionOpen} onToggle={(event) => setImportSectionOpen(event.currentTarget.open)}>
          <summary style={{ fontWeight: 700, fontSize: 12.5, cursor: 'pointer', color: '#1d2939' }}>
            {importSummaryLabel}
          </summary>

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, marginTop: 6 }}>
            <button
              className="btn"
              type="button"
              onClick={() => void handleImportSchedule()}
              disabled={Boolean(importPhase)}
            >
              {importPhase === 'fetching' ? 'Fetching schedule...'
                : importPhase === 'clearing' ? 'Clearing old data...'
                : importPhase === 'writing' ? 'Importing...'
                : 'Import Schedule'}
            </button>
          </div>

          <div style={{ marginTop: 4, fontSize: 11, color: '#667085', lineHeight: 1.35 }}>
            {summaryLoading && !summary ? (
              'Loading imported schedule summary...'
            ) : hasImportedData ? (
              `${summary.meetingCount.toLocaleString()} course meeting${summary.meetingCount === 1 ? '' : 's'} imported, `
              + `covering ${summary.roomCount.toLocaleString()} room${summary.roomCount === 1 ? '' : 's'}.`
            ) : (
              'No schedule data imported yet.'
            )}
          </div>

          {summaryError ? (
            <div style={{ marginTop: 6, fontSize: 10.5, color: '#b42318' }}>{summaryError}</div>
          ) : null}
          {importMessage ? (
            <div style={{ marginTop: 6, fontSize: 10.5, color: '#15803d' }}>{importMessage}</div>
          ) : null}
          {importError ? (
            <div style={{ marginTop: 6, fontSize: 10.5, color: '#b42318' }}>{importError}</div>
          ) : null}
        </details>
      </div>

      <TermsSection />
      <UtilizationResultsSection />
    </div>
  );
}

// Second dashboard box (see the split comment above ClassroomUtilizationPanel
// for the full reasoning). Same enableClassroomUtilization flag gates this
// panel too -- StakeholderMap.jsx passes the identical condition to both
// `enabled` props, no second flag exists anywhere.
export function SpaceGrowthProjectionsPanel({
  enabled = false,
  title = 'Space Growth Projections'
}) {
  if (!enabled) return null;

  return (
    <div
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
      <h4 style={{ margin: 0, fontSize: 12.5 }}>{title}</h4>

      <SpaceConfigSection />
      <RoomUtilizationMetaSection />
      <EnrollmentProjectionsSection />
      <SpaceGrowthSection />
    </div>
  );
}
