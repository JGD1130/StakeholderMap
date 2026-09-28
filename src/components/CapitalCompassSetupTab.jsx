// src/components/CapitalCompassSetupTab.jsx
//
// Setup tab of the Capital Compass workspace -- the admin tools that used to
// live in the side panel:
//   - Score a building: building picker, the 7 criteria (with the two
//     suggestion chips), notes, live total + tier, Save Score.
//   - Capital phasing upload / Deferred maintenance upload: pick a workbook,
//     review the preview, Confirm & Save behind a confirm dialog. Saving
//     replaces every saved project/building (the hook clears, then writes);
//     reload() runs afterwards whether it succeeded or failed.
//   - Data quality: standing issues in the saved data.
// Every read and write goes through the shared useCapitalCompassData hook;
// rules come from capitalCompassCalc.js. Warnings and parse issues all use
// one style (MF.status.warning*).
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MF } from '../theme/mfTokens';
import { WorkspaceShell, MfGrid, MfCol, ChartCard } from './mf';
import { mfPrimaryButtonStyle, mfSecondaryButtonStyle, mfInputStyle, mfTableHeaderCell, mfTableBodyCell } from './mf/mfStyles';
import {
  SCORE_FIELDS,
  getTier,
  sanitizeBuildingDocId,
  suggestFinancialDelayCost,
  suggestCriticalCoreService,
  formatUsdCompact
} from '../utils/capitalCompassCalc';
import { parseCapitalPhasingFile, toCapitalPhasingDocs, formatCapitalPhasingMonthYear } from '../utils/capitalPhasingImport';
import { parseDeferredMaintenanceFile, toDeferredMaintenanceDocs } from '../utils/deferredMaintenanceImport';
import { tierColor, TIER_SHORT_HORIZON, plainIssue, dataQualityItems, formatUsdFull } from './capitalCompassView';

const textStyle = { fontSize: 12, color: MF.ink.secondary, lineHeight: 1.45 };
const mutedStyle = { fontSize: 12, color: MF.ink.muted, lineHeight: 1.45 };
const errorStyle = { fontSize: 12, color: MF.status.error, lineHeight: 1.45 };
const warningBox = {
  padding: '8px 10px',
  borderRadius: 6,
  fontSize: 12,
  lineHeight: 1.45,
  background: MF.status.warningBg,
  border: `1px solid ${MF.status.warningBorder}`,
  color: MF.status.warningText
};
const focusVar = { '--mf-focus-color': MF.util.base };

function disabledStyle(disabled) {
  return disabled ? { opacity: 0.55, cursor: 'default' } : null;
}

function PrimaryButton({ onClick, disabled, children }) {
  return (
    <button type="button" className="mf-shell-button" onClick={onClick} disabled={disabled} style={{ ...mfPrimaryButtonStyle, ...focusVar, ...disabledStyle(disabled) }}>
      {children}
    </button>
  );
}

function WarningList({ title, items }) {
  if (!items.length) return null;
  return (
    <div style={{ ...warningBox, marginTop: 8 }}>
      {title ? <div style={{ fontWeight: 600, marginBottom: 4 }}>{title}</div> : null}
      <ul style={{ margin: 0, paddingLeft: 18, maxHeight: 200, overflowY: 'auto' }}>
        {items.map((text, i) => <li key={i}>{text}</li>)}
      </ul>
    </div>
  );
}

function ConfirmDialog({ title, message, confirmLabel, onCancel, onConfirm }) {
  return (
    <WorkspaceShell size="dialog" title={title} onClose={onCancel}>
      <div style={{ fontSize: 13, color: MF.ink.primary, lineHeight: 1.5 }}>{message}</div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 20 }}>
        <button type="button" className="mf-shell-button" style={{ ...mfSecondaryButtonStyle, ...focusVar }} onClick={onCancel}>Cancel</button>
        <button type="button" className="mf-shell-button" style={{ ...mfPrimaryButtonStyle, ...focusVar }} onClick={onConfirm}>{confirmLabel}</button>
      </div>
    </WorkspaceShell>
  );
}

// --- Score a building -------------------------------------------------------------------
function emptyScores() {
  return Object.fromEntries(SCORE_FIELDS.map((f) => [f.key, null]));
}

