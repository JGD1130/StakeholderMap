// src/components/ClassroomUtilizationRoomsTab.jsx
//
// Rooms tab of the Classroom Utilization workspace: every classroom scheduled
// in the selected term, filterable by building and a search box, sortable by
// any column (Time util. high -> low by default). Seat util. is hidden when
// the term has no seat data, same rule as the Overview. Rows, filtering,
// sorting and the summary line come from classroomUtilizationView.js.
import React, { useMemo, useState } from 'react';
import { MF } from '../theme/mfTokens';
import { MfGrid, MfCol, ChartCard } from './mf';
import { mfInputStyle, mfTableHeaderCell, mfTableBodyCell } from './mf/mfStyles';
import { UtilBar } from './mf/charts';
import {
  hasSeatData,
  roomRows,
  roomBuildingOptions,
  filterRoomRows,
  sortRoomRows,
  roomsSummaryLine,
  termDisplayLabel,
  NO_CLASSES_THIS_TERM
} from './classroomUtilizationView';

const numCell = { ...mfTableBodyCell, textAlign: 'right', fontVariantNumeric: 'tabular-nums' };

// firstDir: the direction a column sorts in on its first click.
const COLUMNS = [
  { key: 'building', label: 'Building', firstDir: 'asc' },
  { key: 'room', label: 'Room', firstDir: 'asc' },
  { key: 'capacity', label: 'Capacity', firstDir: 'desc', numeric: true },
  { key: 'hours', label: 'Hours/wk', firstDir: 'desc', numeric: true },
  { key: 'timePct', label: 'Time util.', firstDir: 'desc' },
  { key: 'seatPct', label: 'Seat util.', firstDir: 'desc', numeric: true, seat: true },
  { key: 'meetings', label: 'Meetings', firstDir: 'desc', numeric: true }
];

function SortHeader({ column, sort, onSort }) {
  const active = sort.key === column.key;
  return (
    <th
      style={{ ...mfTableHeaderCell, textAlign: column.numeric ? 'right' : 'left' }}
      aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <button
        type="button"
        className="mf-shell-tab"
        onClick={() => onSort(column)}
        style={{
          font: 'inherit',
          letterSpacing: 'inherit',
          textTransform: 'inherit',
          color: active ? MF.ink.primary : MF.ink.muted,
          padding: 0,
          '--mf-focus-color': MF.util.base
        }}
      >
        {column.label}
        <span aria-hidden="true" style={{ display: 'inline-block', width: 12, marginLeft: 3 }}>
          {active ? (sort.dir === 'asc' ? '▲' : '▼') : ''}
        </span>
      </button>
    </th>
  );
}

export default function ClassroomUtilizationRoomsTab({ data, entry }) {
  const [building, setBuilding] = useState('');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState({ key: 'timePct', dir: 'desc' });

  const showSeat = hasSeatData(entry);
  const columns = COLUMNS.filter((c) => showSeat || !c.seat);
  const allRows = useMemo(() => roomRows(entry), [entry]);
  const buildings = useMemo(() => roomBuildingOptions(allRows), [allRows]);
  // A building picked for another term that isn't in this one reads as "All".
  const activeBuilding = buildings.includes(building) ? building : '';
  const rows = useMemo(
    () => sortRoomRows(filterRoomRows(allRows, { building: activeBuilding, query }), sort.key, sort.dir),
    [allRows, activeBuilding, query, sort]
  );

  const onSort = (column) => {
    setSort((prev) => (prev.key === column.key
      ? { key: column.key, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
      : { key: column.key, dir: column.firstDir }));
  };

  return (
    <MfGrid>
      <MfCol span={12}>
        <ChartCard title="Rooms" subtitle={`Every classroom scheduled in ${termDisplayLabel(data, data.selectedTermId)}`} autoHeight>
          {() => (
            <>
              <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12, marginBottom: 12 }}>
                <select
                  aria-label="Building"
                  value={activeBuilding}
                  onChange={(e) => setBuilding(e.target.value)}
                  style={{ ...mfInputStyle, minWidth: 180 }}
                >
                  <option value="">All buildings</option>
                  {buildings.map((b) => <option key={b} value={b}>{b}</option>)}
                </select>
                <input
                  type="search"
                  aria-label="Search rooms"
                  placeholder="Search rooms"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  style={{ ...mfInputStyle, minWidth: 180 }}
                />
                <span style={{ marginLeft: 'auto', fontSize: 12, color: MF.ink.secondary }}>{roomsSummaryLine(rows)}</span>
              </div>

              {rows.length ? (
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', background: MF.surface.page, fontFamily: MF.type.family }}>
                    <thead>
                      <tr>
                        {columns.map((c) => <SortHeader key={c.key} column={c} sort={sort} onSort={onSort} />)}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r) => (
                        <tr key={r.key}>
                          <td style={mfTableBodyCell}>{r.building}</td>
                          <td style={{ ...mfTableBodyCell, fontWeight: 600 }}>{r.room}</td>
                          <td style={numCell}>{r.capacity ?? '—'}</td>
                          <td style={numCell}>{r.hoursLabel}</td>
                          <td style={mfTableBodyCell}><UtilBar value={r.timePct} /></td>
                          {showSeat ? (
                            <td style={numCell}>{Number.isFinite(r.seatPct) ? `${Math.round(r.seatPct)}%` : '—'}</td>
                          ) : null}
                          <td style={numCell}>{r.meetings}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div style={{ fontSize: 12, color: MF.ink.muted }}>
                  {allRows.length ? 'No classrooms match these filters.' : NO_CLASSES_THIS_TERM}
                </div>
              )}
            </>
          )}
        </ChartCard>
      </MfCol>
    </MfGrid>
  );
}
