// Lightweight UI helpers used by BuildingPanel (and can be reused elsewhere).

export function fmtArea(n) {
  if (!Number.isFinite(n)) return '-';
  return Math.round(n).toLocaleString();
}

export function fmtCount(n) {
  if (!Number.isFinite(n)) return '-';
  return Number(n).toLocaleString();
}

/**
 * keyDepts: Array<{ name: string, color: string }>
 * Renders a vertical legend with colored swatches.
 */
export function renderKeyDeptLegendHtml(keyDepts = []) {
  if (!Array.isArray(keyDepts) || keyDepts.length === 0) return '';
  const rows = keyDepts.map(({ name, color }) => `
    <div style="display:flex;align-items:center;gap:8px;margin:4px 0;">
      <span style="width:12px;height:12px;border-radius:2px;background:${color || '#888'};border:1px solid rgba(0,0,0,.25)"></span>
      <span>${name || '-'}</span>
    </div>
  `).join('');
  return `<div style="min-width:180px">${rows}</div>`;
}
