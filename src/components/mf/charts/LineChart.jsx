// src/components/mf/charts/LineChart.jsx
//
// Single-series line over ordered categories (e.g. years): a line in `color`
// with a point at every value, value labels at the first and last point,
// hairline gridlines with 11px muted tick labels, and a hover tooltip per
// point (hover anywhere in a point's column). The y axis spans the data with
// round ticks rather than starting at zero, so a trend over a narrow range
// stays readable. Drawn 1:1 at `width` x `height`.
//
// points: [{ key, label, value (number), tooltip: { title, rows } }]
import React, { useState } from 'react';
import { MF } from '../../../theme/mfTokens';
import { ChartTooltip, useChartTooltip } from './ChartTooltip';
import { estimateTextWidth } from './chartUtils';

const TICK_FONT = 11;
const VALUE_FONT = 12;
const PAD_TOP = 26; // room for the end value labels
const PAD_BOTTOM = 24; // x labels
const POINT_R = 3.5;

// Round ticks covering [lo, hi] with about `target` intervals.
function rangeTicks(lo, hi, target = 4) {
  const span = hi - lo || Math.abs(hi) || 1;
  const rough = span / target;
  const pow = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= rough) || 10 * pow;
  const start = Math.floor(lo / step) * step;
  const end = Math.ceil(hi / step) * step;
  const ticks = [];
  for (let v = start; v <= end + step * 1e-9; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  return ticks.length > 1 ? ticks : [start, start + step];
}

export default function LineChart({ width, height = 240, points, color = MF.util.base, formatValue = String, formatTick = formatValue, ariaLabel }) {
  const tip = useChartTooltip();
  const [hoverKey, setHoverKey] = useState(null);
  if (!points.length) return null;

  const values = points.map((p) => p.value);
  const ticks = rangeTicks(Math.min(...values), Math.max(...values));
  const yMin = ticks[0];
  const yMax = ticks[ticks.length - 1];
  const axisWidth = Math.max(...ticks.map((t) => estimateTextWidth(formatTick(t), TICK_FONT))) + 10;

  const plotLeft = axisWidth;
  const plotRight = width - 16;
  const plotTop = PAD_TOP;
  const plotBottom = height - PAD_BOTTOM;
  const band = (plotRight - plotLeft) / points.length;
  const xAt = (i) => plotLeft + band * (i + 0.5);
  const yAt = (v) => plotBottom - ((v - yMin) / (yMax - yMin || 1)) * (plotBottom - plotTop);

  // Thin the x labels when they'd collide.
  const labelWidth = Math.max(...points.map((p) => estimateTextWidth(p.label, TICK_FONT))) + 8;
  const labelEvery = Math.max(1, Math.ceil(labelWidth / band));

  const path = points.map((p, i) => `${i ? 'L' : 'M'} ${xAt(i)} ${yAt(p.value)}`).join(' ');
  const last = points.length - 1;

  return (
    <div ref={tip.containerRef} style={{ position: 'relative' }}>
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={ariaLabel} style={{ display: 'block', fontFamily: MF.type.family }}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={plotLeft} x2={plotRight} y1={yAt(t)} y2={yAt(t)} stroke={MF.line.hairline} strokeWidth={1} />
            <text x={plotLeft - 8} y={yAt(t) + TICK_FONT * 0.35} fontSize={TICK_FONT} fill={MF.ink.muted} textAnchor="end">
              {formatTick(t)}
            </text>
          </g>
        ))}
        {points.map((p, i) => (i % labelEvery === 0 || i === last ? (
          <text key={p.key} x={xAt(i)} y={height - 6} fontSize={TICK_FONT} fill={MF.ink.muted} textAnchor="middle">{p.label}</text>
        ) : null))}

        <path d={path} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        {points.map((p, i) => (
          <circle
            key={p.key}
            cx={xAt(i)}
            cy={yAt(p.value)}
            r={hoverKey === p.key ? POINT_R + 1.5 : POINT_R}
            fill={color}
            stroke={MF.surface.page}
            strokeWidth={1.5}
          />
        ))}
        {[0, last].filter((i, idx, arr) => arr.indexOf(i) === idx).map((i) => (
          <text
            key={`value-${i}`}
            x={xAt(i)}
            y={yAt(points[i].value) - 10}
            fontSize={VALUE_FONT}
            fontWeight={600}
            fill={MF.ink.primary}
            textAnchor={i === 0 && last > 0 ? 'start' : i === last && last > 0 ? 'end' : 'middle'}
          >
            {formatValue(points[i].value)}
          </text>
        ))}

        {points.map((p, i) => (
          <rect
            key={`hit-${p.key}`}
            x={plotLeft + band * i}
            y={0}
            width={band}
            height={height}
            fill="transparent"
            onMouseMove={(e) => { setHoverKey(p.key); tip.show(e, p.tooltip); }}
            onMouseLeave={() => { setHoverKey(null); tip.hide(); }}
          />
        ))}
      </svg>
      <ChartTooltip tip={tip.state} />
    </div>
  );
}