function ScoreCard({ data, buildingNames, getBuildingResourceEntry }) {
  const [buildingName, setBuildingName] = useState('');
  const [scores, setScores] = useState(emptyScores);
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  // Pre-fill from the saved score when the selection changes -- not on every
  // data refresh, so unsaved edits survive a budget or cost change elsewhere.
  const buildingsRef = useRef(data.buildings);
  buildingsRef.current = data.buildings;
  const dataReady = data.status === 'ready';
  useEffect(() => {
    setMessage('');
    setError('');
    const saved = buildingName
      ? buildingsRef.current.find((b) => b.docId === sanitizeBuildingDocId(buildingName))
      : null;
    setScores(saved ? { ...emptyScores(), ...saved.scores } : emptyScores());
    setNotes(saved?.notes || '');
  }, [buildingName, dataReady]);

  const resourceEntry = useMemo(
    () => (buildingName && typeof getBuildingResourceEntry === 'function' ? getBuildingResourceEntry(buildingName) : null),
    [buildingName, getBuildingResourceEntry]
  );
  const suggestions = useMemo(() => {
    if (!buildingName) return {};
    const lifeSafety = Number(resourceEntry?.conditionAssessment?.architecture?.lifeSafety);
    const avg = Number(resourceEntry?.conditionAssessment?.averageScore);
    return {
      financialDelayCost: suggestFinancialDelayCost(data.costFor(buildingName), resourceEntry?.deferredMaintenance?.priority || ''),
      criticalCoreService: suggestCriticalCoreService(Number.isFinite(lifeSafety) ? lifeSafety : null, Number.isFinite(avg) ? avg : null)
    };
  }, [buildingName, resourceEntry, data]);

  const allScored = SCORE_FIELDS.every((f) => typeof scores[f.key] === 'number');
  const total = SCORE_FIELDS.reduce((sum, f) => sum + (Number(scores[f.key]) || 0), 0);
  const tier = allScored ? getTier(total) : null;

  const setScore = (key, value) => setScores((prev) => ({ ...prev, [key]: value === '' || value == null ? null : Number(value) }));

  const handleSave = useCallback(async () => {
    if (!buildingName || saving) return;
    setSaving(true);
    setMessage('');
    setError('');
    try {
      await data.saveScore(buildingName, { scores, notes });
      setMessage(`Saved ${buildingName}.`);
    } catch (err) {
      console.error('Capital Compass: score save failed.', err);
      setError('Couldn’t save the score — try again.');
    } finally {
      setSaving(false);
    }
  }, [buildingName, saving, data, scores, notes]);

  return (
    <ChartCard
      title="Score a building"
      subtitle="Pick a level for each of the 7 criteria. The total sets the tier."
      actions={<PrimaryButton onClick={() => void handleSave()} disabled={!buildingName || saving}>{saving ? 'Saving…' : 'Save Score'}</PrimaryButton>}
      autoHeight
    >
      {() => (
        <>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 16 }}>
            <select aria-label="Building" value={buildingName} onChange={(e) => setBuildingName(e.target.value)} style={{ ...mfInputStyle, minWidth: 260 }}>
              <option value="">Select a building…</option>
              {buildingNames.map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
            {buildingName ? (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13, color: MF.ink.primary }}>
                <strong style={{ fontVariantNumeric: 'tabular-nums' }}>{total} / 100</strong>
                {tier ? (
                  <>
                    <span aria-hidden="true" style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 2, background: tierColor(tier.level) }} />
                    <span>Tier {tier.level} · {TIER_SHORT_HORIZON[tier.level]}</span>
                  </>
                ) : <span style={mutedStyle}>Score all 7 criteria to see the tier</span>}
              </span>
            ) : null}
          </div>
          {tier ? <div style={{ ...mutedStyle, marginTop: 4 }}>{tier.action}</div> : null}

          {buildingName ? (
            <>
              <div style={{ overflowX: 'auto', marginTop: 12 }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', background: MF.surface.page, fontFamily: MF.type.family }}>
                  <thead>
                    <tr>
                      <th style={mfTableHeaderCell}>Criterion</th>
                      <th style={{ ...mfTableHeaderCell, textAlign: 'right', width: 56 }}>Max</th>
                      <th style={{ ...mfTableHeaderCell, width: '52%' }}>Level</th>
                    </tr>
                  </thead>
                  <tbody>
                    {SCORE_FIELDS.map((f) => {
                      const level = f.levels.find((l) => l.score === scores[f.key]);
                      const suggestion = suggestions[f.key];
                      return (
                        <tr key={f.key}>
                          <td style={{ ...mfTableBodyCell, verticalAlign: 'top' }}>
                            <div style={{ fontWeight: 600 }}>{f.label}</div>
                            <div style={{ fontSize: 11, color: MF.ink.muted }}>{f.fullName}</div>
                          </td>
                          <td style={{ ...mfTableBodyCell, verticalAlign: 'top', textAlign: 'right', color: MF.ink.muted }}>{f.max}</td>
                          <td style={{ ...mfTableBodyCell, verticalAlign: 'top' }}>
                            <select
                              aria-label={f.label}
                              value={scores[f.key] ?? ''}
                              onChange={(e) => setScore(f.key, e.target.value)}
                              style={{ ...mfInputStyle, width: '100%' }}
                            >
                              <option value="">Not scored</option>
                              {f.levels.map((l) => <option key={l.score} value={l.score}>{l.score} — {l.label}</option>)}
                            </select>
                            {level ? <div style={{ ...mutedStyle, marginTop: 4 }}>{level.desc}</div> : null}
                            {suggestion ? (
                              <div style={{ marginTop: 6, padding: '6px 8px', borderRadius: 6, background: MF.surface.card, border: `1px solid ${MF.line.border}`, fontSize: 12, color: MF.ink.primary, lineHeight: 1.45 }}>
                                Suggested: <strong>{suggestion.score}/{f.max} ({suggestion.levelLabel})</strong> based on {suggestion.rationale}.{' '}
                                <button
                                  type="button"
                                  className="mf-shell-tab"
                                  onClick={() => setScore(f.key, suggestion.score)}
                                  style={{ padding: 0, fontSize: 12, fontWeight: 600, color: MF.ink.primary, textDecoration: 'underline', ...focusVar }}
                                >
                                  Apply
                                </button>
                              </div>
                            ) : null}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <label style={{ display: 'block', marginTop: 12, fontSize: 11, fontWeight: 600, color: MF.ink.muted }}>
                Notes (optional)
                <textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  rows={2}
                  style={{ ...mfInputStyle, display: 'block', width: '100%', marginTop: 4, resize: 'vertical' }}
                />
              </label>
            </>
          ) : null}
          {message ? <div style={{ ...textStyle, marginTop: 8 }}>{message}</div> : null}
          {error ? <div role="alert" style={{ ...errorStyle, marginTop: 8 }}>{error}</div> : null}
        </>
      )}
    </ChartCard>
  );
}

// --- Uploads ----------------------------------------------------------------------------
// Shared upload flow: pick a file -> parse -> preview -> Confirm & Save
// (confirm dialog) -> replace. `parse(file)` returns { docs, issues: [string],
// notes: [string], sheetName? }; `replace(docs, onPhase, preview)` returns
// { clearedCount }.
function UploadCard({ title, subtitle, savedCount, savedNoun, parse, replace, reload, renderPreview }) {
  const [parsing, setParsing] = useState(false);
  const [parseError, setParseError] = useState('');
  const [preview, setPreview] = useState(null); // { docs, issues, notes, fileName }
  const [phase, setPhase] = useState(null); // null | 'clearing' | 'writing'
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const handleFile = async (event) => {
    const file = event.target.files?.[0] || null;
    event.target.value = ''; // re-selecting the same file still re-parses
    if (!file) return;
    setParsing(true);
    setParseError('');
    setPreview(null);
    setMessage('');
    setError('');
    try {
      setPreview({ ...(await parse(file)), fileName: file.name });
    } catch (err) {
      console.error(`${title}: parse failed.`, err);
      setParseError(String(err?.message || 'Couldn’t read that workbook.').replace(/\s*--\s*/g, ' — '));
    } finally {
      setParsing(false);
    }
  };

  const handleSave = async () => {
    setConfirmOpen(false);
    if (!preview?.docs.length || phase) return;
    let current = 'clearing';
    setPhase(current);
    setMessage('');
    setError('');
    try {
      const { clearedCount } = await replace(preview.docs, (next) => { current = next; setPhase(next); }, preview);
      setMessage(`Saved ${preview.docs.length} ${savedNoun}${preview.docs.length === 1 ? '' : 's'} from “${preview.fileName}” (replacing ${clearedCount}).`);
      setPreview(null);
    } catch (err) {
      console.error(`${title}: save failed.`, err);
      setError(current === 'clearing'
        ? 'Save stopped while clearing the old data — nothing new was written. Try again.'
        : 'Save stopped while writing — the old data was already cleared, so save again.');
      void reload();
    } finally {
      setPhase(null);
    }
  };

  const busy = parsing || Boolean(phase);
  return (
    <ChartCard title={title} subtitle={subtitle} autoHeight>
      {() => (
        <>
          <div style={textStyle}>{savedCount ? `${savedCount} ${savedNoun}${savedCount === 1 ? '' : 's'} saved.` : `No ${savedNoun}s saved yet.`}</div>
          <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
            <input type="file" accept=".xlsx,.xls" aria-label={`${title} workbook`} onChange={(e) => void handleFile(e)} disabled={busy} style={{ fontSize: 12 }} />
            {parsing ? <span style={mutedStyle}>Reading the workbook…</span> : null}
          </div>
          <div style={{ ...mutedStyle, marginTop: 4 }}>Choosing a file only shows a preview. Nothing is saved until you confirm.</div>
          {parseError ? <div role="alert" style={{ ...errorStyle, marginTop: 8 }}>{parseError}</div> : null}

          {preview ? (
            <div style={{ marginTop: 10 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: MF.ink.primary }}>
                Preview of “{preview.fileName}”: {preview.docs.length} {savedNoun}{preview.docs.length === 1 ? '' : 's'}
              </div>
              <WarningList title={preview.issues.length ? `Couldn’t read ${preview.issues.length} ${preview.issues.length === 1 ? 'row' : 'rows'}` : ''} items={preview.issues} />
              <WarningList title="" items={preview.notes} />
              {preview.docs.length ? <div style={{ marginTop: 8 }}>{renderPreview(preview.docs)}</div> : null}
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 10 }}>
                <PrimaryButton onClick={() => setConfirmOpen(true)} disabled={!preview.docs.length || Boolean(phase)}>
                  {phase === 'clearing' ? 'Clearing old data…' : phase === 'writing' ? 'Saving…' : `Confirm & Save (${preview.docs.length})`}
                </PrimaryButton>
              </div>
            </div>
          ) : null}

          {message ? <div style={{ ...textStyle, marginTop: 8 }}>{message}</div> : null}
          {error ? <div role="alert" style={{ ...errorStyle, marginTop: 8 }}>{error}</div> : null}

          {confirmOpen ? (
            <ConfirmDialog
              title={title}
              message={`This replaces all ${savedCount} saved ${savedNoun}${savedCount === 1 ? '' : 's'}. Continue?`}
              confirmLabel="Replace"
              onCancel={() => setConfirmOpen(false)}
              onConfirm={() => void handleSave()}
            />
          ) : null}
        </>
      )}
    </ChartCard>
  );
}

