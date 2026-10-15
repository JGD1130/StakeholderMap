// src/components/CapitalCompassConditionTab.jsx
//
// Condition tab of the Capital Compass workspace (admin-only): the facility
// condition assessment from building-resources.json -- four KPIs, a
// building x system matrix on the MF.diverging scale (worst building first,
// campus average per system along the bottom) and a building table with
// tier and cost. Values, colors and orderings come from conditionView.js.
import React, { useMemo } from 'react';
import { MF } from '../theme/mfTokens';
import { MfGrid, MfCol, KpiCard, ChartCard } from './mf';
import { mfTableHeaderCell, mfTableBodyCell } from './mf/mfStyles';
import { ChartLegend, ChartTooltip, useChartTooltip } from './mf/charts';
import {
  conditionModel,
  conditionKpis,
  conditionCell,
  conditionTooltip,
  conditionLegendItems,
  conditionTableRows,
  conditionSourceFootnote,
  CONDITION_MATRIX_NOTE,
  CONDITION_SCALE_CAPTION
} from './conditionView';
import { TIER_COST_FOOTNOTE } from './capitalCompassView';

const emptyStyle = { fontSize: 12, color: MF.ink.muted };
const EMPTY = 'No condition assessment is loaded for this campus.';
const NAME_COL_WIDTH = 200;
const CELL_WIDTH = 52;

const stickyName = {
  position: 'sticky',
  left: 0,
  zIndex: 1,
  background: MF.surface.page,
  minWidth: NAME_COL_WIDTH,
  maxWidth: NAME_COL_WIDTH,
  paddingRight: 8,
  textAlign: 'left'
};

const systemHead = {
  fontSize: 11,
  fontWeight: 600,
  color: MF.ink.secondary,
  textAlign: 'center',
  verticalAlign: 'bottom',
  lineHeight: 1.25,
  padding: '0 2px 4px',
  minWidth: CELL_WIDTH,
  maxWidth: 72
};

const groupHead = {
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
  color: MF.ink.muted,
  textAlign: 'center',
  padding: '0 2px 4px',
  borderBottom: `2px solid ${MF.line.border}`
};

function ScoreCell({ score, isAverage, tooltip, tip, groupStart }) {
  const cell = conditionCell(score, isAverage);
  return (
    <td style={{ padding: 0, paddingLeft: groupStart ? 6 : 0 }}>
      <span
        role="img"
        aria-label={`${tooltip.title}, ${tooltip.rows[0][0]}: ${tooltip.rows[0][1]}`}
        onMouseMove={(e) => tip.show(e, tooltip)}
        onMouseLeave={tip.hide}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          minWidth: CELL_WIDTH,
          height: 26,
          borderRadius: 3,
          background: cell.background,
          color: cell.color,
          fontSize: 12,
          fontWeight: isAverage ? 700 : 600,
          fontVariantNumeric: 'tabular-nums'
        }}
      >
        {cell.label}
      </span>
    </td>
  );
}

