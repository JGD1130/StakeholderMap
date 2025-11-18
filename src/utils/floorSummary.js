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
      p.area ??
      p.Area ??
      p['Area (SF)'] ??
      p.SF ??
      p.NetArea ??
      p.Area_SF ??
      p['Area_SF'] ??
      0;

    const sf = Number(sfRaw);
    if (!Number.isFinite(sf) || sf <= 0) continue;

    rooms += 1;
    totalSf += sf;

    const typeRaw =
      p.type ??
      p.Type ??
      p.RoomType ??
      p['Room Type'] ??
      p.RoomTypeName ??
      '';
    const type = String(typeRaw).toUpperCase();

    const nameRaw =
      p.Name ??
      p.Room ??
      p['Room Name'] ??
      p.RoomType ??
      '';
    const name = String(nameRaw).toUpperCase();

    const isClassroom =
      type.includes('CLASSROOM') ||
      type.includes('LECTURE') ||
      name.includes('CLASSROOM') ||
      name.includes('LECTURE');

    if (isClassroom) {
      classroomCount += 1;
      classroomSf += sf;
    }

    const deptRaw =
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
