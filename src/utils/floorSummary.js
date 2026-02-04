import { getDeptColor } from '../style/roomColors';

export function computeFloorSummary(featureCollection) {
  const fc = featureCollection || {};
  const feats = Array.isArray(fc.features) ? fc.features : [];

  let totalSf = 0;
  let rooms = 0;
  let classroomSf = 0;
  let classroomCount = 0;

  const byDept = new Map();

  for (const f of feats) {
    const p = f.properties || {};

    const sfRaw =
      p.__areaSf ??
      p.Area_SF ??
      p['Area_SF'] ??
      p.area ??
      p.Area ??
      p.SF ??
      p['Area (SF)'] ??
      p.NetArea ??
      0;

    const sf = Number(sfRaw);
    if (!Number.isFinite(sf) || sf <= 0) continue;

    rooms += 1;
    totalSf += sf;

    // ---- TYPE (prefer NCES) ----
    const type = String(p.__roomType ?? p.NCES_Type ?? '').trim();

    // ---- NAME (keep your existing logic) ----
    const nameRaw =
      p.Name ??
      p.Room ??
      p['Room Name'] ??
      '';
    const name = String(nameRaw).toUpperCase();

    // ---- Classroom detection (check NCES type too) ----
    const typeUpper = type.toUpperCase();
    const isClassroom =
      typeUpper.includes('CLASSROOM') ||
      typeUpper.includes('LECTURE') ||
      name.includes('CLASSROOM') ||
      name.includes('LECTURE');

    if (isClassroom) {
      classroomCount += 1;
      classroomSf += sf;
    }

    const deptRaw =
      p.__dept ??
      p.NCES_Department ??
      p['NCES_Department'] ??
      p.NCES_Dept ??
      p['NCES Dept'] ??
      p.department ??
      p.Department ??
      p.Dept ??
      '';
    const dept = String(deptRaw).trim();
    if (dept) {
      byDept.set(dept, (byDept.get(dept) || 0) + sf);
    }
  }

  const keyDepts = Array.from(byDept.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([name, sf]) => ({
      name,
      sf,
      color: getDeptColor(name)
    }));

  const totalsByDept = Object.fromEntries(byDept);

  return {
    totalSf,
    rooms,
    classroomSf,
    classroomCount,
    totalsByDept,
    keyDepts
  };
}
