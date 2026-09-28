// src/components/mf/charts/FundingLine.jsx
//
// Funding line: one row per building in priority order -- Rank · Building ·
// Cost · a bar spanning where that cost starts and ends in the running total ·
// Status · optional actions. A dashed ink line marks the budget cap across
// every row, labeled once in the header ("Budget $X"). Bars within budget use
// MF.diverging.surplus, beyond budget MF.line.border; a row with no cost shows
// "Cost needed" instead of a bar.
//
// An HTML grid (not SVG) so rows can hold inline controls; bar and line
// positions are percentages of the bar column, so they are drawn at the
// column's real width.
//
// rows: [{ key, rank, name, costLabel, sourceTag?, start, end, status ('within' | 'beyond' | 'needsCost'), statusLabel }]
import React from 'react';
import { MF } from '../../../theme/mfTokens';
import { ChartTooltip, useChartTooltip } from './ChartTooltip';
import { niceTicks } from './chartUtils';

const ROW_MIN_HEIGHT = 36;
const BAR_HEIGHT = 14;
const COLUMNS = '36px minmax(140px, 1.4fr) 104px minmax(180px, 3fr) 108px minmax(120px, max-content)';

const BAR_COLORS = { within: MF.diverging.surplus, beyond: MF.line.border };

function pct(value, axisMax) {
  return `${Math.max(0, Math.min(100, (value / axisMax) * 100))}%`;
}

const headerStyle = {
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
  color: MF.ink.muted,
  padding: '6px 8px',
  borderBottom: `1px solid ${MF.line.hairline}`,
  whiteSpace: 'nowrap'
};
const cellStyle = {
  display: 'flex',
  alignItems: 'center',
  minHeight: ROW_MIN_HEIGHT,
  padding: '4px 8px',
  fontSize: 12,
  color: MF.ink.primary,
  borderBottom: `1px solid ${MF.line.hairline}`,
  minWidth: 0
};

export default function FundingLine({ rows, axisMax, budgetCap, budgetLabel, formatAmount, formatTick = formatAmount, renderActions, ariaLabel }) {
  const tip = useChartTooltip();
  const ticks = niceTicks(axisMax).filter((t) => t <= axisMax);
  const capLeft = pct(budgetCap, axisMax);
  const budgetLine = (
    <span
      aria-hidden="true"
      style={{ position: 'absolute', top: 0, bottom: 0, left: capLeft, borderLeft: `1.5px dashed ${MF.ink.primary}`, pointerEvents: 'none' }}
    />
  );

  return (
    <div ref={tip.containerRef} style={{ position: 'relative', overflowX: 'auto', fontFamily: MF.type.family }}>
      <div role="table" aria-label={ariaLabel} style={{ display: 'grid', gridTemplateColumns: COLUMNS, minWidth: 720, background: MF.surface.page }}>
        <div role="row" style={{ display: 'contents' }}>
          <span role="columnheader" style={headerStyle}>Rank</span>
          <span role="columnheader" style={headerStyle}>Building</span>
          <span role="columnheader" style={{ ...headerStyle, textAlign: 'right' }}>Cost</span>
          <span role="columnheader" style={{ ...headerStyle, position: 'relative' }}>
            <span style={{ visibility: 'hidden' }}>Running total</span>
            <span
              style={{
                position: 'absolute',
                bottom: 6,
                left: capLeft,
                transform: `translateX(${budgetCap / axisMax > 0.75 ? '-100%' : '-50%'})`,
                padding: '0 4px',
                textTransform: 'none',
                letterSpacing: 0,
                fontSize: 12,
                fontWeight: 600,
                color: MF.ink.primary,
                background: MF.surface.page,
                whiteSpace: 'nowrap'
              }}
            >
              {budgetLabel}
            </span>
          </span>
          <span role="columnheader" style={headerStyle}>Status</span>
          <span role="columnheader" style={headerStyle}><span style={{ visibility: 'hidden' }}>Actions</span></span>
        </div>

        {rows.map((row) => {
          const hasBar = row.status !== 'needsCost' && row.end != null;
          const tooltip = hasBar
            ? {
              title: row.name,
              rows: [
                ['Cost', row.costLabel],
                ['Running total', `${formatAmount(row.start)} → ${formatAmount(row.end)}`],
                ['Status', row.statusLabel]
              ]
            }
            : null;
          return (
            <div key={row.key} role="row" style={{ display: 'contents' }}>
              <span role="cell" style={{ ...cellStyle, color: MF.ink.muted }}>{row.rank}</span>
              <span role="cell" style={{ ...cellStyle, fontWeight: 600, overflowWrap: 'anywhere' }}>{row.name}</span>
              <span role="cell" style={{ ...cellStyle, flexDirection: 'column', alignItems: 'flex-end', justifyContent: 'center', fontVariantNumeric: 'tabular-nums' }}>
                <span>{row.costLabel}</span>
                {row.sourceTag ? <span style={{ fontSize: 11, color: MF.ink.muted }}>{row.sourceTag}</span> : null}
              </span>
              <span
                role="cell"
                style={{ ...cellStyle, position: 'relative', padding: 0 }}
                onMouseMove={tooltip ? (e) => tip.show(e, tooltip) : undefined}
                onMouseLeave={tooltip ? tip.hide : undefined}
              >
                {hasBar ? (
                  <span
                    aria-hidden="true"
                    style={{
                      position: 'absolute',
                      top: '50%',
                      marginTop: -BAR_HEIGHT / 2,
                      height: BAR_HEIGHT,
                      left: pct(row.start, axisMax),
                      width: `max(2px, calc(${pct(row.end, axisMax)} - ${pct(row.start, axisMax)}))`,
                      borderRadius: 3,
                      background: BAR_COLORS[row.status]
                    }}
                  />
                ) : (
                  <span style={{ paddingLeft: 8, fontSize: 12, color: MF.ink.muted }}>Cost needed</span>
                )}
                {budgetLine}
              </span>
              <span role="cell" style={cellStyle}>{row.statusLabel}</span>
              <span role="cell" style={{ ...cellStyle, gap: 10, flexWrap: 'wrap' }}>{renderActions ? renderActions(row) : null}</span>
            </div>
          );
        })}

        {/* Dollar axis under the bar column: hairline ticks, 11px muted labels. */}
        <div aria-hidden="true" style={{ display: 'contents' }}>
          <span />
          <span />
          <span />
          <span style={{ position: 'relative', height: 22 }}>
            {ticks.map((t, i) => {
              const edge = i === 0 ? 'start' : t / axisMax > 0.94 ? 'end' : 'middle';
              return (
                <span key={t} style={{ position: 'absolute', top: 0, left: pct(t, axisMax) }}>
                  <span style={{ position: 'absolute', top: 0, left: 0, height: 4, borderLeft: `1px solid ${MF.line.border}` }} />
                  <span
                    style={{
                      position: 'absolute',
                      top: 6,
                      transform: edge === 'start' ? 'none' : edge === 'end' ? 'translateX(-100%)' : 'translateX(-50%)',
                      fontSize: 11,
                      color: MF.ink.muted,
                      whiteSpace: 'nowrap',
                      fontVariantNumeric: 'tabular-nums'
                    }}
                  >
                    {formatTick(t)}
                  </span>
                </span>
              );
            })}
          </span>
          <span />
          <span />
        </div>
      </div>
      <ChartTooltip tip={tip.state} />
    </div>
  );
}
