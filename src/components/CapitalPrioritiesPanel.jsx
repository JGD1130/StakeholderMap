// src/components/CapitalPrioritiesPanel.jsx
//
// Capital Priorities module (Capital Compass integration, Option B).
// Reads building names from the tenant's existing `buildings` config
// (in-memory prop, no Firestore read, never modified) so a user can pick
// a building to score.
//
// All Capital Compass data -- scores (capitalPriorities), phasing
// (capitalPhasingProjects), uploaded deferred maintenance
// (deferredMaintenanceBuildings) and the saved budget (capitalCompassSettings)
// -- comes from useCapitalCompassData (mounted once in StakeholderMap.jsx,
// passed in as `capitalData`), which also owns every write. The rubric, tier
// thresholds, cost rule and score suggestions live in capitalCompassCalc.js;
// tiers are always computed live from each building's total.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CE_ORANGE_HEADER } from '../utils/brandColors';
import {
  SCORE_FIELDS,
  TIERS,
  getTier,
  sanitizeBuildingDocId,
  formatUsdCompact,
  COST_SOURCE_LABELS,
  suggestFinancialDelayCost,
  suggestCriticalCoreService,
  scoredBuildings,
  computeFundingLine
} from '../utils/capitalCompassCalc';
import {
  CAPITAL_PHASING_SHEET_NAME,
  parseCapitalPhasingFile,
  toCapitalPhasingDocs,
  computeCapitalPhasingSchedule,
  formatCapitalPhasingMonthYear
} from '../utils/capitalPhasingImport';
import {
  DEFERRED_MAINTENANCE_SHEET_NAME,
  parseDeferredMaintenanceFile,
  toDeferredMaintenanceDocs
} from '../utils/deferredMaintenanceImport';

// Shared module header color -- see src/utils/brandColors.js.
const CLARK_ENERSEN_ORANGE = CE_ORANGE_HEADER;

// Tier text colors in this panel (display only; thresholds live in
// capitalCompassCalc.js getTier).
const TIER_COLORS = { 1: '#15803d', 2: '#b45309', 3: '#b45309', 4: '#b42318' };

// A scored building (useCapitalCompassData `buildings` entry) in the shape
// the Portfolio Prioritizer JSX reads.
function toPortfolioRow(b) {
  return {
    buildingId: b.docId,
    originalId: b.name,
    total: b.total,
    resolvedCost: b.cost.amount,
    costSource: b.cost.source,
    tierLevel: b.tier.level,
    tierHorizon: b.tier.horizon,
    tierColor: TIER_COLORS[b.tier.level]
  };
}

function emptyScores() {
  return SCORE_FIELDS.reduce((acc, field) => ({ ...acc, [field.key]: null }), {});
}

function formatUpdatedAt(value) {
  try {
    if (value?.toDate) return value.toDate().toLocaleString();
    if (value) return new Date(value).toLocaleString();
  } catch {}
  return '';
}

// Small stat tile for the Portfolio summary dashboard. Presentational only.
function PortfolioStat({ label, value, color }) {
  return (
    <div style={{ border: '1px solid #e5e7eb', borderRadius: 6, padding: 6, background: '#f8fafc' }}>
      <div style={{ fontSize: 9.5, color: '#667085', textTransform: 'uppercase', letterSpacing: 0.3 }}>{label}</div>
      <div style={{ fontSize: 12.5, fontWeight: 700, color: color || '#1f2937', marginTop: 2 }}>{value}</div>
    </div>
  );
}

