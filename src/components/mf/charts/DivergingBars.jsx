// src/components/mf/charts/DivergingBars.jsx
//
// Signed horizontal bars around a zero line: negatives extend left in
// MF.diverging.deficit, positives right in MF.diverging.surplus, each rounded
// on its outer end only, with the value label just outside that end. Full
// row labels in a left column, wrapped to as many lines as they need (never
// truncated). Rows draw in the order given. Drawn 1:1 at `width`; height
// follows from the rows. Hover a row for its tooltip.
//
// rows: [{ key, label, value (number or null), tooltip: { title, rows } }]
// formatValue(value) -> string, e.g. "−19,571 SF".
import React from 'react';
import { MF } from '../../../theme/mfTokens';
import { ChartTooltip, useChartTooltip } from './ChartTooltip';
import { barPath, estimateTextWidth, wrapText } from './chartUtils';

const LABEL_FONT = 12;
const LINE_HEIGHT = 15;
const BAR_HEIGHT = 16;
const MIN_ROW_HEIGHT = 34;
const ROW_GAP = 6;

export function DivergingLegend({ negativeLabel = 'Deficit', positiveLabel = 'Surplus' }) {
  const swatch = (color) => ({ display: 'inline-block', width: 10, height: 10, borderRadius: 2, background: color, marginRight: 5, verticalAlign: '-1px' });
  return (
    <div style={{ display: 'flex', gap: 14, fontSize: 11, color: MF.ink.muted, fontFamily: MF.type.family, marginBottom: 8 }}>
      <span><span style={swatch(MF.diverging.deficit)} />{negativeLabel}</span>
      <span><span style={swatch(MF.diverging.surplus)} />{positiveLabel}</span>
    </div>
  );
}

export default function DivergingBars({ width, rows, formatValue, ariaLabel }) {
  const tip = useChartTooltip();

  const labelCol = Math.max(110, Math.min(190, width * 0.3));
  const labelWrap = labelCol - 12;
  const valueRoom = Math.max(...rows.map((r) => estimateTextWidth(Number.isFinite(r.value) ? formatValue(r.value) : 'No data', LABEL_FONT)), 40) + 10;
  const x0 = labelCol + valueRoom;
  const x1 = Math.max(x0 + 40, width - valueRoom);
  const zeroX = (x0 + x1) / 2;
  const half = (x1 - x0) / 2;
  const maxAbs = Math.max(...rows.filter((r) => Number.isFinite(r.value)).map((r) => Math.abs(r.value)), 1);

  // Row heights follow each label's wrapped line count.
  let cursor = 0;
  const laidOut = rows.map((row) => {
    const lines = wrapText(row.label, labelWrap, LABEL_FONT);
    const rowHeight = Math.max(MIN_ROW_HEIGHT, lines.length * LINE_HEIGHT + 10);
    const y = cursor;
    cursor += rowHeight + ROW_GAP;
    return { row, lines, y, rowHeight };
  });
  const height = Math.max(cursor - ROW_GAP, 1);

  return (
    <div ref={tip.containerRef} style={{ position: 'relative' }}>
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={ariaLabel} style={{ display: 'block', fontFamily: MF.type.family }}>
        {laidOut.map(({ row, lines, y, rowHeight }) => {
          const midY = y + rowHeight / 2;
          const barY = midY - BAR_HEIGHT / 2;
          const textY = midY + LABEL_FONT * 0.35;
          const firstLineY = midY - ((lines.length - 1) * LINE_HEIGHT) / 2 + LABEL_FONT * 0.35;
          const hasValue = Number.isFinite(row.value);
          const magnitude = hasValue ? Math.max((Math.abs(row.value) / maxAbs) * half, row.value === 0 ? 0 : 2) : 0;
          const isNegative = hasValue && row.value < 0;
          return (
            <g key={row.key}>
              <text fontSize={LABEL_FONT} fill={MF.ink.secondary}>
                {lines.map((line, li) => (
                  <tspan key={li} x={0} y={firstLineY + li * LINE_HEIGHT}>{line}</tspan>
                ))}
              </text>
              {hasValue && magnitude > 0 ? (
                <path
                  d={isNegative
                    ? barPath(zeroX - magnitude, barY, magnitude, BAR_HEIGHT, 4, 'left')
                    : barPath(zeroX, barY, magnitude, BAR_HEIGHT, 4, 'right')}
                  fill={isNegative ? MF.diverging.deficit : MF.diverging.surplus}
                />
              ) : null}
              {hasValue ? (
                <text
                  x={isNegative ? zeroX - magnitude - 6 : zeroX + magnitude + 6}
                  y={textY}
                  fontSize={LABEL_FONT}
                  fontWeight={600}
                  fill={MF.ink.primary}
                  textAnchor={isNegative ? 'end' : 'start'}
                >
                  {formatValue(row.value)}
                </text>
              ) : (
                <text x={zeroX + 6} y={textY} fontSize={LABEL_FONT} fill={MF.ink.muted}>No data</text>
              )}
              <rect
                x={0}
                y={y}
                width={width}
                height={rowHeight}
                fill="transparent"
                onMouseMove={(e) => tip.show(e, row.tooltip)}
                onMouseLeave={tip.hide}
              />
            </g>
          );
        })}
        <line x1={zeroX} y1={0} x2={zeroX} y2={height} stroke={MF.diverging.zero} strokeWidth={1} pointerEvents="none" />
      </svg>
      <ChartTooltip tip={tip.state} />
    </div>
  );
}
