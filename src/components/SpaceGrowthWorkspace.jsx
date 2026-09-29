// src/components/SpaceGrowthWorkspace.jsx
//
// The Space Growth workspace, on the shared mf/ components: a workspace-size
// WorkspaceShell (Recalculate in the title bar) with Overview, Departments,
// Enrollment and Setup tabs, and a target-year picker at the right end of the
// tab row (hidden on Setup). Setup (SpaceGrowthSetupTab.jsx) holds the admin
// tools; while any of its cards has unsaved edits, switching tabs or closing
// asks "Discard unsaved changes?" first.
//
// Pure presentation over the useSpaceGrowthData result (`data`, mounted once
// in StakeholderMap.jsx) -- no fetching here. The year picker is the hook's
// targetYear (the same one the panel's Space Growth / Right-Sizing section
// uses); the Executive Dashboard always reads the hook's 2036 results, so it
// never moves with this picker. Values, labels and orderings come from
// spaceGrowthView.js; signed values use MF.diverging only.
import React, { useCallback, useMemo, useState } from 'react';
import { MF } from '../theme/mfTokens';
import { WorkspaceShell, MfGrid, MfCol, KpiCard, ChartCard } from './mf';
import {
  mfOnBarButtonStyle,
  mfInputStyle,
  mfTableHeaderCell,
  mfTableBodyCell,
  mfPillStyle,
  mfPrimaryButtonStyle,
  mfSecondaryButtonStyle
} from './mf/mfStyles';
import { DivergingBars, DivergingLegend, LineChart } from './mf/charts';
import { formatSignedSf } from './executiveDashboardView';
import {
  WORKSPACE_TITLE,
  YEAR_OPTIONS,
  DASHBOARD_YEAR_NOTE,
  OVERRIDE_TAG,
  CATEGORY_FILTERS,
  workspaceSubtitle,
  overviewKpis,
  DIVISION_TITLE,
  divisionSubtitle,
  divisionRows,
  OFFICE_TITLE,
  OFFICE_SUBTITLE,
  OFFICE_NOTE,
  officeSummary,
  categoryChartTitle,
  categoryChartSubtitle,
  categoryDepartmentRows,
  overviewFootnote,
  departmentTableRows,
  departmentColumns,
  sortDepartmentRows,
  ENROLLMENT_TITLE,
  ENROLLMENT_SUBTITLE,
  ENROLLMENT_NOTE,
  ENROLLMENT_EMPTY,
  enrollmentSeries,
  formatHeadcount,
  enrollmentTableRows
} from './spaceGrowthView';
import SpaceGrowthSetupTab from './SpaceGrowthSetupTab.jsx';
import { usePresentationMode, presentationTabs } from './presentationMode';

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'departments', label: 'Departments' },
  { id: 'enrollment', label: 'Enrollment' },
  { id: 'setup', label: 'Setup' }
];

const emptyStyle = { fontSize: 12, color: MF.ink.muted };
const headerCell = mfTableHeaderCell;
const bodyCell = mfTableBodyCell;
const numCell = { ...bodyCell, textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' };

// --- Title bar / tab row controls ---------------------------------------------
function BarButton({ onClick, disabled, children }) {
  return (
    <button
      type="button"
      className="mf-shell-button"
      onClick={onClick}
      disabled={disabled}
      style={{ ...mfOnBarButtonStyle, ...(disabled ? { opacity: 0.55, cursor: 'default' } : null) }}
    >
      {children}
    </button>
  );
}

function YearPicker({ data }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <span style={{ fontSize: 11, color: MF.ink.muted }}>{DASHBOARD_YEAR_NOTE}</span>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, fontWeight: 600, color: MF.ink.muted }}>
        Year
        <select value={data.targetYear} onChange={(e) => data.setTargetYear(Number(e.target.value))} style={mfInputStyle}>
          {YEAR_OPTIONS.map((year) => <option key={year} value={year}>{year}</option>)}
        </select>
      </label>
    </div>
  );
}

// --- Overview -------------------------------------------------------------------
function GapBarsCard({ title, subtitle, rows, emptyMessage, ariaLabel, footnote }) {
  return (
    <ChartCard title={title} subtitle={subtitle} footnote={rows.length ? footnote : null} autoHeight>
      {({ width }) => (rows.length ? (
        <>
          <DivergingLegend />
          <DivergingBars width={width} rows={rows} formatValue={formatSignedSf} ariaLabel={ariaLabel} />
        </>
      ) : (
        <div style={emptyStyle}>{emptyMessage}</div>
      ))}
    </ChartCard>
  );
}