function ConditionMatrix({ model }) {
  const tip = useChartTooltip();
  const groupStarts = new Set(model.groups.map((g) => g.systems[0]?.id).filter(Boolean));

  const renderRow = (key, label, average, scoreFor, { emphasis = false } = {}) => (
    <tr key={key}>
      <th
        scope="row"
        style={{
          ...stickyName,
          fontSize: 12,
          fontWeight: emphasis ? 700 : 600,
          color: MF.ink.primary,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          borderTop: emphasis ? `2px solid ${MF.line.border}` : undefined,
          paddingTop: emphasis ? 6 : 0
        }}
        title={label}
      >
        {label}
      </th>
      <ScoreCell score={average} isAverage tooltip={conditionTooltip(label, 'Average', average)} tip={tip} />
      {model.systems.map((s) => (
        <ScoreCell
          key={s.id}
          score={scoreFor(s)}
          isAverage={emphasis}
          groupStart={groupStarts.has(s.id)}
          tooltip={conditionTooltip(label, s.label, scoreFor(s))}
          tip={tip}
        />
      ))}
    </tr>
  );

  return (
    <div ref={tip.containerRef} style={{ position: 'relative', fontFamily: MF.type.family }}>
      <ChartLegend items={conditionLegendItems()} />
      <div style={{ overflowX: 'auto' }}>
        <table style={{ borderCollapse: 'separate', borderSpacing: '2px', background: MF.surface.page }} aria-label="Condition score by building and system">
          <thead>
            <tr>
              <th rowSpan={2} style={{ ...stickyName, ...systemHead, textAlign: 'left' }}>Building</th>
              <th rowSpan={2} style={{ ...systemHead, color: MF.ink.primary }}>Average</th>
              {model.groups.map((g) => (
                <th key={g.key} colSpan={g.systems.length} style={{ ...groupHead, paddingLeft: 6 }}>{g.label}</th>
              ))}
            </tr>
            <tr>
              {model.systems.map((s) => (
                <th key={s.id} style={{ ...systemHead, paddingLeft: groupStarts.has(s.id) ? 8 : 2 }}>{s.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {model.rows.map((r) => renderRow(r.key, r.name, r.average, (s) => r.scores[s.id]))}
            {renderRow('campus', 'Campus average', model.campusAverage, (s) => model.systemAverages[s.id], { emphasis: true })}
          </tbody>
        </table>
      </div>
      <ChartTooltip tip={tip.state} />
    </div>
  );
}

function TierSwatch({ color }) {
  return <span aria-hidden="true" style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 2, background: color, marginRight: 6, verticalAlign: '-1px' }} />;
}

function ConditionTable({ rows }) {
  const numCell = { ...mfTableBodyCell, textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' };
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', background: MF.surface.page, fontFamily: MF.type.family }}>
        <thead>
          <tr>
            <th style={mfTableHeaderCell}>Building</th>
            <th style={{ ...mfTableHeaderCell, textAlign: 'right' }}>Average</th>
            <th style={mfTableHeaderCell}>Lowest systems</th>
            <th style={mfTableHeaderCell}>Notes</th>
            <th style={mfTableHeaderCell}>Tier</th>
            <th style={{ ...mfTableHeaderCell, textAlign: 'right' }}>Est. cost</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <td style={{ ...mfTableBodyCell, fontWeight: 600 }}>
                {r.name}
                {r.onMap ? null : <div style={{ fontSize: 11, fontWeight: 400, color: MF.ink.muted }}>Not matched to a map building</div>}
              </td>
              <td style={numCell}>{r.averageLabel}</td>
              <td style={{ ...mfTableBodyCell, color: MF.ink.secondary }}>{r.lowest}</td>
              <td style={{ ...mfTableBodyCell, color: MF.ink.secondary, maxWidth: 320 }}>{r.notes}</td>
              <td style={{ ...mfTableBodyCell, whiteSpace: 'nowrap', color: r.tierColor ? MF.ink.primary : MF.ink.muted }}>
                {r.tierColor ? <TierSwatch color={r.tierColor} /> : null}
                {r.tierLabel}
              </td>
              <td style={numCell}>
                {r.costLabel}
                {r.sourceTag ? <div style={{ fontSize: 11, color: MF.ink.muted }}>{r.sourceTag}</div> : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function CapitalCompassConditionTab({ data, buildingNames = [] }) {
  const model = useMemo(() => conditionModel(data, buildingNames), [data, buildingNames]);
  const tableRows = useMemo(() => conditionTableRows(model, data), [model, data]);
  const source = conditionSourceFootnote(model);

  return (
    <MfGrid>
      {conditionKpis(model).map(({ key, ...props }) => (
        <MfCol key={key} span={3}>
          <KpiCard {...props} />
        </MfCol>
      ))}

      <MfCol span={12}>
        <ChartCard
          title="Condition by Building and System"
          subtitle={`Worst average first · ${CONDITION_SCALE_CAPTION}`}
          footnote={model.rows.length ? [CONDITION_MATRIX_NOTE, source].filter(Boolean).join(' ') : null}
          autoHeight
        >
          {() => (model.rows.length ? <ConditionMatrix model={model} /> : <div style={emptyStyle}>{EMPTY}</div>)}
        </ChartCard>
      </MfCol>

      <MfCol span={12}>
        <ChartCard
          title="Buildings"
          subtitle="Lowest average first"
          footnote={model.rows.length ? [TIER_COST_FOOTNOTE, source].filter(Boolean).join(' ') : null}
          autoHeight
        >
          {() => (tableRows.length ? <ConditionTable rows={tableRows} /> : <div style={emptyStyle}>{EMPTY}</div>)}
        </ChartCard>
      </MfCol>
    </MfGrid>
  );
}
