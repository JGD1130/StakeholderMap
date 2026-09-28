// src/components/ClassroomUtilizationSetupTab.jsx
//
// Setup tab of the Classroom Utilization workspace (admin tools, moved out of
// the side panel's old <details> sections):
//   - Class schedule: imported meeting/room counts and Import Schedule, behind
//     a confirm dialog. Import clears the imported class meetings, then writes
//     the freshly fetched, de-duplicated schedule (same steps the side panel
//     used to run); reload() runs afterwards whether it succeeded or failed.
//   - Terms: the Terms editor, moved here from ClassroomUtilizationPanel.jsx's
//     TermsSection with the same load / validate / save logic (the hard-coded
//     "Fall 2026 Block 1/2" quick-fill buttons are gone).
//   - Data quality: meetings whose term couldn't be matched, and classrooms
//     with no seat count on file.
// Writes go to the same university the shared hook reads from (data.universityId).
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Timestamp, collection, doc, getDocs, serverTimestamp, setDoc, writeBatch } from 'firebase/firestore';
import { db } from '../firebaseConfig';
import { COURSE_MEETINGS_COLLECTION, TERMS_COLLECTION } from '../utils/classroomUtilizationSchema';
import {
  buildCourseMeetingId,
  dedupeCrossTalliedScheduleRows,
  fetchClassScheduleRows,
  mapScheduleEntryToCourseMeetingDoc
} from '../utils/classroomScheduleImport';
import { isAbortError } from '../utils/fetchWithTimeout';
import { MF } from '../theme/mfTokens';
import { WorkspaceShell, MfGrid, MfCol, ChartCard } from './mf';
import { mfPrimaryButtonStyle, mfSecondaryButtonStyle, mfInputStyle } from './mf/mfStyles';
import {
  formatTermId,
  scheduleSummaryLine,
  importConfirmMessage,
  unmatchedMeetingRows,
  unknownCapacityRooms
} from './classroomUtilizationView';

const BATCH_CHUNK_SIZE = 400; // Firestore's cap is 500 ops per batch

const noteStyle = { fontSize: 12, color: MF.ink.secondary, lineHeight: 1.45 };
const mutedStyle = { fontSize: 12, color: MF.ink.muted, lineHeight: 1.45 };
const errorStyle = { fontSize: 12, color: MF.status.error, lineHeight: 1.45 };

function disabledStyle(disabled) {
  return disabled ? { opacity: 0.55, cursor: 'default' } : null;
}

// --- Class schedule ---------------------------------------------------------------
function ConfirmImportDialog({ message, onCancel, onConfirm }) {
  return (
    <WorkspaceShell size="dialog" title="Import class schedule" onClose={onCancel}>
      <div style={{ fontSize: 13, color: MF.ink.primary, lineHeight: 1.5 }}>{message}</div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 20 }}>
        <button type="button" className="mf-shell-button" style={{ ...mfSecondaryButtonStyle, '--mf-focus-color': MF.util.base }} onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="mf-shell-button" style={{ ...mfPrimaryButtonStyle, '--mf-focus-color': MF.util.base }} onClick={onConfirm}>
          Replace schedule
        </button>
      </div>
    </WorkspaceShell>
  );
}

const IMPORT_PHASE_LABELS = {
  fetching: 'Fetching schedule…',
  clearing: 'Clearing old meetings…',
  writing: 'Importing…'
};

