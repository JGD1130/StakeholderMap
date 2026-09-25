// src/components/ExecutiveDashboardModal.jsx
//
// The Executive Dashboard's visual surface, on the shared mf/ components:
// a workspace-size WorkspaceShell (Recalculate / Export to PDF in the title
// bar), a KPI row, the classroom time-utilization gauges, and -- for now --
// the Space Gap, Tier 1 and Capital Phasing charts wrapped in ChartCards.
// Phase 2 Step 2 replaces those three charts.
//
// Pure presentation: renders the `data` shape ExecutiveDashboardPanel.jsx's
// runCalculation() produces. No Firestore/Airtable access and no aggregation
// of its own -- every number still comes from executiveDashboardCalc.js.
//
// The PDF (ExecutiveDashboardPdfDocument.jsx) and the side-panel card
// (ExecutiveDashboardPanel.jsx) are unchanged by the move to the new shell.

import React from 'react';
import {
  formatUsdCompact,
  formatTier1CapitalNeed,
  formatTermSubtitle,
  getPhasingAxisRange,
  formatPhasingTitle
} from '../utils/executiveDashboardCalc';
import { INDUSTRY_TARGET_TIME_UTILIZATION } from '../utils/classroomUtilizationCalc';
import { MF } from '../theme/mfTokens';
import { WorkspaceShell, MfGrid, MfCol, KpiCard, ChartCard, Gauge } from './mf';
import { mfOnBarButtonStyle } from './mf/mfStyles';
import {
  HBarChart,
  DivergingBars,
  DivergingLegend,
  ScoreTable,
  PhasingTimeline,
  ChartLegend,
  PROJECT_TYPES,
  classifyProjectType,
  splitProjectName
} from './mf/charts';

// The Executive Dashboard is Hastings-only (gated in StakeholderMap.jsx on
// Hastings' enableCapitalPriorities + enableClassroomUtilization flags).
const INSTITUTION_NAME = 'Hastings College';

const MINUS_SIGN = '−';

function formatAsOfDate(date) {
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// Signed square feet with a true minus sign: "−60,051 SF", "+4,200 SF".
function formatSignedSf(value) {
  const rounded = Math.round(value);
  if (rounded === 0) return '0 SF';
  return `${rounded < 0 ? MINUS_SIGN : '+'}${Math.abs(rounded).toLocaleString('en-US')} SF`;
}

// Unsigned square feet: "43,120 SF".
function formatSf(value) {
  return `${Math.round(value).toLocaleString('en-US')} SF`;
}

function formatPctValue(pct) {
  return `${Math.round(pct)}%`;
}

// "A, B, C +2 more"
function listWithMore(names, max = 3) {
  if (names.length <= max) return names.join(', ');
  return `${names.slice(0, max).join(', ')} +${names.length - max} more`;
}

// --- Title-bar actions ------------------------------------------------------
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

// --- Row 1: KPI cards -------------------------------------------------------
const KPI_LABELS = {
  tier1Need: 'Tier 1 capital need',
  tier1Count: 'Tier 1 buildings',
  nearTerm: 'Near-term projects'
};

function tier1NeedCard(data) {
  const summary = data.tier1Summary;
  if (!summary.tier1Count) {
    return <KpiCard label={KPI_LABELS.tier1Need} value={null} missing={{ reason: 'No Tier 1 buildings' }} />;
  }
  const need = formatTier1CapitalNeed(summary);
  if (need.note) {
    // No Tier 1 building has cost data -- "—" / "Costs not entered".
    return <KpiCard label={KPI_LABELS.tier1Need} value={null} missing={{ reason: need.note }} />;
  }
  return (
    <KpiCard
      label={KPI_LABELS.tier1Need}
      value={need.value}
      context={`${summary.knownCostCount} of ${summary.tier1Count} buildings costed`}
    />
  );
}

function tier1CountCard(data) {
  const summary = data.tier1Summary;
  const names = summary.tier1Buildings.map((b) => b.originalId).filter(Boolean);
  return (
    <KpiCard
      label={KPI_LABELS.tier1Count}
      value={summary.tier1Count}
      context={names.length ? listWithMore(names) : 'No buildings score 80+'}
    />
  );
}

function nearTermCard(data) {
  if (!data.hasAnyCapitalPhasing) {
    return <KpiCard label={KPI_LABELS.nearTerm} value={null} missing={{ reason: 'No phasing projects uploaded' }} />;
  }
  return (
    <KpiCard
      label={KPI_LABELS.nearTerm}
      value={data.phasingSummary.nearTerm.length}
      context="Starting work in the next 2 years"
    />
  );
}

function spaceGapKpiCard(data) {
  const label = `Space gap (${data.targetYear})`;
  const gap = data.institutionGap.totalGapTarget;
  if (gap == null || !Number.isFinite(gap)) {
    return <KpiCard label={label} value={null} missing={{ reason: 'Space data unavailable' }} />;
  }
  const rounded = Math.round(gap);
  const context = rounded < 0
    ? `Deficit vs. ${data.targetYear} need`
    : rounded > 0
      ? `Surplus vs. ${data.targetYear} need`
      : `Matches ${data.targetYear} need`;
  const indicator = rounded < 0 ? 'deficit' : rounded > 0 ? 'surplus' : undefined;
  return <KpiCard label={label} value={formatSignedSf(gap)} context={context} indicator={indicator} />;
}

function KpiRow({ data, loading }) {
  if (loading || !data) {
    const labels = [KPI_LABELS.tier1Need, KPI_LABELS.tier1Count, KPI_LABELS.nearTerm, `Space gap (${data?.targetYear ?? 2036})`];
    return labels.map((label) => (
      <MfCol key={label} span={3}>
        <KpiCard label={label} value="…" context="Calculating" />
      </MfCol>
    ));
  }
  return (
    <>
      <MfCol span={3}>{tier1NeedCard(data)}</MfCol>
      <MfCol span={3}>{tier1CountCard(data)}</MfCol>
      <MfCol span={3}>{nearTermCard(data)}</MfCol>
      <MfCol span={3}>{spaceGapKpiCard(data)}</MfCol>
    </>
  );
}

// --- Row 2: classroom time-utilization gauges ------------------------------
const TARGET_PCT = Math.round(INDUSTRY_TARGET_TIME_UTILIZATION * 100);

function GaugeRow({ data }) {
  if (data.currentTerm.status === 'unconfigured') {
    return <div style={{ fontSize: 12, color: MF.ink.muted }}>No terms configured — cannot compute Time Utilization.</div>;
  }
  if (!data.campusRollups.length) {
    return <div style={{ fontSize: 12, color: MF.ink.muted }}>Terms are configured, but no scheduled classes matched any term.</div>;
  }
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 24 }}>
      {data.campusRollups.map((c) => (
        <div key={c.termId} style={{ flex: '0 1 240px', minWidth: 200 }}>
          <Gauge
            value={Number.isFinite(c.timeUtilizationPct) ? c.timeUtilizationPct / 100 : null}
            title={formatTermSubtitle(c.termLabel)}
            pill={data.currentTerm.termId === c.termId ? 'Current' : undefined}
          />
        </div>
      ))}
    </div>
  );
}