function OfficeCard({ data }) {
  const office = officeSummary(data);
  return (
    <ChartCard title={OFFICE_TITLE} subtitle={OFFICE_SUBTITLE} autoHeight>
      {() => (
        <div>
          <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
            <div>
              <div style={{ fontSize: 22, fontWeight: 600, color: MF.ink.primary }}>{office.sfLabel}</div>
              <div style={{ marginTop: 2, fontSize: 11, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', color: MF.ink.muted }}>Office SF</div>
            </div>
            <div>
              <div style={{ fontSize: 22, fontWeight: 600, color: MF.ink.primary }}>{office.roomsLabel}</div>
              <div style={{ marginTop: 2, fontSize: 11, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', color: MF.ink.muted }}>Tagged office rooms</div>
            </div>
          </div>
          <div style={{ marginTop: 12, fontSize: 12, lineHeight: 1.45, color: MF.ink.secondary }}>
            {office.hasOffice ? OFFICE_NOTE : `No FTE-based (office) space category is set up. ${OFFICE_NOTE}`}
          </div>
        </div>
      )}
    </ChartCard>
  );
}

function OverviewTab({ data }) {
  const divisions = useMemo(() => divisionRows(data), [data.results, data.targetYear]);
  const classroom = useMemo(() => categoryDepartmentRows(data, 'Classroom'), [data.results, data.targetYear]);
  const lab = useMemo(() => categoryDepartmentRows(data, 'Lab'), [data.results, data.targetYear]);

  return (
    <>
      <MfGrid>
        {overviewKpis(data).map(({ key, ...props }) => (
          <MfCol key={key} span={3}>
            <KpiCard {...props} />
          </MfCol>
        ))}

        <MfCol span={7}>
          <GapBarsCard
            title={DIVISION_TITLE}
            subtitle={divisionSubtitle(data)}
            rows={divisions}
            emptyMessage="No division-level gaps available."
            ariaLabel={divisionSubtitle(data)}
          />
        </MfCol>
        <MfCol span={5}>
          <OfficeCard data={data} />
        </MfCol>

        <MfCol span={6}>
          <GapBarsCard
            title={categoryChartTitle('Classroom')}
            subtitle={categoryChartSubtitle(data, 'Classroom')}
            rows={classroom}
            emptyMessage="No departments have tagged classrooms."
            ariaLabel={categoryChartTitle('Classroom')}
          />
        </MfCol>
        <MfCol span={6}>
          <GapBarsCard
            title={categoryChartTitle('Lab')}
            subtitle={categoryChartSubtitle(data, 'Lab')}
            rows={lab}
            emptyMessage="No departments have tagged labs."
            ariaLabel={categoryChartTitle('Lab')}
          />
        </MfCol>
      </MfGrid>
      <div style={{ marginTop: 12, fontSize: 11, lineHeight: 1.45, color: MF.ink.muted }}>{overviewFootnote(data)}</div>
    </>
  );
}

// --- Departments ----------------------------------------------------------------
// Small signed bar around a center line: clay left for a deficit, blue right
// for a surplus, scaled to the largest gap in the table.
function MiniDivergingBar({ value, maxAbs, width = 64 }) {
  const half = width / 2;
  const size = Number.isFinite(value) && maxAbs > 0 ? Math.max((Math.abs(value) / maxAbs) * half, value === 0 ? 0 : 1) : 0;
  const negative = value < 0;
  return (
    <span aria-hidden="true" style={{ position: 'relative', display: 'inline-block', width, height: 8, verticalAlign: 'middle' }}>
      {size > 0 ? (
        <span
          style={{
            position: 'absolute',
            top: 0,
            bottom: 0,
            left: negative ? half - size : half,
            width: size,
            background: negative ? MF.diverging.deficit : MF.diverging.surplus,
            borderRadius: negative ? '2px 0 0 2px' : '0 2px 2px 0'
          }}
        />
      ) : null}
      <span style={{ position: 'absolute', top: -2, bottom: -2, left: half, borderLeft: `1px solid ${MF.diverging.zero}` }} />
    </span>
  );
}

function SortHeader({ column, sort, onSort }) {
  const active = sort.key === column.key;
  const arrow = active ? (sort.direction === 'asc' ? ' ▲' : ' ▼') : '';
  return (
    <th
      style={{ ...headerCell, textAlign: column.numeric ? 'right' : 'left' }}
      aria-sort={active ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <button
        type="button"
        className="mf-shell-tab"
        onClick={() => onSort(column.key)}
        style={{
          padding: 0,
          font: 'inherit',
          letterSpacing: 'inherit',
          textTransform: 'inherit',
          color: active ? MF.ink.primary : 'inherit',
          '--mf-focus-color': MF.util.base
        }}
      >
        {column.label}{arrow}
      </button>
    </th>
  );
}

function DepartmentsTab({ data }) {
  const [category, setCategory] = useState('All');
  const [sort, setSort] = useState({ key: 'gap', direction: 'asc' });
  const allRows = useMemo(() => departmentTableRows(data), [data.results, data.raw.enrollmentProjections]);
  const rows = useMemo(() => {
    const filtered = category === 'All' ? allRows : allRows.filter((r) => r.category === category);
    return sortDepartmentRows(filtered, sort.key, sort.direction);
  }, [allRows, category, sort]);
  const maxAbs = Math.max(...rows.map((r) => (Number.isFinite(r.gap) ? Math.abs(r.gap) : 0)), 0);
  const columns = departmentColumns(data.targetYear);

  const onSort = (key) => setSort((prev) => (
    prev.key === key
      ? { key, direction: prev.direction === 'asc' ? 'desc' : 'asc' }
      // Gap starts at the largest deficit; other numbers at the largest value.
      : { key, direction: key === 'gap' || !columns.find((c) => c.key === key)?.numeric ? 'asc' : 'desc' }
  ));

  return (
    <ChartCard
      title="Department Gaps"
      subtitle={`Classroom and lab, current vs. ${data.targetYear} need · office space is not included`}
      actions={(
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, fontWeight: 600, color: MF.ink.muted }}>
          Category
          <select value={category} onChange={(e) => setCategory(e.target.value)} style={mfInputStyle}>
            {CATEGORY_FILTERS.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
      )}
      footnote={`Target: SF per student. "${OVERRIDE_TAG}" marks a target set for that department; the others use the category default.`}
      autoHeight
    >
      {() => (rows.length ? (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', background: MF.surface.page, fontFamily: MF.type.family }}>
            <thead>
              <tr>
                {columns.map((column) => <SortHeader key={column.key} column={column} sort={sort} onSort={onSort} />)}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key}>
                  <td style={{ ...bodyCell, fontWeight: 600 }}>{row.department}</td>
                  <td style={{ ...bodyCell, color: MF.ink.secondary }}>{row.division}</td>
                  <td style={bodyCell}>{row.category}</td>
                  <td style={numCell}>
                    {row.targetLabel}
                    {row.isOverride ? (
                      <div>
                        <span style={{ ...mfPillStyle, marginTop: 2, background: MF.surface.card, border: `1px solid ${MF.line.border}`, color: MF.ink.secondary }}>
                          {OVERRIDE_TAG}
                        </span>
                      </div>
                    ) : null}
                  </td>
                  <td style={numCell}>{row.headcountLabel}</td>
                  <td style={numCell}>{row.currentLabel}</td>
                  <td style={numCell}>{row.needLabel}</td>
                  <td style={numCell}>
                    <span style={{ marginRight: 8 }}>{row.gapLabel}</span>
                    <MiniDivergingBar value={row.gap} maxAbs={maxAbs} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div style={emptyStyle}>No departments have tagged {category === 'All' ? 'classrooms or labs' : `${category.toLowerCase()}s`}.</div>
      ))}
    </ChartCard>
  );
}

// --- Enrollment -----------------------------------------------------------------
function EnrollmentTab({ data }) {
  const series = useMemo(() => enrollmentSeries(data), [data.raw.enrollmentProjections]);
  const rows = useMemo(() => enrollmentTableRows(data), [data.raw.enrollmentProjections, data.targetYear]);
  const baseYear = data.baselineYear;

  return (
    <MfGrid>
      <MfCol span={12}>
        <ChartCard title={ENROLLMENT_TITLE} subtitle={ENROLLMENT_SUBTITLE} autoHeight>
          {({ width }) => (series.length ? (
            <LineChart
              width={width}
              height={240}
              points={series}
              color={MF.util.base}
              formatValue={formatHeadcount}
              ariaLabel={`${ENROLLMENT_TITLE}: ${ENROLLMENT_SUBTITLE}`}
            />
          ) : (
            <div style={emptyStyle}>{ENROLLMENT_EMPTY}</div>
          ))}
        </ChartCard>
      </MfCol>
      <MfCol span={12}>
        <ChartCard title="Enrollment by Department" subtitle={`Headcount, ${baseYear} vs. ${data.targetYear}`} footnote={ENROLLMENT_NOTE} autoHeight>
          {() => (rows.length ? (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', background: MF.surface.page, fontFamily: MF.type.family }}>
                <thead>
                  <tr>
                    <th style={headerCell}>Department</th>
                    <th style={{ ...headerCell, textAlign: 'right' }}>{baseYear}</th>
                    <th style={{ ...headerCell, textAlign: 'right' }}>{data.targetYear}</th>
                    <th style={{ ...headerCell, textAlign: 'right' }}>Change</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.key} style={row.isCampus ? { background: MF.surface.card } : undefined}>
                      <td style={{ ...bodyCell, fontWeight: row.isCampus ? 700 : 600 }}>
                        {row.department}
                        {row.division ? <div style={{ fontSize: 11, fontWeight: 400, color: MF.ink.muted }}>{row.division}</div> : null}
                      </td>
                      <td style={numCell}>{row.startLabel}</td>
                      <td style={numCell}>{row.endLabel}</td>
                      <td style={numCell}>{row.changeLabel}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div style={emptyStyle}>{ENROLLMENT_EMPTY}</div>
          ))}
        </ChartCard>
      </MfCol>
    </MfGrid>
  );
}

// --- Unsaved-changes guard -----------------------------------------------------
function DiscardChangesDialog({ onCancel, onDiscard }) {
  const buttonStyle = (primary) => ({ ...(primary ? mfPrimaryButtonStyle : mfSecondaryButtonStyle), '--mf-focus-color': MF.util.base });
  return (
    <WorkspaceShell size="dialog" title="Discard unsaved changes?" onClose={onCancel}>
      <div style={{ fontSize: 13, color: MF.ink.primary, lineHeight: 1.5 }}>
        You have edits in Setup that haven&apos;t been saved. Leaving now discards them.
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 20 }}>
        <button type="button" className="mf-shell-button" style={buttonStyle(false)} onClick={onCancel}>Keep editing</button>
        <button type="button" className="mf-shell-button" style={buttonStyle(true)} onClick={onDiscard}>Discard changes</button>
      </div>
    </WorkspaceShell>
  );
}