function ScheduleCard({ data }) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [phase, setPhase] = useState(null); // null | 'fetching' | 'clearing' | 'writing'
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const runImport = useCallback(async () => {
    if (phase) return;
    let current = 'fetching';
    setPhase(current);
    setMessage('');
    setError('');
    try {
      const rawRows = await fetchClassScheduleRows();
      const dedupedRows = dedupeCrossTalliedScheduleRows(rawRows);
      const meetingsCollection = collection(db, 'universities', data.universityId, COURSE_MEETINGS_COLLECTION);

      // Clear first so re-running always lands on exactly the new schedule;
      // a failure here stops before anything new is written.
      current = 'clearing';
      setPhase(current);
      const existingRefs = (await getDocs(meetingsCollection)).docs.map((docSnap) => docSnap.ref);
      for (let i = 0; i < existingRefs.length; i += BATCH_CHUNK_SIZE) {
        const batch = writeBatch(db);
        existingRefs.slice(i, i + BATCH_CHUNK_SIZE).forEach((ref) => batch.delete(ref));
        await batch.commit();
      }

      current = 'writing';
      setPhase(current);
      for (let i = 0; i < dedupedRows.length; i += BATCH_CHUNK_SIZE) {
        const batch = writeBatch(db);
        dedupedRows.slice(i, i + BATCH_CHUNK_SIZE).forEach((entry) => {
          batch.set(doc(meetingsCollection, buildCourseMeetingId(entry)), {
            ...mapScheduleEntryToCourseMeetingDoc(entry),
            importedAt: serverTimestamp()
          }, { merge: true });
        });
        await batch.commit();
      }

      const roomKeys = new Set(dedupedRows.map((entry) => (
        `${String(entry?.building || '').trim().toLowerCase()}||${String(entry?.room || '').trim().toLowerCase()}`
      )));
      setMessage(
        `Imported ${dedupedRows.length.toLocaleString('en-US')} class meetings across `
        + `${roomKeys.size.toLocaleString('en-US')} rooms (replacing ${existingRefs.length.toLocaleString('en-US')}; `
        + 'cross-listed sections combined).'
      );
    } catch (importError) {
      const where = current === 'clearing'
        ? 'Import stopped while clearing the old meetings — nothing new was written. '
        : current === 'writing'
          ? 'Import stopped while writing — the old meetings were already cleared, so run Import again. '
          : 'Couldn’t fetch the schedule. ';
      console.error('Class schedule import failed.', importError);
      setError(where + (isAbortError(importError)
        ? 'The schedule server didn’t respond in time (it may be waking up) — try again.'
        : String(importError?.message || 'Unknown error.')));
    } finally {
      setPhase(null);
      void data.reload();
    }
  }, [phase, data]);

  return (
    <ChartCard title="Class schedule" autoHeight>
      {() => (
        <>
          <div style={noteStyle}>{scheduleSummaryLine(data.results)}</div>
          <div style={{ ...mutedStyle, marginTop: 6 }}>
            Import replaces every imported class meeting with the current registrar schedule.
          </div>
          <div style={{ marginTop: 12 }}>
            <button
              type="button"
              className="mf-shell-button"
              onClick={() => setConfirmOpen(true)}
              disabled={Boolean(phase)}
              style={{ ...mfPrimaryButtonStyle, '--mf-focus-color': MF.util.base, ...disabledStyle(Boolean(phase)) }}
            >
              {phase ? IMPORT_PHASE_LABELS[phase] : 'Import Schedule'}
            </button>
          </div>
          {message ? <div style={{ ...noteStyle, marginTop: 8 }}>{message}</div> : null}
          {error ? <div role="alert" style={{ ...errorStyle, marginTop: 8 }}>{error}</div> : null}
          {confirmOpen ? (
            <ConfirmImportDialog
              message={importConfirmMessage(data.results)}
              onCancel={() => setConfirmOpen(false)}
              onConfirm={() => { setConfirmOpen(false); void runImport(); }}
            />
          ) : null}
        </>
      )}
    </ChartCard>
  );
}