// --- Row 2 (right): utilization by room size --------------------------------
// The Classroom Size Range section's own 10-seat buckets for the current term
// (falling back to the first term), smallest at top, with time utilization
// added by executiveDashboardCalc.js's addTimeUtilizationToSizeRanges.
function pickSizeRangeTable(data) {
  const tables = Array.isArray(data.sizeRangeByTerm) ? data.sizeRangeByTerm : [];
  return tables.find((t) => t.termId === data.currentTerm?.termId) || tables[0] || null;
}

function roomSizeRows(table) {
  return table.buckets.filter((b) => b.roomCount > 0).map((b) => {
    const label = `${b.start}–${b.end} seats`;
    const rooms = `${b.roomCount} ${b.roomCount === 1 ? 'room' : 'rooms'}`;
    const tooltipRows = [
      ['Rooms', String(b.roomCount)],
      ['Time utilization', Number.isFinite(b.timeUtilizationPct) ? formatPctValue(b.timeUtilizationPct) : '—']
    ];
    if (Number.isFinite(b.seatUtilizationPct)) {
      tooltipRows.push(['Seat utilization', formatPctValue(b.seatUtilizationPct)]);
    }
    return {
      key: b.label,
      label,
      value: Number.isFinite(b.timeUtilizationPct) ? b.timeUtilizationPct : null,
      valueLabel: Number.isFinite(b.timeUtilizationPct) ? formatPctValue(b.timeUtilizationPct) : '—',
      countLabel: rooms,
      tooltip: { title: label, rows: tooltipRows }
    };
  });
}

// Empty size ranges are hidden; say so, along with any rooms left out for
// having no seat count on file.
function roomSizeFootnote(table) {
  const unresolved = table.unresolvedCapacityRoomCount || 0;
  const parts = [];
  if (unresolved > 0) parts.push(`${unresolved} ${unresolved === 1 ? 'room' : 'rooms'} with no seat count on file not shown.`);
  if (table.buckets.some((b) => b.roomCount === 0)) parts.push('Size ranges with no classrooms are hidden.');
  return parts.length ? parts.join(' ') : null;
}

