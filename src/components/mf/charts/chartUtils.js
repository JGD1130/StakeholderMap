// src/components/mf/charts/chartUtils.js
//
// Small drawing helpers shared by the mf/ charts. Pure functions, no React.

// Rough text width for layout decisions (label column sizing, wrapping).
// SVG can't measure before render; ~0.56em per character is a safe average
// for the MF.type.family sans stack at these sizes.
export function estimateTextWidth(text, fontSize) {
  return String(text ?? '').length * fontSize * 0.56;
}

// Greedy word wrap to a pixel width. Never truncates: a label that needs
// more lines gets them (callers size rows from the line count).
export function wrapText(text, maxWidth, fontSize) {
  const words = String(text ?? '').split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  words.forEach((word) => {
    const candidate = line ? `${line} ${word}` : word;
    if (line && estimateTextWidth(candidate, fontSize) > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  });
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

// Round tick values from 0 up to `max`: a 1/2/2.5/5 × 10^n step giving
// about `target` intervals, e.g. max 4.5M -> 0, 1M, 2M, 3M, 4M.
export function niceTicks(max, target = 5) {
  if (!Number.isFinite(max) || max <= 0) return [0];
  const rough = max / target;
  const pow = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= rough) || 10 * pow;
  const ticks = [];
  for (let v = 0; v <= max + step * 1e-9; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  return ticks;
}

// Horizontal bar with only its outer end rounded ('left' or 'right').
export function barPath(x, y, width, height, radius, roundedSide) {
  const w = Math.max(0, width);
  const r = Math.max(0, Math.min(radius, w, height / 2));
  if (r === 0) return `M ${x} ${y} H ${x + w} V ${y + height} H ${x} Z`;
  if (roundedSide === 'left') {
    return [
      `M ${x + w} ${y}`,
      `H ${x + r}`,
      `A ${r} ${r} 0 0 0 ${x} ${y + r}`,
      `V ${y + height - r}`,
      `A ${r} ${r} 0 0 0 ${x + r} ${y + height}`,
      `H ${x + w}`,
      'Z'
    ].join(' ');
  }
  return [
    `M ${x} ${y}`,
    `H ${x + w - r}`,
    `A ${r} ${r} 0 0 1 ${x + w} ${y + r}`,
    `V ${y + height - r}`,
    `A ${r} ${r} 0 0 1 ${x + w - r} ${y + height}`,
    `H ${x}`,
    'Z'
  ].join(' ');
}
