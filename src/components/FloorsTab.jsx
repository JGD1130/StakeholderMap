import React from 'react';
import { fmtArea, fmtCount, renderKeyDeptLegendHtml } from '../helpers/popupUi';

/**
 * FloorsTab
 *
 * Props:
 * - stats: same shape as BuildingPanel.stats (for the active floor)
 * - floors: string[]
 * - selectedFloor: string
 * - onChangeFloor(floorId)
 * - onLoadFloorplan(floorId)
 */
export default function FloorsTab({
  stats = {},
  floors = [],
  selectedFloor,
  onChangeFloor,
  onLoadFloorplan,
}) {
  const {
    floorTotalSf, floorRooms, floorClassroomSf, floorClassroomCount,
    keyDepts = [],
  } = stats || {};

  const legendHtml = renderKeyDeptLegendHtml(keyDepts);

  return (
    <div
      style={{
        background: '#fff',
        border: '1px solid rgba(0,0,0,.2)',
        borderRadius: 8,
        boxShadow: '0 10px 30px rgba(0,0,0,.15)',
        padding: 16,
        minWidth: 360,
        maxWidth: 520,
      }}
    >
      <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 16 }}>
        <div>
          <div style={{ fontWeight: 700, marginBottom: 6 }}>FLOOR TOTALS</div>
          <div><b>Total SF:</b> {fmtArea(floorTotalSf)}</div>
          <div><b>Rooms:</b> {fmtCount(floorRooms)}</div>
          <div><b>Classroom SF:</b> {fmtArea(floorClassroomSf)}</div>
          <div><b>Classrooms:</b> {fmtCount(floorClassroomCount)}</div>

          <div style={{ marginTop: 10, display: 'flex', gap: 8, alignItems: 'center' }}>
            <label htmlFor="ft-floor" style={{ fontSize: 12, opacity: .8 }}>Floor</label>
            <select
              id="ft-floor"
              value={selectedFloor || ''}
              onChange={(e) => onChangeFloor && onChangeFloor(e.target.value)}
              style={{ padding: '4px 6px' }}
            >
              {floors.map(f => (
                <option key={f} value={f}>{f}</option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => onLoadFloorplan && onLoadFloorplan(selectedFloor)}
              style={{
                padding: '4px 10px', borderRadius: 6, border: '1px solid #ccc',
                background: '#f7f7f7', cursor: 'pointer'
              }}
            >
              Load
            </button>
          </div>
        </div>

        <div>
          <div style={{ fontWeight: 600, opacity: .75, marginBottom: 6 }}>Key Departments</div>
          {/* eslint-disable-next-line react/no-danger */}
          <div dangerouslySetInnerHTML={{ __html: legendHtml }} />
        </div>
      </div>
    </div>
  );
}
