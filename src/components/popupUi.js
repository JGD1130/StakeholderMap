// src/components/popupUi.js
export function toKeyDeptList(totalsByDept, max = 8) {
  if (!totalsByDept) return [];
  const entries = Object.entries(totalsByDept); // [name, areaSf]
  entries.sort((a, b) => (b[1] || 0) - (a[1] || 0));
  return entries.slice(0, max).map(([name, areaSf]) => ({ name, areaSf }));
}