function PreviewTable({ columns, rows }) {
  return (
    <div style={{ maxHeight: 260, overflow: 'auto', border: `1px solid ${MF.line.hairline}`, borderRadius: 6 }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', background: MF.surface.page, fontFamily: MF.type.family }}>
        <thead>
          <tr>{columns.map((c) => <th key={c.key} style={{ ...mfTableHeaderCell, textAlign: c.align || 'left' }}>{c.label}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              {columns.map((c) => <td key={c.key} style={{ ...mfTableBodyCell, textAlign: c.align || 'left', whiteSpace: c.align === 'right' ? 'nowrap' : undefined }}>{r[c.key]}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PhasingUploadCard({ data }) {
  const parse = async (file) => {
    const result = await parseCapitalPhasingFile(file);
    if (!result.projects.length && !result.issues.length) {
      throw new Error('No projects found. Each project needs a name and completion date, with phase rows and durations (e.g. “4 months”) beneath it.');
    }
    return { docs: toCapitalPhasingDocs(result), issues: result.issues.map(plainIssue), notes: [] };
  };
  return (
    <UploadCard
      title="Capital phasing upload"
      subtitle="The master plan phasing workbook: projects, completion dates, costs and phase durations."
      savedCount={data.phasingDocs.length}
      savedNoun="project"
      parse={parse}
      replace={data.replacePhasingProjects}
      reload={data.reload}
      renderPreview={(docs) => (
        <PreviewTable
          columns={[
            { key: 'name', label: 'Project' },
            { key: 'completion', label: 'Completion' },
            { key: 'cost', label: 'Cost (2026 $)', align: 'right' },
            { key: 'phases', label: 'Phases', align: 'right' }
          ]}
          rows={docs.map((p) => ({
            key: p.projectId,
            name: p.projectName,
            completion: formatCapitalPhasingMonthYear(p.completionDate) || '—',
            cost: formatUsdCompact(p.projectCost2026),
            phases: Array.isArray(p.phases) ? p.phases.length : 0
          }))}
        />
      )}
    />
  );
}

function DeferredUploadCard({ data, buildingNames }) {
  const parse = async (file) => {
    const result = await parseDeferredMaintenanceFile(file, buildingNames);
    if (!result.buildings.length && !result.issues.length && !result.excludedNoDataRows.length) {
      throw new Error('No buildings found. The summary sheet needs a building column plus project cost columns for 0–5 yr and 6–10 yr deferred maintenance.');
    }
    const docs = toDeferredMaintenanceDocs(result);
    const notes = [
      ...result.sheetWarnings.map((w) => String(w).replace(/\s*--\s*/g, ' — ')),
      ...result.excludedNoDataRows.map((r) => `“${r.rawName}” (workbook row ${r.excelRow}) has no costs yet, so it isn’t counted.`),
      ...docs
        .filter((d) => d.matchMethod === 'unmapped' || d.matchMethod === 'blank')
        .map((d) => `“${d.rawBuildingName}” doesn’t match a building on the map. Its costs still count in the totals.`)
    ];
    return { docs, issues: result.issues.map(plainIssue), notes, sheetName: result.sheetName };
  };
  return (
    <UploadCard
      title="Deferred maintenance upload"
      subtitle="The master plan cost estimate: 0–5 yr and 6–10 yr deferred maintenance, demolition and renovation by building."
      savedCount={data.deferredMaintenanceDocs.length}
      savedNoun="building"
      parse={parse}
      replace={(docs, onPhase, preview) => data.replaceDeferredMaintenance(docs, { sourceFileName: preview.fileName, sheetName: preview.sheetName }, onPhase)}
      reload={data.reload}
      renderPreview={(docs) => (
        <PreviewTable
          columns={[
            { key: 'name', label: 'Building' },
            { key: 'dm05', label: '0–5 yr', align: 'right' },
            { key: 'dm610', label: '6–10 yr', align: 'right' }
          ]}
          rows={docs.map((d) => ({
            key: d.docId,
            name: d.matchedBuildingId || d.rawBuildingName,
            dm05: formatUsdFull(d.deferredMaint0to5),
            dm610: formatUsdFull(d.deferredMaint6to10)
          }))}
        />
      )}
    />
  );
}

// --- Data quality ------------------------------------------------------------------------
function DataQualityCard({ data }) {
  const items = dataQualityItems(data);
  return (
    <ChartCard title="Data quality" autoHeight>
      {() => (items.length
        ? <WarningList title={`${items.length} ${items.length === 1 ? 'item needs' : 'items need'} attention`} items={items.map((i) => i.text)} />
        : <div style={textStyle}>No issues found in the saved scores, phasing or deferred maintenance.</div>)}
    </ChartCard>
  );
}

export default function CapitalCompassSetupTab({ data, buildingNames, getBuildingResourceEntry }) {
  return (
    <MfGrid>
      <MfCol span={12}>
        <ScoreCard data={data} buildingNames={buildingNames} getBuildingResourceEntry={getBuildingResourceEntry} />
      </MfCol>
      <MfCol span={6}>
        <PhasingUploadCard data={data} />
      </MfCol>
      <MfCol span={6}>
        <DeferredUploadCard data={data} buildingNames={buildingNames} />
      </MfCol>
      <MfCol span={12}>
        <DataQualityCard data={data} />
      </MfCol>
    </MfGrid>
  );
}
