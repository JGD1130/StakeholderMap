// src/components/mf/gaugeGeometry.js
//
// Pure layout math for the 180° utilization gauge, shared by the DOM Gauge
// (Gauge.jsx) and the react-pdf gauge planned for Phase 2. Everything is in
// real units of the target surface (CSS px on screen, pt in a PDF): the
// drawing's viewBox should equal { width, height } so nothing gets scaled.
//
// Angle convention: 0° = straight up, -90° = left end (0%), +90° = right end (100%).
import { MF, utilBands } from '../../theme/mfTokens';

export const GAUGE_LABEL_FONT = 11;
export const GAUGE_VALUE_FONT = 28;

// Arc colors. The bands start at 30% of the utilization ramp: the ramp's
// palest blue (#e2ebfc) is nearly identical to a light-gray track, so a low
// value's first segments looked unfilled. The track is util.noData.
// scripts/check-mf-tokens.mjs asserts the first band stays >= 1.25:1 against it.
export const GAUGE_BANDS = utilBands(8, { from: 30, to: 100 });
export const GAUGE_TRACK = MF.util.noData;

const clamp01 = (n) => Math.max(0, Math.min(1, n));
export const formatGaugePct = (fraction) => `${Math.round(fraction * 100)}%`;

function point(cx, cy, r, angleDeg) {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

// SVG path for the arc between two fractions (0-1) of the gauge. Always less
// than 180°, so the small-arc flag is 0; sweep 1 = clockwise.
function arcPath(cx, cy, r, fromFraction, toFraction) {
  const start = point(cx, cy, r, -90 + fromFraction * 180);
  const end = point(cx, cy, r, -90 + toFraction * 180);
  return `M ${start.x} ${start.y} A ${r} ${r} 0 0 1 ${end.x} ${end.y}`;
}

/**
 * @param {object} opts
 * @param {number} opts.width      drawing width
 * @param {number|null} opts.value 0-1, or null/NaN for "no data"
 * @param {number|null} [opts.target] 0-1 (default MF.util.target); null = no tick
 * @param {string[]} [opts.bands]  arc colors, low -> high (default GAUGE_BANDS)
 * @param {string} [opts.trackColor] unfilled arc color (default GAUGE_TRACK)
 * @param {number} [opts.labelFont] end/target label size (default 11)
 * @param {number} [opts.valueFont] value text size (default 28)
 */
export function computeGaugeGeometry({
  width,
  value,
  target = MF.util.target,
  bands = GAUGE_BANDS,
  trackColor = GAUGE_TRACK,
  labelFont = GAUGE_LABEL_FONT,
  valueFont = GAUGE_VALUE_FONT
}) {
  const hasValue = Number.isFinite(value);
  const v = hasValue ? clamp01(value) : 0;
  const hasTarget = Number.isFinite(target);
  const t = hasTarget ? clamp01(target) : null;

  const stroke = Math.round(Math.max(10, Math.min(18, width * 0.075)));
  // Side room for the "100%" label, centered under the arc's right end.
  const sideRoom = Math.max(stroke / 2, labelFont * 1.45) + 2;
  const r = Math.max(20, width / 2 - sideRoom);
  const outer = r + stroke / 2;
  const cx = width / 2;
  // Room above the arc for the target label.
  const cy = outer + 6 + labelFont + 4;
  const endLabelY = cy + stroke / 2 + labelFont + 4;
  const valueY = endLabelY + valueFont - 2;
  const height = Math.ceil(valueY + 6);

  // Colored up to the value, track after it; a band the value lands inside
  // is split in two.
  const segments = [];
  bands.forEach((color, i) => {
    const b0 = i / bands.length;
    const b1 = (i + 1) / bands.length;
    if (hasValue && v >= b1) {
      segments.push({ from: b0, to: b1, color });
    } else if (hasValue && v > b0) {
      segments.push({ from: b0, to: v, color });
      segments.push({ from: v, to: b1, color: trackColor });
    } else {
      segments.push({ from: b0, to: b1, color: trackColor });
    }
  });
  segments.forEach((s) => { s.d = arcPath(cx, cy, r, s.from, s.to); });

  let tick = null;
  if (hasTarget) {
    const angle = -90 + t * 180;
    const inner = point(cx, cy, r - stroke / 2 - 3, angle);
    const outerPt = point(cx, cy, outer + 4, angle);
    const labelPt = point(cx, cy, outer + 8, angle);
    tick = {
      angle,
      x1: inner.x,
      y1: inner.y,
      x2: outerPt.x,
      y2: outerPt.y,
      label: {
        x: labelPt.x,
        y: labelPt.y,
        anchor: angle > 5 ? 'start' : angle < -5 ? 'end' : 'middle',
        text: `${formatGaugePct(t)} target`
      }
    };
  }

  let needle = null;
  if (hasValue) {
    const angle = -90 + v * 180;
    const tip = point(cx, cy, r - stroke / 2 - 6, angle);
    needle = { angle, x1: cx, y1: cy, x2: tip.x, y2: tip.y, pivotR: 5 };
  }

  return {
    width,
    height,
    cx,
    cy,
    r,
    stroke,
    hasValue,
    value: hasValue ? v : null,
    target: t,
    segments,
    tick,
    needle,
    endLabels: [
      { x: cx - r, y: endLabelY, anchor: 'middle', text: '0%' },
      { x: cx + r, y: endLabelY, anchor: 'middle', text: '100%' }
    ],
    valueLabel: { x: cx, y: valueY, anchor: 'middle', text: hasValue ? formatGaugePct(v) : '—' },
    labelFont,
    valueFont
  };
}