// --- Shell --------------------------------------------------------------------
export default function SpaceGrowthWorkspace({ data, onClose }) {
  const [chosenTab, setActiveTab] = useState('overview');
  // Presentation mode hides the Setup tab (admin tools).
  const presenting = usePresentationMode();
  const tabs = presentationTabs(TABS, presenting);
  const activeTab = tabs.some((t) => t.id === chosenTab) ? chosenTab : 'overview';
  // cardId -> true while that Setup card has unsaved edits.
  const [dirtyCards, setDirtyCards] = useState({});
  // The tab switch or close waiting on the discard dialog: { tab } | { close: true }.
  const [pendingLeave, setPendingLeave] = useState(null);
  const busy = data.status === 'loading' || data.refreshing;
  const hasUnsaved = Object.values(dirtyCards).some(Boolean);

  const handleDirtyChange = useCallback((cardId, dirty) => {
    setDirtyCards((prev) => (Boolean(prev[cardId]) === dirty ? prev : { ...prev, [cardId]: dirty }));
  }, []);

  const handleTabChange = (tab) => {
    if (tab === activeTab) return;
    if (activeTab === 'setup' && hasUnsaved) {
      setPendingLeave({ tab });
      return;
    }
    setActiveTab(tab);
  };
  const handleClose = () => {
    if (hasUnsaved) {
      setPendingLeave({ close: true });
      return;
    }
    onClose();
  };
  const handleDiscard = () => {
    const leave = pendingLeave;
    setPendingLeave(null);
    setDirtyCards({});
    if (leave?.close) onClose();
    else if (leave?.tab) setActiveTab(leave.tab);
  };

  let body;
  if (activeTab === 'setup') {
    body = <SpaceGrowthSetupTab data={data} onDirtyChange={handleDirtyChange} />;
  } else if (!data.results) {
    body = <div style={emptyStyle}>{busy ? 'Calculating…' : 'No space growth data loaded.'}</div>;
  } else if (activeTab === 'departments') {
    body = <DepartmentsTab data={data} />;
  } else if (activeTab === 'enrollment') {
    body = <EnrollmentTab data={data} />;
  } else {
    body = <OverviewTab data={data} />;
  }

  return (
    <WorkspaceShell
      size="workspace"
      title={WORKSPACE_TITLE}
      subtitle={workspaceSubtitle(data)}
      actions={(
        <BarButton onClick={() => void data.reload({ forceAirtable: true })} disabled={busy}>
          {busy ? 'Calculating…' : 'Recalculate'}
        </BarButton>
      )}
      tabs={tabs}
      activeTab={activeTab}
      onTabChange={handleTabChange}
      tabsEnd={activeTab === 'setup' ? null : <YearPicker data={data} />}
      onClose={handleClose}
    >
      {data.error ? (
        <div role="alert" style={{ marginBottom: 12, fontSize: 12, color: MF.status.error }}>{data.error}</div>
      ) : null}
      {body}
      {pendingLeave ? <DiscardChangesDialog onCancel={() => setPendingLeave(null)} onDiscard={handleDiscard} /> : null}
    </WorkspaceShell>
  );
}