// --- Terms ------------------------------------------------------------------------
// termId is deterministic (year-term-session, e.g. "2026-fall-1") so re-adding
// the same term can't create a duplicate doc. Must match
// classroomUtilizationCalc.js's buildTermId, which derives the same id from
// each meeting's term label.
function buildTermId({ academicYear, term, sessionNumber }) {
  const yearPart = String(academicYear ?? '').trim() || 'x';
  const termPart = String(term ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'x';
  const sessionPart = String(sessionNumber ?? '').trim() || 'x';
  return `${yearPart}-${termPart}-${sessionPart}`;
}

// Calendar dates stored at UTC midnight so the round trip can't drift a day
// with the browser's timezone.
function dateInputToTimestamp(dateStr) {
  if (!dateStr) return null;
  const [y, m, d] = String(dateStr).split('-').map(Number);
  if (!y || !m || !d) return null;
  return Timestamp.fromDate(new Date(Date.UTC(y, m - 1, d)));
}

function timestampToDateInput(ts) {
  if (!ts?.toDate) return '';
  const d = ts.toDate();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function validateTermRow(row) {
  const errors = [];
  const hours = Number(row.standardWeeklyHours);
  if (!Number.isFinite(hours) || hours <= 0) errors.push('Standard weekly hours must be a positive number');
  const session = Number(row.sessionNumber);
  if (!Number.isInteger(session) || session <= 0) errors.push('Block number must be a whole number above 0');
  if (!row.startDate) errors.push('Start date is required');
  if (!row.endDate) errors.push('End date is required');
  // ISO "YYYY-MM-DD" strings sort correctly with plain string comparison.
  if (row.startDate && row.endDate && !(row.endDate > row.startDate)) errors.push('End date must be after start date');
  return errors;
}

const fieldLabelStyle = { flex: '1 1 120px', minWidth: 120, fontSize: 11, fontWeight: 600, color: MF.ink.muted };
const fieldInputStyle = { ...mfInputStyle, display: 'block', width: '100%', marginTop: 3 };

function TermsCard({ data }) {
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
    () => collection(db, 'universities', data.universityId, TERMS_COLLECTION),
    [data.universityId]
  );

  const loadTerms = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      const snap = await getDocs(termsCollection);
      const nextPersisted = {};
      const order = [];
      snap.docs.forEach((docSnap) => {
        const d = docSnap.data() || {};
        order.push(docSnap.id);
        nextPersisted[docSnap.id] = {
          academicYear: d.academicYear ?? '',
          term: String(d.term || ''),
          sessionNumber: d.sessionNumber ?? '',
          startDate: timestampToDateInput(d.startDate),
          endDate: timestampToDateInput(d.endDate),
          standardWeeklyHours: Number.isFinite(Number(d.standardWeeklyHours)) ? String(d.standardWeeklyHours) : '',
          isHistorical: Boolean(d.isHistorical)
        };
      });
      order.sort((a, b) => a.localeCompare(b));
      setTermOrder(order);
      setPersisted(nextPersisted);
      setForm(nextPersisted);
    } catch (error) {
      console.error('Terms load failed.', error);
      setLoadError('Couldn’t load terms — close and reopen to try again.');
    } finally {
      setLoading(false);
    }
  }, [termsCollection]);

  useEffect(() => {
    void loadTerms();
  }, [loadTerms]);

  const handleFieldChange = useCallback((termId, field, value) => {
    setForm((prev) => ({ ...prev, [termId]: { ...prev[termId], [field]: value } }));
  }, []);

  const handleAddTerm = useCallback(() => {
    setAddError('');
    const academicYear = Number(newTermInputs.academicYear);
    const term = newTermInputs.term.trim();
    const sessionNumber = Number(newTermInputs.sessionNumber);
    if (!Number.isFinite(academicYear) || academicYear <= 0) { setAddError('Enter a valid year.'); return; }
    if (!term) { setAddError('Enter a term name (e.g. Fall).'); return; }
    if (!Number.isInteger(sessionNumber) || sessionNumber <= 0) { setAddError('Enter a block number (1, 2, …).'); return; }

    const termId = buildTermId({ academicYear, term, sessionNumber });
    if (termOrder.includes(termId)) { setAddError(`${formatTermId(termId)} already exists.`); return; }

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

  const dirtyTermIds = useMemo(() => termOrder.filter((termId) => isTermDirty(termId)), [termOrder, isTermDirty]);

  const handleSave = useCallback(async () => {
    if (saving || !dirtyTermIds.length) return;
    setSaving(true);
    setSaveMessage('');
    setSaveError('');

    const invalid = dirtyTermIds
      .map((termId) => ({ termId, errors: validateTermRow(form[termId]) }))
      .filter((entry) => entry.errors.length);
    if (invalid.length) {
      setSaveError(invalid.map((entry) => `${formatTermId(entry.termId)}: ${entry.errors.join('; ')}`).join(' · '));
      setSaving(false);
      return;
    }

    try {
      for (const termId of dirtyTermIds) {
        const row = form[termId];
        // Plain overwrite: the form supplies every field together.
        await setDoc(doc(termsCollection, termId), {
          academicYear: Number(row.academicYear),
          term: String(row.term).trim().toUpperCase(),
          sessionNumber: Number(row.sessionNumber),
          startDate: dateInputToTimestamp(row.startDate),
          endDate: dateInputToTimestamp(row.endDate),
          standardWeeklyHours: Number(row.standardWeeklyHours),
          isHistorical: Boolean(row.isHistorical)
        });
      }
      setSaveMessage(`Saved ${dirtyTermIds.length} ${dirtyTermIds.length === 1 ? 'term' : 'terms'}.`);
      await loadTerms();
      void data.reload();
    } catch (error) {
      console.error('Terms save failed.', error);
      setSaveError('Couldn’t save terms — try again.');
    } finally {
      setSaving(false);
    }
  }, [saving, dirtyTermIds, form, termsCollection, loadTerms, data]);

  const saveDisabled = saving || !dirtyTermIds.length;

  return (
    <ChartCard
      title="Terms"
      subtitle="Each term's dates and standard weekly hours — the scheduled week every classroom is measured against (e.g. 8 hours × 5 days = 40)."
      actions={(
        <button
          type="button"
          className="mf-shell-button"
          onClick={() => void handleSave()}
          disabled={saveDisabled}
          style={{ ...mfPrimaryButtonStyle, '--mf-focus-color': MF.util.base, ...disabledStyle(saveDisabled) }}
        >
          {saving ? 'Saving…' : `Save Terms${dirtyTermIds.length ? ` (${dirtyTermIds.length})` : ''}`}
        </button>
      )}
      autoHeight
    >
      {() => (
        <>
          <div style={mutedStyle}>Changed terms are highlighted; Save Terms saves them together.</div>
          {saveMessage ? <div style={{ ...noteStyle, marginTop: 6 }}>{saveMessage}</div> : null}
          {saveError ? <div role="alert" style={{ ...errorStyle, marginTop: 6 }}>{saveError}</div> : null}
          {loadError ? <div role="alert" style={{ ...errorStyle, marginTop: 6 }}>{loadError}</div> : null}

          {loading && !termOrder.length ? (
            <div style={{ ...mutedStyle, marginTop: 10 }}>Loading terms…</div>
          ) : (
            <div style={{ marginTop: 10, display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 10 }}>
              {termOrder.map((termId) => {
                const row = form[termId] || {};
                const dirty = isTermDirty(termId);
                const isUnsaved = !persisted[termId];
                const rowErrors = dirty ? validateTermRow(row) : [];
                return (
                  <div
                    key={termId}
                    style={{
                      padding: 10,
                      borderRadius: 8,
                      background: dirty ? MF.status.warningBg : MF.surface.page,
                      border: `1px solid ${dirty ? MF.status.warningBorder : MF.line.hairline}`
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: MF.ink.primary }}>
                        {formatTermId(termId)}
                        {isUnsaved ? <span style={{ fontWeight: 500, color: MF.status.warningText }}> (unsaved)</span> : null}
                      </div>
                      {isUnsaved ? (
                        <button
                          type="button"
                          className="mf-shell-tab"
                          onClick={() => handleRemoveUnsavedTerm(termId)}
                          style={{ fontSize: 12, color: MF.ink.secondary, textDecoration: 'underline', padding: 0, '--mf-focus-color': MF.util.base }}
                        >
                          Remove
                        </button>
                      ) : null}
                    </div>

                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
                      <label style={fieldLabelStyle}>
                        Start date
                        <input type="date" value={row.startDate || ''} onChange={(e) => handleFieldChange(termId, 'startDate', e.target.value)} style={fieldInputStyle} />
                      </label>
                      <label style={fieldLabelStyle}>
                        End date
                        <input type="date" value={row.endDate || ''} onChange={(e) => handleFieldChange(termId, 'endDate', e.target.value)} style={fieldInputStyle} />
                      </label>
                      <label style={fieldLabelStyle}>
                        Standard weekly hours
                        <input
                          type="number"
                          min="0"
                          step="0.5"
                          value={row.standardWeeklyHours || ''}
                          onChange={(e) => handleFieldChange(termId, 'standardWeeklyHours', e.target.value)}
                          style={fieldInputStyle}
                        />
                      </label>
                    </div>

                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8, fontSize: 12, color: MF.ink.secondary }}>
                      <input
                        type="checkbox"
                        checked={Boolean(row.isHistorical)}
                        onChange={(e) => handleFieldChange(termId, 'isHistorical', e.target.checked)}
                      />
                      Historical (a past term, not current or upcoming)
                    </label>

                    {rowErrors.length ? <div style={{ ...errorStyle, marginTop: 6 }}>{rowErrors.join('; ')}</div> : null}
                  </div>
                );
              })}
            </div>
          )}

          <div style={{ marginTop: 12, padding: 10, borderRadius: 8, border: `1px solid ${MF.line.hairline}`, background: MF.surface.page }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: MF.ink.primary, marginBottom: 8 }}>Add a term</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              <input
                type="number"
                aria-label="Year"
                placeholder="Year"
                value={newTermInputs.academicYear}
                onChange={(e) => setNewTermInputs((prev) => ({ ...prev, academicYear: e.target.value }))}
                style={{ ...mfInputStyle, flex: '0 1 90px', minWidth: 80 }}
              />
              <input
                type="text"
                aria-label="Term"
                placeholder="Term (e.g. Fall)"
                value={newTermInputs.term}
                onChange={(e) => setNewTermInputs((prev) => ({ ...prev, term: e.target.value }))}
                style={{ ...mfInputStyle, flex: '1 1 140px', minWidth: 120 }}
              />
              <input
                type="number"
                aria-label="Block number"
                placeholder="Block #"
                value={newTermInputs.sessionNumber}
                onChange={(e) => setNewTermInputs((prev) => ({ ...prev, sessionNumber: e.target.value }))}
                style={{ ...mfInputStyle, flex: '0 1 90px', minWidth: 80 }}
              />
              <button
                type="button"
                className="mf-shell-button"
                onClick={handleAddTerm}
                style={{ ...mfSecondaryButtonStyle, '--mf-focus-color': MF.util.base }}
              >
                Add
              </button>
            </div>
            {addError ? <div style={{ ...errorStyle, marginTop: 6 }}>{addError}</div> : null}
          </div>
        </>
      )}
    </ChartCard>
  );
}

