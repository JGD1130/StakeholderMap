// src/components/ExecutiveDashboardModal.jsx
//
// The Executive Dashboard's visual surface, on the shared mf/ components: a
// workspace-size WorkspaceShell (Recalculate / Export to PDF in the title
// bar), a KPI row, classroom time-utilization gauges beside utilization by
// room size, Space Gap by division beside the Tier 1 table, and the Capital
// Phasing timeline.
//
// Pure presentation: renders the `data` shape ExecutiveDashboardPanel.jsx's
// runCalculation() produces. Every value, label, sort order and footnote comes
// from executiveDashboardView.js, which the PDF and the side-panel card share.

import React from 'react';
import { getPhasingAxisRange } from '../utils/executiveDashboardCalc';
import { INDUSTRY_TARGET_TIME_UTILIZATION } from '../utils/classroomUtilizationCalc';
import { MF } from '../theme/mfTokens';
import { WorkspaceShell, MfGrid, MfCol, KpiCard, ChartCard, Gauge } from './mf';
import { mfOnBarButtonStyle } from './mf/mfStyles';
import { HBarChart, DivergingBars, DivergingLegend, ScoreTable, PhasingTimeline, ChartLegend } from './mf/charts';
import {
  dashboardSubtitle,
  formatSignedSf,
  kpiModels,
  loadingKpiModels,
  UTILIZATION_TITLE,
  UTILIZATION_SUBTITLE,
  gaugeSection,
  ROOM_SIZE_TITLE,
  ROOM_SIZE_EMPTY,
  pickSizeRangeTable,
  hasRoomSizeBars,
  roomSizeSubtitle,
  roomSizeRows,
  roomSizeFootnote,
  SPACE_GAP_TITLE,
  spaceGapSubtitle,
  spaceGapEmptyMessage,
  spaceGapRows,
  spaceGapFootnote,
  TIER1_TITLE,
  TIER1_FOOTNOTE,
  TIER1_EMPTY,
  tier1Rows,
  PHASING_SUBTITLE,
  PHASING_EMPTY,
  phasingTitle,
  phasingRows,
  phasingLegendItems
} from './executiveDashboardView';

const emptyStyle = { fontSize: 12, color: MF.ink.muted };

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
function KpiRow({ data, loading }) {
  const models = loading || !data ? loadingKpiModels(data?.targetYear) : kpiModels(data);
  return models.map(({ key, ...props }) => (
    <MfCol key={key} span={3}>
      <KpiCard {...props} />
    </MfCol>
  ));
}

// --- Row 2 ------------------------------------------------------------------
function GaugeRow({ data }) {
  const section = gaugeSection(data);
  if (section.message) return <div style={emptyStyle}>{section.message}</div>;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 24 }}>
      {section.gauges.map((g) => (
        <div key={g.key} style={{ flex: '0 1 240px', minWidth: 200 }}>
          <Gauge value={g.value} title={g.title} pill={g.pill} />
        </div>
      ))}
    </div>
  );
}

function RoomSizeCard({ data }) {
  const table = pickSizeRangeTable(data);
  const hasBars = hasRoomSizeBars(table);
  return (
    <ChartCard
      title={ROOM_SIZE_TITLE}
      subtitle={roomSizeSubtitle(table)}
      footnote={hasBars ? roomSizeFootnote(table) : null}
      autoHeight
    >
      {({ width }) => (hasBars ? (
        <HBarChart
          width={width}
          rows={roomSizeRows(table)}
          target={INDUSTRY_TARGET_TIME_UTILIZATION}
          color={MF.util.base}
          ariaLabel={roomSizeSubtitle(table)}
        />
      ) : (
        <div style={emptyStyle}>{ROOM_SIZE_EMPTY}</div>
      ))}
    </ChartCard>
  );
}

// --- Row 4 ------------------------------------------------------------------
function PhasingCard({ nearTerm }) {
  const rows = nearTerm.length ? phasingRows(nearTerm) : [];
  return (
    <ChartCard title={phasingTitle(nearTerm)} subtitle={PHASING_SUBTITLE} autoHeight>
      {({ width }) => (rows.length ? (
        <>
          <ChartLegend items={phasingLegendItems(rows)} />
          <PhasingTimeline
            width={width}
            rows={rows}
            range={getPhasingAxisRange(nearTerm, new Date())}
            ariaLabel={phasingTitle(nearTerm)}
          />
        </>
      ) : (
        <div style={emptyStyle}>{PHASING_EMPTY}</div>
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
      subtitle={dashboardSubtitle(new Date())}
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
              <ChartCard title={UTILIZATION_TITLE} subtitle={UTILIZATION_SUBTITLE} autoHeight>
                {() => <GaugeRow data={data} />}
              </ChartCard>
            </MfCol>
            <MfCol span={6}>
              <RoomSizeCard data={data} />
            </MfCol>

            <MfCol span={7}>
              <ChartCard
                title={SPACE_GAP_TITLE}
                subtitle={spaceGapSubtitle(data)}
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
                  <div style={emptyStyle}>{spaceGapEmptyMessage(data)}</div>
                ))}
              </ChartCard>
            </MfCol>
            <MfCol span={5}>
              <ChartCard
                title={TIER1_TITLE}
                footnote={data.tier1Summary.tier1Count ? TIER1_FOOTNOTE : null}
                autoHeight
              >
                {() => (data.tier1Summary.tier1Count ? (
                  <ScoreTable rows={tier1Rows(data.tier1Summary)} />
                ) : (
                  <div style={emptyStyle}>{TIER1_EMPTY}</div>
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
