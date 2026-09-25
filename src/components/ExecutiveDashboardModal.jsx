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
import { HBarChart, DivergingBars, DivergingLegend, ScoreTable } from './mf/charts';

// The Executive Dashboard is Hastings-only (gated in StakeholderMap.jsx on
// Hastings' enableCapitalPriorities + enableClassroomUtilization flags).
const INSTITUTION_NAME = 'Hastings College';

// Legacy chart palette -- used only by the Capital Phasing timeline below,
// which Phase 2 Step 3 replaces. Everything else here uses mfTokens.
const COLORS = {
  label: '#344054',
  muted: '#667085',
  border: '#d0d7e2',
  blue: '#3b82f6'
};

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
  return table.buckets.map((b) => {
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

function RoomSizeCard({ data }) {
  const table = pickSizeRangeTable(data);
  const hasBars = Boolean(table?.buckets?.length);
  const unresolved = table?.unresolvedCapacityRoomCount || 0;
  return (
    <ChartCard
      title="Utilization by Room Size"
      subtitle={table
        ? `${formatTermSubtitle(table.termLabel)} · classroom time utilization by seat capacity`
        : 'Classroom time utilization by seat capacity'}
      footnote={hasBars && unresolved > 0
        ? `${unresolved} ${unresolved === 1 ? 'room' : 'rooms'} with no seat count on file not shown.`
        : null}
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

// --- Row 4: legacy Capital Phasing timeline (Phase 2 Step 3 replaces it) ---
// Unchanged drawing logic; takes the ChartCard's measured `width` in place of
// its old hard-coded 520 so it draws 1:1 instead of being scaled.

// Capital Phasing timeline: one thin bar per near-term project spanning
// [next phase start -> completion] on a shared date axis, a dashed "Today"
// marker, endpoint date labels, and yearly ticks between them.
function PhasingTimelineChart({ width, nearTerm }) {
  if (!nearTerm.length) {
    return <div style={{ fontSize: 12, color: MF.ink.muted }}>No near-term projects.</div>;
  }
  const rowHeight = 24;
  const axisX0 = 6;
  const axisX1 = width - 6;
  const axisWidth = axisX1 - axisX0;
  const edgeClearance = 38;

  const now = new Date();
  const { minTime, maxTime } = getPhasingAxisRange(nearTerm, now);
  const span = maxTime - minTime;
  const xForTime = (ms) => axisX0 + ((ms - minTime) / span) * axisWidth;

  const barsTop = 22;
  const axisY = barsTop + nearTerm.length * rowHeight + 8;
  const height = axisY + 30;

  const todayX = xForTime(now.getTime());
  const showTodayLabel = todayX - axisX0 > edgeClearance && axisX1 - todayX > edgeClearance;

  const minDate = new Date(minTime);
  const maxDate = new Date(maxTime);
  const yearTicks = [];
  for (let yr = minDate.getUTCFullYear() + 1; yr <= maxDate.getUTCFullYear(); yr += 1) {
    const t = Date.UTC(yr, 0, 1);
    if (t > minTime && t < maxTime) yearTicks.push(t);
  }

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ display: 'block' }}>
      {nearTerm.map((p, i) => {
        const rowY = barsTop + i * rowHeight;
        const x0 = xForTime(new Date(p.nextPhaseStart).getTime());
        const x1 = xForTime(new Date(p.completionDate).getTime());
        return (
          <React.Fragment key={p.projectId}>
            <text x={axisX0} y={rowY - 3} fontSize={9.5} fill={COLORS.label}>{p.projectName}</text>
            <rect x={Math.min(x0, x1)} y={rowY} width={Math.max(x1 - x0, 5)} height={9} rx={2} fill={COLORS.blue} />
          </React.Fragment>
        );
      })}

      <line x1={axisX0} y1={axisY} x2={axisX1} y2={axisY} stroke={COLORS.border} strokeWidth={1} />

      <line x1={todayX} y1={10} x2={todayX} y2={axisY} stroke={COLORS.muted} strokeWidth={1} strokeDasharray="3,3" />
      {showTodayLabel ? (
        <text x={todayX} y={9} fontSize={9} fill={COLORS.muted} textAnchor="middle">Today</text>
      ) : null}

      {yearTicks.map((t) => {
        const tx = xForTime(t);
        const showLabel = tx - axisX0 > edgeClearance && axisX1 - tx > edgeClearance;
        return (
          <React.Fragment key={t}>
            <line x1={tx} y1={axisY - 4} x2={tx} y2={axisY + 4} stroke={COLORS.border} strokeWidth={1} />
            {showLabel ? (
              <text x={tx} y={axisY + 15} fontSize={9} fill={COLORS.muted} textAnchor="middle">
                {new Date(t).getUTCFullYear()}
              </text>
            ) : null}
          </React.Fragment>
        );
      })}

      <text x={axisX0} y={axisY + 15} fontSize={9} fill={COLORS.muted}>
        {new Date(minTime).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}
        {minTime === now.getTime() ? ' (today)' : ''}
      </text>
      <text x={axisX1} y={axisY + 15} fontSize={9} fill={COLORS.muted} textAnchor="end">
        {new Date(maxTime).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}
      </text>
    </svg>
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
              <ChartCard
                title={formatPhasingTitle(data.phasingSummary.nearTerm)}
                subtitle="Projects with work starting in the next 2 years"
                autoHeight
              >
                {({ width }) => <PhasingTimelineChart width={width} nearTerm={data.phasingSummary.nearTerm} />}
              </ChartCard>
            </MfCol>
          </>
        ) : null}
      </MfGrid>
    </WorkspaceShell>
  );
}