// --- Data quality -------------------------------------------------------------------
function DataQualityCard({ results }) {
  const unmatched = unmatchedMeetingRows(results);
  const noCapacity = unknownCapacityRooms(results);
  const listStyle = { margin: '6px 0 0', paddingLeft: 18, maxHeight: 220, overflowY: 'auto', fontSize: 12, color: MF.ink.primary, lineHeight: 1.5 };

  return (
    <ChartCard title="Data quality" autoHeight>
      {() => (
        <>
          <div style={{ fontSize: 12, fontWeight: 600, color: MF.ink.primary }}>
            Meetings not matched to a term ({unmatched.length})
          </div>
          {unmatched.length ? (
            <>
              <div style={mutedStyle}>Left out of every result until a matching term is added in the Terms card.</div>
              <ul style={listStyle}>
                {unmatched.map((m) => (
                  <li key={m.key}>
                    {m.course} · {m.place} · “{m.scheduleLabel}” — <span style={{ color: MF.ink.secondary }}>{m.reason}</span>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <div style={mutedStyle}>Every imported meeting matches a term.</div>
          )}

          <div style={{ fontSize: 12, fontWeight: 600, color: MF.ink.primary, marginTop: 14 }}>
            Classrooms with no seat count ({noCapacity.length})
          </div>
          {results?.capacityFetchFailed ? (
            <div style={errorStyle}>Seat counts couldn’t be loaded from Airtable — click Recalculate to try again.</div>
          ) : null}
          {noCapacity.length ? (
            <>
              <div style={mutedStyle}>Shown as “—” for capacity and left out of seat utilization.</div>
              <ul style={listStyle}>
                {noCapacity.map((name) => <li key={name}>{name}</li>)}
              </ul>
            </>
          ) : (
            <div style={mutedStyle}>Every scheduled classroom has a seat count.</div>
          )}
        </>
      )}
    </ChartCard>
  );
}

export default function ClassroomUtilizationSetupTab({ data }) {
  return (
    <MfGrid>
      <MfCol span={5}>
        <ScheduleCard data={data} />
      </MfCol>
      <MfCol span={7}>
        <DataQualityCard results={data.results} />
      </MfCol>
      <MfCol span={12}>
        <TermsCard data={data} />
      </MfCol>
    </MfGrid>
  );
}