function RoomSizeCard({ data }) {
  const table = pickSizeRangeTable(data);
  const hasBars = Boolean(table?.buckets?.some((b) => b.roomCount > 0));
  return (
    <ChartCard
      title="Utilization by Room Size"
      subtitle={table
        ? `${formatTermSubtitle(table.termLabel)} · classroom time utilization by seat capacity`
        : 'Classroom time utilization by seat capacity'}
      footnote={hasBars ? roomSizeFootnote(table) : null}
      autoHeight
    >
      {({ width }) => (hasBars ? (
        <HBarChart
          width={width}
          rows={roomSizeRows(table)}
          target={INDUSTRY_TARGET_TIME_UTILIZATION}
          color={MF.util.base}
          ariaLabel={`Classroom time utilization by seat capacity, ${formatTermSubtitle(table.termLabel)}`}
        />
      ) : (
        <div style={{ fontSize: 12, color: MF.ink.muted }}>No classrooms with a known seat count were scheduled this term.</div>
      ))}
    </ChartCard>
  );
}

// --- Row 3 (left): space gap by division -----------------------------------
// Largest deficit first; divisions with no resolvable gap sort last.
function spaceGapRows(buckets, targetYear) {
  return [...buckets]
    .sort((a, b) => {
      const av = Number.isFinite(a.gapTarget) ? a.gapTarget : Infinity;
      const bv = Number.isFinite(b.gapTarget) ? b.gapTarget : Infinity;
      return av - bv;
    })
    .map((b) => {
      const rows = [
        ['Existing', Number.isFinite(b.currentSF) ? formatSf(b.currentSF) : '—'],
        [`${targetYear} need`, Number.isFinite(b.needSF) ? formatSf(b.needSF) : '—'],
        ['Gap', Number.isFinite(b.gapTarget) ? formatSignedSf(b.gapTarget) : 'No data']
      ];
      if (b.categoriesExcluded > 0) {
        rows.push(['Not included', `${b.categoriesExcluded} ${b.categoriesExcluded === 1 ? 'category' : 'categories'} without data`]);
      }
      return { key: b.label, label: b.label, value: Number.isFinite(b.gapTarget) ? b.gapTarget : null, tooltip: { title: b.label, rows } };
    });
}

// The KPI's institution-wide gap and the division bars come from two
// different calculations (spaceGrowthCalc.js computeSpaceGrowth vs.
// computeDepartmentSpaceGrowth), so they don't have to add up. Say so, with
// the actual numbers, whenever they differ.
function spaceGapFootnote(data) {
  const kpi = data.institutionGap?.totalGapTarget;
  const withGap = data.spaceGapBuckets.filter((b) => Number.isFinite(b.gapTarget));
  if (!Number.isFinite(kpi) || !withGap.length) return null;
  const divisionsTotal = withGap.reduce((sum, b) => sum + b.gapTarget, 0);
  if (Math.round(divisionsTotal) === Math.round(kpi)) return null;
  return `Divisions total ${formatSignedSf(divisionsTotal)}; the ${formatSignedSf(kpi)} campus figure above also counts space `
    + 'not assigned to an academic department and uses campus-wide enrollment rather than each department’s own.';
}

// --- Row 3 (right): Tier 1 ranked table ------------------------------------
function tier1Rows(tier1Summary) {
  return tier1Summary.tier1Buildings.map((b, i) => {
    const cost = b.resolvedCost != null ? formatUsdCompact(b.resolvedCost) : '—';
    return {
      key: b.buildingId,
      rank: i + 1,
      name: b.originalId,
      score: b.total,
      costLabel: cost,
      tooltip: {
        title: b.originalId,
        rows: [
          ['Priority score', `${b.total} / 100`],
          ['Est. cost', b.resolvedCost != null ? `${cost} (deferred maintenance estimate)` : 'Not entered']
        ]
      }
    };
  });
}

// --- Row 4: Capital Phasing timeline ----------------------------------------
// Axis range is unchanged (executiveDashboardCalc.js getPhasingAxisRange, the
// same rule the card title reads). Each bar spans next phase start ->
// completion. Rows sort by start date, then building name. Building, project
// and SF are split out of the workbook's project name for display only.
function formatMonthYear(value) {
  return new Date(value).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}

function phasingRows(nearTerm) {
  return nearTerm
    .map((p) => {
      const { building, project, sf } = splitProjectName(p.projectName);
      const typeKey = classifyProjectType(p.projectName);
      const type = PROJECT_TYPES[typeKey];
      const sfLabel = Number.isFinite(sf) ? `${sf.toLocaleString('en-US')} SF` : null;
      const start = new Date(p.nextPhaseStart).getTime();
      const end = new Date(p.completionDate).getTime();
      const cost = Number(p.escalatedCost);
      const tooltipRows = [
        ['Project', project || '—'],
        ['Type', type.label],
        ['Schedule', `${formatMonthYear(p.nextPhaseStart)} – ${formatMonthYear(p.completionDate)}`]
      ];
      if (sfLabel) tooltipRows.push(['Size', sfLabel]);
      if (p.escalatedCost != null && Number.isFinite(cost)) tooltipRows.push(['Est. cost (escalated)', formatUsdCompact(cost)]);
      return {
        key: p.projectId,
        building,
        start,
        end,
        typeKey,
        line1: building,
        line2: [project, sfLabel].filter(Boolean).join(' · '),
        color: type.color,
        tooltip: { title: building, rows: tooltipRows }
      };
    })
    .sort((x, y) => (x.start - y.start) || x.building.localeCompare(y.building));
}

