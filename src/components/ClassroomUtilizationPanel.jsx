// src/components/ClassroomUtilizationPanel.jsx
//
// Classroom Utilization module (Hastings-only, admin-only, gated by
// config.enableClassroomUtilization -- off by default, same convention as
// CapitalPrioritiesPanel/enableCapitalPriorities).
//
// "Import Schedule" fetches the existing, read-only /class-schedule endpoint
// and writes the deduped result into universities/hastings/courseMeetings --
// the only collection this panel ever writes to. Nothing here reads or
// writes any existing collection, and nothing here touches server.js or any
// other panel.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Timestamp, collection, doc, getDocs, onSnapshot, serverTimestamp, setDoc, writeBatch } from 'firebase/firestore';
import { db } from '../firebaseConfig';
import {
  COURSE_MEETINGS_COLLECTION,
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
import { computeClassroomUtilization, fetchAirtableRoomsForUtilization } from '../utils/classroomUtilizationCalc';

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

  return (
    <div style={{ marginTop: 10, borderTop: '1px solid #edf2f7', paddingTop: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <h4 style={{ margin: 0, fontSize: 12.5 }}>Space Configuration</h4>
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

  return (
    <div style={{ marginTop: 10, borderTop: '1px solid #edf2f7', paddingTop: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <h4 style={{ margin: 0, fontSize: 12.5 }}>Terms</h4>
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
  const [form, setForm] = useState({}); // roomKey -> {spaceCategory, notes}
  const [persisted, setPersisted] = useState({}); // roomKey -> {spaceCategory, notes}, only for rooms with an existing doc
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState('');
  const [saveError, setSaveError] = useState('');

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
      },
      (error) => setLoadError(String(error?.message || 'Failed to load space categories.'))
    );
    return () => unsubscribe();
  }, [spaceConfigCollection]);

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
              return (
                <div
                  key={roomKey}
                  style={{
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
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <h4 style={{ margin: 0, fontSize: 12.5 }}>Utilization Results</h4>
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
    </div>
  );
}

export default function ClassroomUtilizationPanel({
  enabled = false,
  // Deliberately distinct from SpaceDashboardPanel's pre-existing, unrelated
  // "Classroom Utilization" section (static-CSV-backed, always on for
  // non-Sarpy tenants) so the two aren't mistaken for one another in the UI.
  title = 'Classroom Utilization Planner'
}) {
  const [summary, setSummary] = useState(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summaryError, setSummaryError] = useState('');

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
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <h4 style={{ margin: 0, fontSize: 12.5 }}>{title}</h4>
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

      <div style={{ marginTop: 10, fontSize: 11, color: '#667085', lineHeight: 1.35 }}>
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

      <SpaceConfigSection />
      <TermsSection />
      <RoomUtilizationMetaSection />
      <UtilizationResultsSection />
    </div>
  );
}