// Capital Phasing & Costs -- new section, added 2026-08-26. Lives inside
// Capital Priorities (this panel), NOT Classroom Utilization, per Clark's
// explicit decision: these are two separate master-plan-derived features
// that happen to both read Hastings master plan workbooks. Shows real
// project phasing/cost data from the master plan's Phasing_and_Costs.xlsx
// -- a chronological project-card list, not a full Gantt grid, per Clark's
// decision (a future enhancement, not this one).
//
// Same "parse -> preview -> review -> Confirm & Save" pattern as Enrollment
// Projections (ClassroomUtilizationPanel.jsx's EnrollmentProjectionsSection)
// and the same delete-then-write idempotency pattern as Import Schedule/
// Enrollment: re-uploading a newer version of the workbook always lands on
// exactly the new project set, never merge-accumulating stale projects a
// newer workbook version dropped.
//
// Saved projects come from the shared hook (already sorted by completion
// date); Confirm & Save replaces universities/{universityId}/
// capitalPhasingProjects through capitalData.replacePhasingProjects.
function CapitalPhasingSection({ capitalData }) {
  const [sectionOpen, setSectionOpen] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [parseError, setParseError] = useState('');
  const [parsedResult, setParsedResult] = useState(null); // { projects, issues, sheetName, sourceFileName }
  const [savePhase, setSavePhase] = useState(null); // null | 'clearing' | 'writing'
  const [saveMessage, setSaveMessage] = useState('');
  const [saveError, setSaveError] = useState('');
  const savedProjects = capitalData?.phasingDocs || [];
  const savedLoading = capitalData?.status === 'loading' || capitalData?.status === 'idle';
  const savedLoadError = capitalData?.status === 'error' ? capitalData.error : '';

  const previewDocs = useMemo(
    () => (parsedResult ? toCapitalPhasingDocs(parsedResult) : []),
    [parsedResult]
  );

  const handleFileSelected = useCallback(async (event) => {
    const file = event.target.files?.[0] || null;
    // Reset the input value immediately so re-selecting the SAME file name
    // still fires a change event and re-parses, same convention as
    // EnrollmentProjectionsSection.
    event.target.value = '';
    if (!file) return;

    setParsing(true);
    setParseError('');
    setParsedResult(null);
    setSaveMessage('');
    setSaveError('');
    try {
      const result = await parseCapitalPhasingFile(file);
      if (!result.projects.length && !result.issues.length) {
        throw new Error(
          'Parsed the workbook but found no recognizable project blocks. Check that the sheet still has '
          + 'project name in column B, completion date in column C, and phase rows with a duration '
          + '(e.g. "4 months") in column C beneath each project header.'
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
    if (savePhase || !previewDocs.length || !capitalData) return;
    // Delete-then-write (in the hook): always lands on exactly
    // len(previewDocs) docs; a failure while clearing stops before writing.
    let phase = 'clearing';
    setSavePhase(phase);
    setSaveMessage('');
    setSaveError('');
    try {
      const { clearedCount } = await capitalData.replacePhasingProjects(previewDocs, (next) => {
        phase = next;
        setSavePhase(next);
      });
      setSaveMessage(
        `Cleared ${clearedCount.toLocaleString()} old project${clearedCount === 1 ? '' : 's'}, `
        + `imported ${previewDocs.length.toLocaleString()} project${previewDocs.length === 1 ? '' : 's'} `
        + `from "${parsedResult?.sourceFileName || 'the uploaded file'}".`
      );
      // Clear the preview after a successful save -- requires a fresh file
      // selection before Save can be clicked again.
      setParsedResult(null);
    } catch (error) {
      const phaseLabel = phase === 'clearing'
        ? 'Failed while clearing old data (nothing new was written): '
        : 'Failed while writing new data (old data was already cleared): ';
      setSaveError(phaseLabel + String(error?.message || 'unknown error.'));
    } finally {
      setSavePhase(null);
    }
  }, [savePhase, previewDocs, capitalData, parsedResult]);

  const summaryLabel = previewDocs.length
    ? `Capital Phasing & Costs (previewing ${previewDocs.length} unsaved project${previewDocs.length === 1 ? '' : 's'})`
    : savedProjects.length
      ? `Capital Phasing & Costs (${savedProjects.length.toLocaleString()} project${savedProjects.length === 1 ? '' : 's'} saved)`
      : 'Capital Phasing & Costs';

  // Shared card renderer for both the "currently saved" list and the
  // unsaved preview -- same visual shape, different data source.
  const renderProjectCard = (project, key) => {
    const schedule = computeCapitalPhasingSchedule(project);
    return (
      <div key={key} style={{ border: '1px solid #e5e7eb', borderRadius: 6, padding: 8, background: '#f8fafc' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 12, fontWeight: 700, overflowWrap: 'anywhere' }}>{project.projectName}</div>
            <div style={{ fontSize: 10.5, color: '#667085' }}>
              Completion: {formatCapitalPhasingMonthYear(project.completionDate) || '—'}
            </div>
          </div>
          <div style={{ textAlign: 'right', flexShrink: 0, fontSize: 10.5 }}>
            <div>2026 cost: <strong>{formatUsdCompact(project.projectCost2026)}</strong></div>
            <div>Escalated: <strong>{formatUsdCompact(project.escalatedCost)}</strong></div>
          </div>
        </div>

        {schedule.length ? (
          <div style={{ marginTop: 6, display: 'grid', gap: 3 }}>
            {schedule.map((phase, idx) => (
              <div
                key={`${phase.name}-${idx}`}
                style={{
                  display: 'flex',
                  alignItems: 'baseline',
                  justifyContent: 'space-between',
                  gap: 8,
                  fontSize: 10.5,
                  padding: '3px 6px',
                  background: '#fff',
                  border: '1px solid #edf2f7',
                  borderRadius: 4
                }}
              >
                <span style={{ fontWeight: 600 }}>{phase.name}</span>
                <span style={{ color: '#667085' }}>
                  {formatCapitalPhasingMonthYear(phase.startDate)} – {formatCapitalPhasingMonthYear(phase.endDate)}
                  {' '}({phase.durationMonths} mo)
                </span>
              </div>
            ))}
          </div>
        ) : null}

        {Array.isArray(project.notes) && project.notes.length ? (
          <div style={{ marginTop: 6, fontSize: 10, color: '#465569', lineHeight: 1.4 }}>
            {project.notes.map((note, idx) => (
              <div key={idx}>• {note}</div>
            ))}
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <div style={{ marginTop: 10, borderTop: '1px solid #edf2f7', paddingTop: 8 }}>
      <details open={sectionOpen} onToggle={(event) => setSectionOpen(event.currentTarget.open)}>
        <summary style={{ fontWeight: 700, fontSize: 12.5, cursor: 'pointer', color: '#1d2939' }}>
          {summaryLabel}
        </summary>

        <div style={{ marginTop: 4, fontSize: 10.5, color: '#667085', lineHeight: 1.35 }}>
          Upload the master plan's Phasing & Costs workbook (sheet "{CAPITAL_PHASING_SHEET_NAME}"),
          one project per card, phases and dates computed backward from each project's completion date.
          Selecting a file only parses it and shows a preview below -- nothing is written until you review
          it and click Confirm & Save.
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

        {savedLoading && !savedProjects.length ? (
          <div style={{ marginTop: 8, fontSize: 11, color: '#667085' }}>Loading saved projects...</div>
        ) : savedProjects.length ? (
          <div style={{ marginTop: 10 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: '#344054', marginBottom: 4 }}>
              Currently saved ({savedProjects.length.toLocaleString()} project{savedProjects.length === 1 ? '' : 's'})
            </div>
            <div style={{ display: 'grid', gap: 6 }}>
              {savedProjects.map((project) => renderProjectCard(project, project.projectId))}
            </div>
          </div>
        ) : !savedLoading ? (
          <div style={{ marginTop: 8, fontSize: 11, color: '#667085' }}>No capital phasing projects saved yet.</div>
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
              {previewDocs.length} project{previewDocs.length === 1 ? '' : 's'} parsed.
              {parsedResult.issues.length ? ` ${parsedResult.issues.length} row${parsedResult.issues.length === 1 ? '' : 's'} flagged below -- review before saving.` : ''}
            </div>

            {/* Flagged rows -- same "flag visibly, never silently drop" philosophy
                as every other suggestion/import path in this codebase. Shown even
                when there are also valid projects, since a flagged project is
                simply excluded from previewDocs rather than guessed at. */}
            {parsedResult.issues.length ? (
              <div
                style={{
                  marginTop: 8,
                  padding: '8px 10px',
                  borderRadius: 6,
                  fontSize: 11,
                  background: '#fffbeb',
                  border: '1px solid #fde68a',
                  color: '#7c4a03'
                }}
              >
                <strong>Could not parse ({parsedResult.issues.length}):</strong>
                <div style={{ marginTop: 4, display: 'grid', gap: 3 }}>
                  {parsedResult.issues.map((issue, idx) => (
                    <div key={idx}>
                      Row {issue.excelRow} ("{issue.rawName}") — {issue.reason}
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            {previewDocs.length ? (
              <div style={{ marginTop: 8, display: 'grid', gap: 6 }}>
                {previewDocs.map((project) => renderProjectCard(project, project.projectId))}
              </div>
            ) : null}

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

// Deferred Maintenance -- new section, lives inside Capital Priorities
// alongside Capital Phasing & Costs (same reasoning as that section: both
// are building/capital-project data drawn from master-plan workbooks, not
// classroom data). Real per-building deferred maintenance dollar figures
// from HC_MP_-_Cost_Estimate_Backup.xlsx's "Summary (Revised)" sheet. Same
// "parse -> preview -> review -> Confirm & Save" pattern and the same
// delete-then-write idempotency as Capital Phasing/Enrollment: re-uploading
// a newer workbook version always lands on exactly the new building set.
//
// 0-5yr and 6-10yr deferred maintenance are stored and displayed as
// distinct figures, never summed into one stored number, matching the
// source file's own structure -- callers wanting a combined view compute
// it at display time only.
//
// Building names in the source sheet don't always match the real GeoJSON
// building names used everywhere else in Capital Priorities -- resolved via
// the confirmed crosswalk in deferredMaintenanceImport.js. Any building the
// crosswalk can't resolve (e.g. Jack Osborne Track Complex, which has real
// cost data but no corresponding building footprint) is still imported and
// still counted in the campus totals below, but flagged visibly as
// "No mapped location" rather than being silently dropped.
//
// Saved buildings come from the shared hook; Confirm & Save replaces
// universities/{universityId}/deferredMaintenanceBuildings through
// capitalData.replaceDeferredMaintenance -- a collection separate from
// capitalPriorities (the hand-scored prioritization matrix) with its own
// doc-id scheme (some ids are "unmapped__..." rather than a real building
// id). A mapped building's 0-5 yr project cost is now the second step of
// the cost rule (capitalCompassCalc.js resolveBuildingCost).
function formatUsdFull(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return `$${Math.round(n).toLocaleString()}`;
}

function DeferredMaintenanceSection({ capitalData, realBuildingNames }) {
  const [sectionOpen, setSectionOpen] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [parseError, setParseError] = useState('');
  const [parsedResult, setParsedResult] = useState(null); // { buildings, issues, sheetWarnings, sheetName, sourceFileName }
  const [savePhase, setSavePhase] = useState(null); // null | 'clearing' | 'writing'
  const [saveMessage, setSaveMessage] = useState('');
  const [saveError, setSaveError] = useState('');
  const savedBuildings = capitalData?.deferredMaintenanceDocs || [];
  const savedLoading = capitalData?.status === 'loading' || capitalData?.status === 'idle';
  const savedLoadError = capitalData?.status === 'error' ? capitalData.error : '';

  const previewDocs = useMemo(
    () => (parsedResult ? toDeferredMaintenanceDocs(parsedResult) : []),
    [parsedResult]
  );

  const handleFileSelected = useCallback(async (event) => {
    const file = event.target.files?.[0] || null;
    // Reset the input value immediately so re-selecting the SAME file name
    // still fires a change event and re-parses, same convention as
    // CapitalPhasingSection.
    event.target.value = '';
    if (!file) return;

    setParsing(true);
    setParseError('');
    setParsedResult(null);
    setSaveMessage('');
    setSaveError('');
    try {
      const result = await parseDeferredMaintenanceFile(file, realBuildingNames);
      if (!result.buildings.length && !result.issues.length && !result.excludedNoDataRows.length) {
        throw new Error(
          'Parsed the workbook but found no recognizable building rows. Check that the sheet still has '
          + 'a "Summary (Revised)" two-row header (a row with "EXISTING BUILDING" plus "Project Cost"/'
          + '"Construction Cost"/"Const. Cost/SF" columns, with a Demolition/0-5yr/6-10yr/Renovation '
          + 'category row directly above it).'
        );
      }
      setParsedResult(result);
    } catch (error) {
      setParseError(String(error?.message || 'Failed to parse workbook.'));
    } finally {
      setParsing(false);
    }
  }, [realBuildingNames]);

  const handleSave = useCallback(async () => {
    if (savePhase || !previewDocs.length || !capitalData) return;
    // Delete-then-write (in the hook): always lands on exactly
    // len(previewDocs) docs; a failure while clearing stops before writing.
    let phase = 'clearing';
    setSavePhase(phase);
    setSaveMessage('');
    setSaveError('');
    try {
      const { clearedCount } = await capitalData.replaceDeferredMaintenance(
        previewDocs,
        { sourceFileName: parsedResult?.sourceFileName, sheetName: parsedResult?.sheetName },
        (next) => { phase = next; setSavePhase(next); }
      );
      setSaveMessage(
        `Cleared ${clearedCount.toLocaleString()} old building record${clearedCount === 1 ? '' : 's'}, `
        + `imported ${previewDocs.length.toLocaleString()} building record${previewDocs.length === 1 ? '' : 's'} `
        + `from "${parsedResult?.sourceFileName || 'the uploaded file'}".`
      );
      // Clear the preview after a successful save -- requires a fresh file
      // selection before Save can be clicked again.
      setParsedResult(null);
    } catch (error) {
      const phaseLabel = phase === 'clearing'
        ? 'Failed while clearing old data (nothing new was written): '
        : 'Failed while writing new data (old data was already cleared): ';
      setSaveError(phaseLabel + String(error?.message || 'unknown error.'));
    } finally {
      setSavePhase(null);
    }
  }, [savePhase, previewDocs, capitalData, parsedResult]);

  // Headline totals -- computed over whichever data set is currently being
  // displayed (preview takes priority while one exists, same convention as
  // the summary label below). 0-5yr and 6-10yr are kept as separate
  // headline numbers per the explicit "not summed" requirement; a combined
  // figure is shown alongside for convenience, clearly labeled as combined
  // rather than replacing the two distinct numbers.
  const activeBuildings = previewDocs.length ? previewDocs : savedBuildings;
  const totals = useMemo(() => {
    let total0to5 = 0;
    let total6to10 = 0;
    let unmappedCount = 0;
    activeBuildings.forEach((b) => {
      if (Number.isFinite(b.deferredMaint0to5)) total0to5 += b.deferredMaint0to5;
      if (Number.isFinite(b.deferredMaint6to10)) total6to10 += b.deferredMaint6to10;
      if (b.matchMethod === 'unmapped') unmappedCount += 1;
    });
    return { total0to5, total6to10, unmappedCount };
  }, [activeBuildings]);

  const summaryLabel = previewDocs.length
    ? `Deferred Maintenance (previewing ${previewDocs.length} unsaved building${previewDocs.length === 1 ? '' : 's'})`
    : savedBuildings.length
      ? `Deferred Maintenance (${savedBuildings.length.toLocaleString()} building${savedBuildings.length === 1 ? '' : 's'} saved)`
      : 'Deferred Maintenance';

  const renderBuildingCard = (b, key) => {
    const unmapped = b.matchMethod === 'unmapped' || b.matchMethod === 'blank';
    return (
      <div
        key={key}
        style={{
          border: unmapped ? '1px solid #fde68a' : '1px solid #e5e7eb',
          borderRadius: 6,
          padding: 8,
          background: unmapped ? '#fffbeb' : '#f8fafc'
        }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 12, fontWeight: 700, overflowWrap: 'anywhere' }}>{b.rawBuildingName}</div>
            {unmapped ? (
              <div style={{ fontSize: 10, fontWeight: 700, color: '#92400e', marginTop: 2 }}>
                ⚠ No mapped location — dollars still counted in campus totals below
              </div>
            ) : b.matchMethod === 'crosswalk' ? (
              <div style={{ fontSize: 10, color: '#667085', marginTop: 2 }}>
                Mapped via crosswalk → {b.matchedBuildingId}
              </div>
            ) : (
              <div style={{ fontSize: 10, color: '#667085', marginTop: 2 }}>
                {b.matchedBuildingId}
              </div>
            )}
          </div>
        </div>

        <div style={{ marginTop: 6, display: 'grid', gap: 3, fontSize: 10.5 }}>
          <div>
            0-5yr Deferred Maint. (Project Cost): <strong>{formatUsdFull(b.deferredMaint0to5)}</strong>
            <span style={{ color: '#94a3b8', fontSize: 9.5 }}> · Construction cost: {formatUsdFull(b.deferredMaint0to5ConstructionCost)}</span>
          </div>
          <div>
            6-10yr Deferred Maint. (Project Cost): <strong>{formatUsdFull(b.deferredMaint6to10)}</strong>
            <span style={{ color: '#94a3b8', fontSize: 9.5 }}> · Construction cost: {formatUsdFull(b.deferredMaint6to10ConstructionCost)}</span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4, marginTop: 2 }}>
            <div>Demolition Cost: <strong>{formatUsdFull(b.demolitionProjectCost)}</strong></div>
            <div>Renovation Cost: <strong>{formatUsdFull(b.renovationConstructionCost)}</strong></div>
            <div>Renovation $/SF: <strong>{formatUsdFull(b.renovationCostPerSf)}</strong></div>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div style={{ marginTop: 10, borderTop: '1px solid #edf2f7', paddingTop: 8 }}>
      <details open={sectionOpen} onToggle={(event) => setSectionOpen(event.currentTarget.open)}>
        <summary style={{ fontWeight: 700, fontSize: 12.5, cursor: 'pointer', color: '#1d2939' }}>
          {summaryLabel}
        </summary>

        <div style={{ marginTop: 4, fontSize: 10.5, color: '#667085', lineHeight: 1.35 }}>
          Upload the master plan's cost estimate workbook (sheet "{DEFERRED_MAINTENANCE_SHEET_NAME}"),
          one card per building, 0-5yr and 6-10yr deferred maintenance shown as distinct figures.
          Selecting a file only parses it and shows a preview below -- nothing is written until you
          review it and click Confirm & Save.
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

        {activeBuildings.length ? (
          <div style={{ marginTop: 10, display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 6 }}>
            <PortfolioStat label="Total 0-5yr Deferred Maint." value={formatUsdFull(totals.total0to5)} color="#b45309" />
            <PortfolioStat label="Total 6-10yr Deferred Maint." value={formatUsdFull(totals.total6to10)} color="#b45309" />
            <PortfolioStat label="Combined 0-10yr (for reference)" value={formatUsdFull(totals.total0to5 + totals.total6to10)} />
            <PortfolioStat label="No Mapped Location" value={totals.unmappedCount} color={totals.unmappedCount ? '#b42318' : undefined} />
          </div>
        ) : null}

        {savedLoading && !savedBuildings.length ? (
          <div style={{ marginTop: 8, fontSize: 11, color: '#667085' }}>Loading saved data...</div>
        ) : savedBuildings.length && !previewDocs.length ? (
          <div style={{ marginTop: 10 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: '#344054', marginBottom: 4 }}>
              Currently saved ({savedBuildings.length.toLocaleString()} building{savedBuildings.length === 1 ? '' : 's'})
            </div>
            <div style={{ display: 'grid', gap: 6 }}>
              {savedBuildings.map((b) => renderBuildingCard(b, b.docId))}
            </div>
          </div>
        ) : !savedLoading && !previewDocs.length ? (
          <div style={{ marginTop: 8, fontSize: 11, color: '#667085' }}>No deferred maintenance data saved yet.</div>
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
              {previewDocs.length} building{previewDocs.length === 1 ? '' : 's'} parsed.
              {parsedResult.issues.length ? ` ${parsedResult.issues.length} row${parsedResult.issues.length === 1 ? '' : 's'} flagged below -- review before saving.` : ''}
              {parsedResult.excludedNoDataRows.length ? ` ${parsedResult.excludedNoDataRows.length} row${parsedResult.excludedNoDataRows.length === 1 ? '' : 's'} excluded (no cost data yet) -- see below.` : ''}
            </div>

            {parsedResult.sheetWarnings.length ? (
              <div
                style={{
                  marginTop: 8,
                  padding: '8px 10px',
                  borderRadius: 6,
                  fontSize: 11,
                  background: '#fffbeb',
                  border: '1px solid #fde68a',
                  color: '#7c4a03'
                }}
              >
                <strong>Structure warning:</strong>
                <div style={{ marginTop: 4, display: 'grid', gap: 3 }}>
                  {parsedResult.sheetWarnings.map((w, idx) => <div key={idx}>{w}</div>)}
                </div>
              </div>
            ) : null}

            {/* Legitimate building name, every cost cell genuinely blank
                (not $0) -- an un-costed future line item, not a building
                with a real deferred-maintenance profile. Excluded from the
                parsed building set and totals, but shown here rather than
                silently dropped. */}
            {parsedResult.excludedNoDataRows.length ? (
              <div
                style={{
                  marginTop: 8,
                  padding: '8px 10px',
                  borderRadius: 6,
                  fontSize: 11,
                  background: '#f8fafc',
                  border: '1px solid #e5e7eb',
                  color: '#475569'
                }}
              >
                <strong>Excluded -- no cost data yet ({parsedResult.excludedNoDataRows.length}):</strong>
                <div style={{ marginTop: 4, display: 'grid', gap: 3 }}>
                  {parsedResult.excludedNoDataRows.map((row, idx) => (
                    <div key={idx}>Row {row.excelRow} ("{row.rawName}") — no cost figures on this row; not counted as a building.</div>
                  ))}
                </div>
              </div>
            ) : null}

            {/* Flagged rows -- same "flag visibly, never silently drop"
                philosophy as every other suggestion/import path in this
                codebase. */}
            {parsedResult.issues.length ? (
              <div
                style={{
                  marginTop: 8,
                  padding: '8px 10px',
                  borderRadius: 6,
                  fontSize: 11,
                  background: '#fef2f2',
                  border: '1px solid #fecaca',
                  color: '#991b1b'
                }}
              >
                <strong>Could not parse ({parsedResult.issues.length}):</strong>
                <div style={{ marginTop: 4, display: 'grid', gap: 3 }}>
                  {parsedResult.issues.map((issue, idx) => (
                    <div key={idx}>
                      {issue.excelRow ? `Row ${issue.excelRow}` : 'Sheet'} ("{issue.rawName}") — {issue.reason}
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            {previewDocs.length ? (
              <div style={{ marginTop: 8, display: 'grid', gap: 6 }}>
                {previewDocs.map((b) => renderBuildingCard(b, b.docId))}
              </div>
            ) : null}

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

export default function CapitalPrioritiesPanel({
  enabled = false,
  title = 'Capital Compass',
  buildingFeatures = [],
  getBuildingResourceEntry = null,
  // useCapitalCompassData's result (mounted once in StakeholderMap.jsx).
  capitalData = null
}) {
  // Collapsed by default -- this only gates the <details> disclosure below;
  // the shared hook loads regardless of open/collapsed state.
  const [panelOpen, setPanelOpen] = useState(false);
  const loading = capitalData?.status === 'loading' || capitalData?.status === 'idle';
  const dataReady = capitalData?.status === 'ready';
  const errorMessage = capitalData?.status === 'error' ? capitalData.error : '';
  const buildings = useMemo(() => capitalData?.buildings || [], [capitalData?.buildings]);
  const refreshRows = useCallback(() => capitalData?.reload?.(), [capitalData]);

  const [selectedBuildingId, setSelectedBuildingId] = useState('');
  const [scores, setScores] = useState(emptyScores);
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState('');
  const [saveError, setSaveError] = useState('');
  const loadingSelection = Boolean(selectedBuildingId) && !dataReady && !buildings.length;

  // Read-only: names come from the tenant's existing buildings config, never written back to it.
  const buildingOptions = useMemo(() => {
    const seen = new Set();
    const options = [];
    (Array.isArray(buildingFeatures) ? buildingFeatures : []).forEach((feature) => {
      const rawId = String(feature?.properties?.id || feature?.properties?.name || '').trim();
      if (!rawId || seen.has(rawId)) return;
      seen.add(rawId);
      options.push({ buildingId: rawId, docId: sanitizeBuildingDocId(rawId) });
    });
    return options.sort((a, b) => a.buildingId.localeCompare(b.buildingId));
  }, [buildingFeatures]);

  // Real building names only, for the Deferred Maintenance crosswalk match
  // (deferredMaintenanceImport.js) -- same source as buildingOptions above,
  // just the name strings without the docId pairing.
  const realBuildingNames = useMemo(
    () => buildingOptions.map((opt) => opt.buildingId),
    [buildingOptions]
  );

  // Read-only: same building-resources.json data the "Deferred + Condition" modal
  // renders from (condition scores and the deferred-maintenance priority label).
  const resourceEntry = useMemo(() => {
    if (typeof getBuildingResourceEntry !== 'function' || !selectedBuildingId) return null;
    return getBuildingResourceEntry(selectedBuildingId) || null;
  }, [getBuildingResourceEntry, selectedBuildingId]);

  // Financial Delay Cost suggestion uses the one cost rule (manual ->
  // uploaded 0-5 yr deferred maintenance -> building-resources.json).
  const financialDelayCostSuggestion = useMemo(() => {
    if (!selectedBuildingId || !capitalData?.costFor) return null;
    return suggestFinancialDelayCost(
      capitalData.costFor(selectedBuildingId),
      resourceEntry?.deferredMaintenance?.priority || ''
    );
  }, [capitalData, selectedBuildingId, resourceEntry]);

  const criticalCoreServiceSuggestion = useMemo(() => {
    const lifeSafety = Number(resourceEntry?.conditionAssessment?.architecture?.lifeSafety);
    const avg = Number(resourceEntry?.conditionAssessment?.averageScore);
    return suggestCriticalCoreService(
      Number.isFinite(lifeSafety) ? lifeSafety : null,
      Number.isFinite(avg) ? avg : null
    );
  }, [resourceEntry]);

  const SUGGESTIONS_BY_KEY = {
    financialDelayCost: financialDelayCostSuggestion,
    criticalCoreService: criticalCoreServiceSuggestion
  };

  // Pre-fill the form from the building's saved score. Runs when the
  // selection changes (or data first arrives) -- not on every data refresh,
  // so a manual-cost or budget change elsewhere never wipes unsaved edits.
  const buildingsRef = useRef(buildings);
  buildingsRef.current = buildings;
  useEffect(() => {
    setSaveMessage('');
    setSaveError('');
    const saved = selectedBuildingId
      ? buildingsRef.current.find((b) => b.docId === sanitizeBuildingDocId(selectedBuildingId))
      : null;
    setScores(saved ? { ...emptyScores(), ...saved.scores } : emptyScores());
    setNotes(saved?.notes || '');
  }, [selectedBuildingId, dataReady]);

  const allScored = SCORE_FIELDS.every((field) => typeof scores[field.key] === 'number');
  const total = SCORE_FIELDS.reduce((sum, field) => sum + (Number(scores[field.key]) || 0), 0);
  const currentTier = allScored ? getTier(total) : null;

  const handleScoreChange = useCallback((key, value) => {
    setScores((prev) => ({ ...prev, [key]: value === '' ? null : Number(value) }));
  }, []);

  const handleSave = useCallback(async () => {
    if (!enabled || !capitalData || !selectedBuildingId) return;
    setSaving(true);
    setSaveError('');
    setSaveMessage('');
    try {
      // Writes ONLY to universities/{universityId}/capitalPriorities/{docId}.
      await capitalData.saveScore(selectedBuildingId, { scores, notes });
      setSaveMessage('Saved.');
    } catch (error) {
      setSaveError(String(error?.message || 'Failed to save.'));
    } finally {
      setSaving(false);
    }
  }, [enabled, capitalData, selectedBuildingId, scores, notes]);

  // Every capitalPriorities doc, for the read-only "scored buildings" list.
  const rows = useMemo(() => buildings.map((b) => ({
    ...b.scores,
    buildingId: b.docId,
    originalId: b.name,
    total: b.total,
    tier: b.tier?.level ?? null,
    tierHorizon: b.tier?.horizon ?? '',
    notes: b.notes,
    updatedAt: b.updatedAt
  })), [buildings]);

  // Portfolio Prioritizer -- every fully scored building, highest total
  // first, with its live tier and its cost from the one cost rule.
  const portfolioRows = useMemo(() => scoredBuildings(buildings).map(toPortfolioRow), [buildings]);

  const totalKnownCost = capitalData?.knownCostTotal || 0;
  // Saved budget cap, or (nothing saved) the total known cost -- "everything
  // funded" -- which keeps following costs as they're filled in.
  const budgetCap = capitalData?.budgetCap ?? 0;
  const manualCosts = capitalData?.manualCosts || {};
  const handleBudgetCapChange = useCallback((value) => capitalData?.setBudgetCap(value), [capitalData]);
  const handleManualCostChange = useCallback(
    (buildingName, rawValue) => capitalData?.setManualCost(buildingName, rawValue),
    [capitalData]
  );

  const { fundedRows, deferredRows, needsCostRows } = useMemo(() => {
    const line = computeFundingLine(buildings, budgetCap);
    return {
      fundedRows: line.funded.map(toPortfolioRow),
      deferredRows: line.deferred.map(toPortfolioRow),
      needsCostRows: line.needsCost.map(toPortfolioRow)
    };
  }, [buildings, budgetCap]);

  const fundedIds = useMemo(() => new Set(fundedRows.map((r) => r.buildingId)), [fundedRows]);
  const deferredIds = useMemo(() => new Set(deferredRows.map((r) => r.buildingId)), [deferredRows]);
  const fundedCost = useMemo(() => fundedRows.reduce((sum, r) => sum + r.resolvedCost, 0), [fundedRows]);
  const deferredCost = useMemo(() => deferredRows.reduce((sum, r) => sum + r.resolvedCost, 0), [deferredRows]);

  const tierStats = useMemo(() => TIERS.map((tier) => {
    const inTier = portfolioRows.filter((r) => r.tierLevel === tier.level);
    const cost = inTier.reduce((sum, r) => sum + (Number.isFinite(r.resolvedCost) ? r.resolvedCost : 0), 0);
    const knownCostCount = inTier.filter((r) => r.resolvedCost != null).length;
    return { ...tier, color: TIER_COLORS[tier.level], count: inTier.length, cost, knownCostCount };
  }), [portfolioRows]);

  const budgetSliderMax = totalKnownCost > 0 ? totalKnownCost : 1;
  const budgetSliderStep = Math.max(1000, Math.round(budgetSliderMax / 500));

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
      {/* Collapsed by default -- same native <details>/<summary> disclosure
          pattern SpaceDashboardPanel's CollapsibleSection already uses
          elsewhere in this codebase (title text as the summary, everything
          else as children), replicated locally here since this file doesn't
          import from SpaceDashboardPanel.jsx. */}
      <details
        open={panelOpen}
        onToggle={(event) => setPanelOpen(event.currentTarget.open)}
      >
        {/* Shared module header orange (brandColors.js). The native
            disclosure triangle is hidden (.mf-module-summary in
            StakeholderMap.css) in favor of an explicit ▸/▾ caret. */}
        <summary className="mf-module-summary" style={{ fontWeight: 700, fontSize: 12.5, cursor: 'pointer', color: '#fff', background: CLARK_ENERSEN_ORANGE, padding: '6px 8px', borderRadius: 6 }}>
          <span aria-hidden="true" style={{ display: 'inline-block', width: 12, marginRight: 4 }}>{panelOpen ? '▾' : '▸'}</span>
          {title}
        </summary>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, marginTop: 6 }}>
        <button className="btn" type="button" onClick={() => void refreshRows()} disabled={loading}>
          {loading ? 'Refreshing...' : 'Refresh'}
        </button>
      </div>

      <div style={{ marginTop: 6, fontSize: 11, color: '#465569', lineHeight: 1.35 }}>
        Capital Compass-style capital prioritization. Scores are entered manually below and saved per building.
      </div>

      {errorMessage ? (
        <div style={{ marginTop: 6, fontSize: 11, color: '#b42318' }}>{errorMessage}</div>
      ) : null}

      {/* Scrollable body: scoring form + read-only summary */}
      <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', paddingRight: 3 }}>
      {/* Scoring form */}
      <div style={{ marginTop: 10, borderTop: '1px solid #edf2f7', paddingTop: 8 }}>
        <label style={{ display: 'block', fontSize: 10.5, fontWeight: 600, color: '#344054', marginBottom: 3 }}>
          Building
        </label>
        <select
          value={selectedBuildingId}
          onChange={(e) => setSelectedBuildingId(e.target.value)}
          style={{ width: '100%', fontSize: 11.5, padding: '4px 6px' }}
        >
          <option value="">Select a building…</option>
          {buildingOptions.map((opt) => (
            <option key={opt.docId} value={opt.buildingId}>{opt.buildingId}</option>
          ))}
        </select>

        {selectedBuildingId ? (
          <div style={{ marginTop: 8 }}>
            {loadingSelection ? (
              <div style={{ fontSize: 11, color: '#667085' }}>Loading…</div>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                  <thead>
                    <tr>
                      <th style={{ textAlign: 'left', padding: '3px 4px', borderBottom: '1px solid #e5e7eb' }}>Criterion</th>
                      <th style={{ textAlign: 'right', padding: '3px 4px', borderBottom: '1px solid #e5e7eb', width: 44 }}>Max</th>
                      <th style={{ textAlign: 'left', padding: '3px 4px', borderBottom: '1px solid #e5e7eb', width: '46%' }}>Score</th>
                    </tr>
                  </thead>
                  <tbody>
                    {SCORE_FIELDS.map((field) => {
                      const currentLevel = field.levels.find((lvl) => lvl.score === scores[field.key]);
                      const suggestion = SUGGESTIONS_BY_KEY[field.key] || null;
                      return (
                        <tr key={field.key}>
                          <td style={{ padding: '4px', verticalAlign: 'top' }}>
                            <div style={{ fontWeight: 600 }}>{field.label}</div>
                            <div style={{ color: '#667085', fontSize: 10 }}>{field.fullName}</div>
                          </td>
                          <td style={{ padding: '4px', textAlign: 'right', verticalAlign: 'top', color: '#667085' }}>
                            {field.max}
                          </td>
                          <td style={{ padding: '4px', verticalAlign: 'top' }}>
                            <select
                              value={scores[field.key] ?? ''}
                              onChange={(e) => handleScoreChange(field.key, e.target.value)}
                              style={{ width: '100%', fontSize: 11, padding: '3px 4px' }}
                            >
                              <option value="">Not scored</option>
                              {field.levels.map((lvl) => (
                                <option key={lvl.score} value={lvl.score}>
                                  {lvl.score} — {lvl.label}
                                </option>
                              ))}
                            </select>
                            {currentLevel ? (
                              <div style={{ color: '#667085', fontSize: 10, marginTop: 2 }}>{currentLevel.desc}</div>
                            ) : null}
                            {suggestion ? (
                              <div
                                style={{
                                  marginTop: 4,
                                  padding: '4px 6px',
                                  background: '#eff6ff',
                                  border: '1px solid #bfdbfe',
                                  borderRadius: 4,
                                  fontSize: 10,
                                  color: '#1e3a5f'
                                }}
                              >
                                <button
                                  type="button"
                                  onClick={() => handleScoreChange(field.key, suggestion.score)}
                                  style={{
                                    background: 'none',
                                    border: 'none',
                                    padding: 0,
                                    color: '#1d4ed8',
                                    fontWeight: 700,
                                    cursor: 'pointer',
                                    textDecoration: 'underline',
                                    fontSize: 10
                                  }}
                                >
                                  Suggested: {suggestion.score}/{field.max} ({suggestion.levelLabel})
                                </button>
                                {' '}based on {suggestion.rationale} — click to apply, then review before saving.
                              </div>
                            ) : null}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>

                <div style={{ marginTop: 8, padding: 8, background: '#f8fafc', border: '1px solid #e5e7eb', borderRadius: 6 }}>
                  <div style={{ fontSize: 11, color: '#465569' }}>
                    Total: <strong>{total}</strong> / 100
                  </div>
                  {currentTier ? (
                    <div style={{ marginTop: 4 }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: TIER_COLORS[currentTier.level] }}>
                        Tier {currentTier.level} — {currentTier.horizon}
                      </div>
                      <div style={{ fontSize: 10.5, color: '#667085', marginTop: 2 }}>{currentTier.action}</div>
                    </div>
                  ) : (
                    <div style={{ fontSize: 10.5, color: '#667085', marginTop: 4 }}>
                      Score all criteria to see priority tier.
                    </div>
                  )}
                </div>

                <label style={{ display: 'block', fontSize: 10.5, fontWeight: 600, color: '#344054', marginTop: 8, marginBottom: 3 }}>
                  Notes (optional)
                </label>
                <textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  rows={2}
                  style={{ width: '100%', fontSize: 11, padding: '4px 6px', resize: 'vertical' }}
                />

                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
                  <button className="btn" type="button" onClick={() => void handleSave()} disabled={saving}>
                    {saving ? 'Saving...' : 'Save Score'}
                  </button>
                  {saveMessage ? <span style={{ fontSize: 10.5, color: '#15803d' }}>{saveMessage}</span> : null}
                  {saveError ? <span style={{ fontSize: 10.5, color: '#b42318' }}>{saveError}</span> : null}
                </div>
              </div>
            )}
          </div>
        ) : null}
      </div>

      {/* Read-only summary of all scored buildings */}
      <div style={{ marginTop: 10, borderTop: '1px solid #edf2f7', paddingTop: 8 }}>
        {rows.length ? (
          <div style={{ display: 'grid', gap: 6 }}>
            {rows.map((row) => (
              <div key={row.buildingId} style={{ border: '1px solid #e5e7eb', borderRadius: 6, padding: 6, background: '#f8fafc' }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 11.5, fontWeight: 600, overflowWrap: 'anywhere' }}>{row.originalId || row.buildingId}</div>
                    {row.tier ? <div style={{ fontSize: 10.5, color: '#667085' }}>Tier {row.tier}{row.tierHorizon ? ` — ${row.tierHorizon}` : ''}</div> : null}
                  </div>
                  {row.updatedAt ? (
                    <div style={{ fontSize: 10.5, color: '#667085', textAlign: 'right' }}>
                      {formatUpdatedAt(row.updatedAt)}
                    </div>
                  ) : null}
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 4, fontSize: 11, marginTop: 4 }}>
                  {SCORE_FIELDS.map((field) => (
                    row[field.key] != null ? (
                      <React.Fragment key={field.key}>
                        <span>{field.label}</span>
                        <span>{row[field.key]} / {field.max}</span>
                      </React.Fragment>
                    ) : null
                  ))}
                  {row.total != null ? (
                    <React.Fragment>
                      <span style={{ fontWeight: 600 }}>Total</span>
                      <span style={{ fontWeight: 600 }}>{row.total} / 100</span>
                    </React.Fragment>
                  ) : null}
                </div>
                {row.notes ? (
                  <div style={{ marginTop: 4, fontSize: 11, color: '#465569' }}>{row.notes}</div>
                ) : null}
              </div>
            ))}
          </div>
        ) : (
          <div style={{ fontSize: 11, color: '#667085' }}>
            {loading ? 'Loading...' : 'No buildings scored yet.'}
          </div>
        )}
      </div>

      {/* Portfolio Prioritizer — all scored buildings together as a capital plan,
          costs from the one cost rule (capitalCompassCalc.js). The budget cap and
          manual cost entries are saved by the shared hook
          (capitalCompassSettings/budget, ~800ms after the last change). */}
      <div style={{ marginTop: 10, borderTop: '1px solid #edf2f7', paddingTop: 8 }}>
        <h4 style={{ margin: '0 0 4px', fontSize: 12.5 }}>Portfolio Prioritizer</h4>
        <div style={{ fontSize: 10.5, color: '#667085', marginBottom: 6, lineHeight: 1.35 }}>
          All scored buildings ranked by total score. Adjust the budget cap to see which
          projects are funded (highest scores first, cumulative cost) versus deferred.
        </div>

        {portfolioRows.length ? (
          <>
            <div style={{ padding: 8, background: '#f8fafc', border: '1px solid #e5e7eb', borderRadius: 6, marginBottom: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                <label style={{ fontSize: 10.5, fontWeight: 600, color: '#344054' }}>Budget Cap</label>
                <span style={{ fontSize: 11.5, fontWeight: 700 }}>{formatUsdCompact(budgetCap)}</span>
              </div>
              <input
                type="range"
                min={0}
                max={budgetSliderMax}
                step={budgetSliderStep}
                value={Math.min(budgetCap, budgetSliderMax)}
                onChange={(e) => handleBudgetCapChange(e.target.value)}
                disabled={totalKnownCost <= 0}
                style={{ width: '100%', marginTop: 4 }}
              />
              <input
                type="number"
                min={0}
                value={budgetCap}
                onChange={(e) => handleBudgetCapChange(e.target.value)}
                style={{ width: '100%', fontSize: 11, padding: '3px 6px', marginTop: 4 }}
              />
              {totalKnownCost <= 0 ? (
                <div style={{ fontSize: 10, color: '#b45309', marginTop: 4 }}>
                  No building costs yet — enter a manual cost below to enable the budget slider.
                </div>
              ) : null}
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 6, marginBottom: 8 }}>
              <PortfolioStat label="Buildings Scored" value={portfolioRows.length} />
              <PortfolioStat label="Needs Cost" value={needsCostRows.length} color={needsCostRows.length ? '#b45309' : undefined} />
              <PortfolioStat label="Funded" value={`${fundedRows.length} · ${formatUsdCompact(fundedCost)}`} color="#15803d" />
              <PortfolioStat label="Deferred" value={`${deferredRows.length} · ${formatUsdCompact(deferredCost)}`} color="#b42318" />
            </div>

            <div style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 10.5, fontWeight: 600, color: '#344054', marginBottom: 4 }}>Cost by Tier</div>
              <div style={{ display: 'grid', gap: 3 }}>
                {tierStats.map((tier) => (
                  <div
                    key={tier.level}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 8,
                      fontSize: 10.5,
                      padding: '3px 6px',
                      background: '#f8fafc',
                      border: '1px solid #e5e7eb',
                      borderRadius: 4
                    }}
                  >
                    <span style={{ color: tier.color, fontWeight: 600 }}>
                      Tier {tier.level} ({tier.range})
                    </span>
                    <span style={{ color: '#465569' }}>
                      {tier.count} building{tier.count === 1 ? '' : 's'}
                      {tier.count ? ` — ${formatUsdCompact(tier.cost)}` : ''}
                      {tier.count && tier.knownCostCount < tier.count ? ` (${tier.count - tier.knownCostCount} missing cost)` : ''}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            <div style={{ fontSize: 10.5, fontWeight: 600, color: '#344054', marginBottom: 4 }}>
              Funding Order
            </div>
            <div style={{ display: 'grid', gap: 6 }}>
              {portfolioRows.map((row) => {
                const status = fundedIds.has(row.buildingId)
                  ? 'funded'
                  : deferredIds.has(row.buildingId)
                    ? 'deferred'
                    : 'needsCost';
                const cardBackground = status === 'funded' ? '#f0fdf4' : status === 'deferred' ? '#fef2f2' : '#fffbeb';
                const statusLabel = status === 'funded' ? 'Funded' : status === 'deferred' ? 'Deferred' : 'Cost needed';
                const statusColor = status === 'funded' ? '#15803d' : status === 'deferred' ? '#b42318' : '#b45309';
                return (
                  <div
                    key={row.buildingId}
                    style={{ border: '1px solid #e5e7eb', borderRadius: 6, padding: 6, background: cardBackground }}
                  >
                    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 11.5, fontWeight: 600, overflowWrap: 'anywhere' }}>
                          {row.originalId || row.buildingId}
                        </div>
                        <div style={{ fontSize: 10, color: '#667085' }}>
                          Score {row.total}/100 · <span style={{ color: row.tierColor }}>Tier {row.tierLevel}</span>
                          {row.tierHorizon ? ` — ${row.tierHorizon}` : ''}
                        </div>
                      </div>
                      <div style={{ textAlign: 'right', flexShrink: 0 }}>
                        <div style={{ fontSize: 11.5, fontWeight: 700 }}>
                          {formatUsdCompact(row.resolvedCost)}
                        </div>
                        {row.costSource ? (
                          <div style={{ fontSize: 9.5, color: '#94a3b8' }}>
                            {row.costSource === 'manual' ? COST_SOURCE_LABELS.manual : `from ${COST_SOURCE_LABELS[row.costSource]}`}
                          </div>
                        ) : null}
                      </div>
                    </div>

                    {/* Manual entry for buildings with no cost data, or one already
                        entered (a manual cost overrides every other source). */}
                    {row.costSource === 'manual' || row.costSource == null ? (
                      <div style={{ marginTop: 4 }}>
                        <label style={{ fontSize: 10, color: '#667085' }}>Manual cost estimate ($)</label>
                        <input
                          type="number"
                          min={0}
                          value={manualCosts[row.originalId] ?? ''}
                          onChange={(e) => handleManualCostChange(row.originalId, e.target.value)}
                          placeholder="e.g. 1500000"
                          style={{ width: '100%', fontSize: 11, padding: '3px 6px', marginTop: 2 }}
                        />
                      </div>
                    ) : null}

                    <div style={{ marginTop: 4, fontSize: 10.5, fontWeight: 700, color: statusColor }}>
                      {statusLabel}
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        ) : (
          <div style={{ fontSize: 11, color: '#667085' }}>
            {loading ? 'Loading...' : 'Score at least one building above to build the portfolio view.'}
          </div>
        )}
      </div>

      <CapitalPhasingSection capitalData={capitalData} />
      <DeferredMaintenanceSection capitalData={capitalData} realBuildingNames={realBuildingNames} />
      </div>
      </details>
    </div>
  );
}