function PhasingCard({ nearTerm }) {
  const rows = nearTerm.length ? phasingRows(nearTerm) : [];
  const legendItems = Object.entries(PROJECT_TYPES)
    .filter(([key]) => rows.some((r) => r.typeKey === key))
    .map(([key, t]) => ({ key, label: t.label, color: t.color }));
  return (
    <ChartCard title={formatPhasingTitle(nearTerm)} subtitle="Projects with work starting in the next 2 years" autoHeight>
      {({ width }) => (rows.length ? (
        <>
          <ChartLegend items={legendItems} />
          <PhasingTimeline
            width={width}
            rows={rows}
            range={getPhasingAxisRange(nearTerm, new Date())}
            ariaLabel={formatPhasingTitle(nearTerm)}
          />
        </>
      ) : (
        <div style={{ fontSize: 12, color: MF.ink.muted }}>No near-term projects.</div>
      ))}
    </ChartCard>
  );
}

// --- Shell --------------------------------------------------------------
export default function ExecutiveDashboardModal({ data, loading, loadError, onRecalculate, onExportPdf, onClose }) {
  const actions = (
    <>
      <BarButton onClick={onRecalculate} disabled={loading}>{loading ? 'Calculating…' : 'Recalculate'}</BarButton>
      <BarButton onClick={onExportPdf} disabled={!data}>Export to PDF</BarButton>
    </>
  );

  return (
    <WorkspaceShell
      size="workspace"
      title="Executive Dashboard"
      subtitle={`${INSTITUTION_NAME} · as of ${formatAsOfDate(new Date())}`}
      actions={actions}
      onClose={onClose}
    >
      {loadError ? (
        <div role="alert" style={{ marginBottom: 12, fontSize: 12, color: MF.status.error }}>{loadError}</div>
      ) : null}

      <MfGrid>
        <KpiRow data={data} loading={loading} />

        {data ? (
          <>
            <MfCol span={6}>
              <ChartCard
                title="Classroom Time Utilization"
                subtitle={`Share of available weekly hours classrooms are scheduled · Industry target ${TARGET_PCT}%`}
                autoHeight
              >
                {() => <GaugeRow data={data} />}
              </ChartCard>
            </MfCol>
            <MfCol span={6}>
              <RoomSizeCard data={data} />
            </MfCol>

            <MfCol span={7}>
              <ChartCard
                title="Space Gap by Division"
                subtitle={`Current vs. ${data.targetYear} need, academic divisions`}
                footnote={data.spaceGapBuckets.length ? spaceGapFootnote(data) : null}
                autoHeight
              >
                {({ width }) => (data.spaceGapBuckets.length ? (
                  <>
                    <DivergingLegend negativeLabel="Deficit" positiveLabel="Surplus" />
                    <DivergingBars
                      width={width}
                      rows={spaceGapRows(data.spaceGapBuckets, data.targetYear)}
                      formatValue={formatSignedSf}
                      ariaLabel={`Space gap by academic division versus ${data.targetYear} need`}
                    />
                  </>
                ) : (
                  <div style={{ fontSize: 12, color: MF.ink.muted }}>
                    {data.airtableFetchFailed
                      ? 'Space data is still loading — click Recalculate to try again.'
                      : 'No division-level gaps available.'}
                  </div>
                ))}
              </ChartCard>
            </MfCol>
            <MfCol span={5}>
              <ChartCard
                title="Capital Compass — Tier 1"
                footnote={data.tier1Summary.tier1Count ? 'Score: Capital Compass priority score (0–100)' : null}
                autoHeight
              >
                {() => (data.tier1Summary.tier1Count ? (
                  <ScoreTable rows={tier1Rows(data.tier1Summary)} />
                ) : (
                  <div style={{ fontSize: 12, color: MF.ink.muted }}>No Tier 1 buildings currently.</div>
                ))}
              </ChartCard>
            </MfCol>

            <MfCol span={12}>
              <PhasingCard nearTerm={data.phasingSummary.nearTerm} />
            </MfCol>
          </>
        ) : null}
      </MfGrid>
    </WorkspaceShell>
  );
}
