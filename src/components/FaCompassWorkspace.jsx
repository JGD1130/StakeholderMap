// src/components/FaCompassWorkspace.jsx
//
// The F&A Compass workspace, on the shared mf/ components: a workspace-size
// WorkspaceShell with Overview, Rooms and Method tabs.
//
// Pure presentation over the useResearchSpaceData result (`data`, mounted once
// in StakeholderMap.jsx) -- no fetching or writing here. Values, labels and
// orderings come from faCompassView.js. "Show on map" closes the workspace
// and uses StakeholderMap's floor jump; each room's floorplan is checked up
// front (resolveRoomFloor), so a room without one shows "No floorplan"
// instead of a button that would fail.
import React, { useEffect, useMemo, useState } from 'react';
import { MF } from '../theme/mfTokens';
import { WorkspaceShell, MfGrid, MfCol, KpiCard, ChartCard } from './mf';
import {
  mfOnBarButtonStyle,
  mfInputStyle,
  mfTableHeaderCell,
  mfTableBodyCell,
  mfSecondaryButtonStyle,
  mfPillStyle
} from './mf/mfStyles';
import { CategoryBars, StackedBars, ChartLegend } from './mf/charts';
import { RS_STATUS } from '../utils/researchSpaceStatus';
import {
  WORKSPACE_TITLE,
  workspaceSubtitle,
  overviewKpis,
  FUNCTION_CHART_TITLE,
  FUNCTION_CHART_EMPTY,
  functionChartSubtitle,
  functionChartRows,
  BUILDING_CHART_TITLE,
  BUILDING_CHART_SUBTITLE,
  BUILDING_LEGEND,
  buildingProgressRows,
  roomTableRows,
  buildingOptions,
  roomTypeOptions,
  STATUS_OPTIONS,
  filterRoomRows,
  roomSummaryLine,
  METHOD_INTRO,
  METHOD_STEPS,
  methodFunctionGroups,
  METHOD_RULES,
  METHOD_SCOPE
} from './faCompassView';

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'rooms', label: 'Rooms' },
  { id: 'method', label: 'Method' }
];

const emptyStyle = { fontSize: 12, color: MF.ink.muted, lineHeight: 1.45 };
const bodyText = { fontSize: 13, color: MF.ink.secondary, lineHeight: 1.55 };
const headerCell = mfTableHeaderCell;
const bodyCell = mfTableBodyCell;
const numCell = { ...bodyCell, textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' };
const filterLabel = { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600, color: MF.ink.muted };

function BarButton({ onClick, disabled, children }) {
  return (
    <button
      type="button"
      className="mf-shell-button"
      onClick={onClick}
      disabled={disabled}
      style={{ ...mfOnBarButtonStyle, ...(disabled ? { opacity: 0.55, cursor: 'default' } : null) }}
    >
      {children}
    </button>
  );
}

// --- Overview -------------------------------------------------------------------
function OverviewTab({ data }) {
  const functionRows = useMemo(() => functionChartRows(data), [data.rollup]);
  const buildingRows = useMemo(() => buildingProgressRows(data), [data.roomRows]);

  return (
    <MfGrid>
      {overviewKpis(data).map(({ key, ...props }) => (
        <MfCol key={key} span={3}>
          <KpiCard {...props} />
        </MfCol>
      ))}

      <MfCol span={12}>
        <ChartCard title={FUNCTION_CHART_TITLE} subtitle={functionRows ? functionChartSubtitle(data) : null} autoHeight>
          {({ width }) => (functionRows ? (
            <CategoryBars width={width} rows={functionRows} ariaLabel={FUNCTION_CHART_TITLE} />
          ) : (
            <div style={emptyStyle}>{FUNCTION_CHART_EMPTY}</div>
          ))}
        </ChartCard>
      </MfCol>

      <MfCol span={12}>
        <ChartCard title={BUILDING_CHART_TITLE} subtitle={BUILDING_CHART_SUBTITLE} autoHeight>
          {({ width }) => (buildingRows.length ? (
            <>
              <ChartLegend items={BUILDING_LEGEND} />
              <StackedBars width={width} rows={buildingRows} formatTick={(t) => String(t)} ariaLabel={BUILDING_CHART_TITLE} />
            </>
          ) : (
            <div style={emptyStyle}>No rooms in scope yet.</div>
          ))}
        </ChartCard>
      </MfCol>
    </MfGrid>
  );
}

// --- Rooms ------------------------------------------------------------------------
// roomKey -> floor id | null, resolved per room from the floorplan manifests.
// undefined while checking.
function useRoomFloors(roomRows, resolveRoomFloor) {
  const [floors, setFloors] = useState(() => new Map());
  useEffect(() => {
    if (typeof resolveRoomFloor !== 'function') return undefined;
    let cancelled = false;
    Promise.all(roomRows.map(async (r) => {
      try {
        return [r.roomKey, (await resolveRoomFloor(r)) || null];
      } catch {
        return [r.roomKey, null];
      }
    })).then((entries) => {
      if (!cancelled) setFloors(new Map(entries));
    });
    return () => { cancelled = true; };
  }, [roomRows, resolveRoomFloor]);
  return floors;
}

function statusPillStyle(status) {
  if (status === RS_STATUS.NOT_STARTED) {
    return { ...mfPillStyle, background: MF.status.warningBg, border: `1px solid ${MF.status.warningBorder}`, color: MF.status.warningText };
  }
  return { ...mfPillStyle, background: MF.surface.card, border: `1px solid ${MF.line.border}`, color: MF.ink.secondary };
}

function RoomsTab({ data, resolveRoomFloor, onShowOnMap }) {
  const allRows = useMemo(() => roomTableRows(data), [data.roomRows]);
  const buildings = useMemo(() => buildingOptions(data), [data.roomRows]);
  const roomTypes = useMemo(() => roomTypeOptions(data), [data.roomRows]);
  const floors = useRoomFloors(data.roomRows, resolveRoomFloor);
  const [search, setSearch] = useState('');
  const [building, setBuilding] = useState('');
  const [status, setStatus] = useState('');
  const [roomType, setRoomType] = useState('');
  const rows = useMemo(
    () => filterRoomRows(allRows, { search, building, status, roomType }),
    [allRows, search, building, status, roomType]
  );

  return (
    <ChartCard title="Rooms" subtitle={roomSummaryLine(rows)} autoHeight>
      {() => (
        <div>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, marginBottom: 10 }}>
            <input
              type="search"
              aria-label="Search rooms"
              placeholder="Search building, room or type"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{ ...mfInputStyle, flex: '1 1 220px', minWidth: 180 }}
            />
            <label style={filterLabel}>
              Building
              <select value={building} onChange={(e) => setBuilding(e.target.value)} style={mfInputStyle}>
                <option value="">All</option>
                {buildings.map((b) => <option key={b} value={b}>{b}</option>)}
              </select>
            </label>
            <label style={filterLabel}>
              Status
              <select value={status} onChange={(e) => setStatus(e.target.value)} style={mfInputStyle}>
                <option value="">All</option>
                {STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>
            <label style={filterLabel}>
              Room type
              <select value={roomType} onChange={(e) => setRoomType(e.target.value)} style={mfInputStyle}>
                <option value="">All</option>
                {roomTypes.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </label>
          </div>

          {rows.length ? (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', background: MF.surface.page, fontFamily: MF.type.family }}>
                <thead>
                  <tr>
                    <th style={headerCell}>Building</th>
                    <th style={headerCell}>Room</th>
                    <th style={headerCell}>Floor</th>
                    <th style={headerCell}>Type</th>
                    <th style={{ ...headerCell, textAlign: 'right' }}>SF</th>
                    <th style={headerCell}>Status</th>
                    <th style={{ ...headerCell, textAlign: 'right' }}>Occupants</th>
                    <th style={{ ...headerCell, textAlign: 'right' }}>OR %</th>
                    <th style={headerCell} aria-label="Map" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    const floorState = floors.get(row.key); // undefined = still checking
                    const canShow = Boolean(floorState);
                    return (
                      <tr key={row.key}>
                        <td style={bodyCell}>{row.building}</td>
                        <td style={{ ...bodyCell, fontWeight: 600 }}>{row.roomLabel}</td>
                        <td style={{ ...bodyCell, whiteSpace: 'nowrap' }}>{row.floorLabel}</td>
                        <td style={{ ...bodyCell, color: MF.ink.secondary }}>{row.roomType}</td>
                        <td style={numCell}>{row.sfLabel}</td>
                        <td style={bodyCell}><span style={statusPillStyle(row.status)}>{row.statusLabel}</span></td>
                        <td style={numCell}>{row.occupants || '—'}</td>
                        <td style={numCell}>{row.orLabel}</td>
                        <td style={{ ...bodyCell, whiteSpace: 'nowrap' }}>
                          <button
                            type="button"
                            className="mf-shell-button"
                            onClick={() => onShowOnMap(row.room)}
                            disabled={!canShow}
                            title={canShow ? 'Close the workspace and load this floor' : undefined}
                            style={{
                              ...mfSecondaryButtonStyle,
                              padding: '3px 10px',
                              '--mf-focus-color': MF.util.base,
                              ...(canShow ? null : { opacity: 0.55, cursor: 'default' })
                            }}
                          >
                            {canShow ? 'Show on map' : floorState === undefined ? 'Checking…' : 'No floorplan'}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <div style={emptyStyle}>No rooms match these filters.</div>
          )}
        </div>
      )}
    </ChartCard>
  );
}

// --- Method -----------------------------------------------------------------------
function MethodTab() {
  const groups = methodFunctionGroups();
  return (
    <MfGrid>
      <MfCol span={12}>
        <ChartCard title="How F&A Compass classifies space" autoHeight>
          {() => (
            <div>
              <p style={{ ...bodyText, margin: '0 0 12px' }}>{METHOD_INTRO}</p>
              <ol style={{ margin: 0, paddingLeft: 20 }}>
                {METHOD_STEPS.map((step) => (
                  <li key={step.title} style={{ ...bodyText, marginBottom: 8 }}>
                    <span style={{ fontWeight: 600, color: MF.ink.primary }}>{step.title}.</span> {step.text}
                  </li>
                ))}
              </ol>
            </div>
          )}
        </ChartCard>
      </MfCol>

      {groups.map((group) => (
        <MfCol key={group.key} span={6}>
          <ChartCard title={group.title} autoHeight>
            {() => (
              <dl style={{ margin: 0 }}>
                {group.items.map((item) => (
                  <div key={item.key} style={{ marginBottom: 10 }}>
                    <dt style={{ fontSize: 13, fontWeight: 600, color: MF.ink.primary }}>{item.label}</dt>
                    <dd style={{ ...bodyText, margin: '2px 0 0' }}>{item.text}</dd>
                  </div>
                ))}
              </dl>
            )}
          </ChartCard>
        </MfCol>
      ))}

      <MfCol span={6}>
        <ChartCard title="Rules" autoHeight>
          {() => (
            <ul style={{ margin: 0, paddingLeft: 20 }}>
              {METHOD_RULES.map((rule) => <li key={rule} style={{ ...bodyText, marginBottom: 6 }}>{rule}</li>)}
            </ul>
          )}
        </ChartCard>
      </MfCol>
      <MfCol span={6}>
        <ChartCard title="Which rooms are included" autoHeight>
          {() => <p style={{ ...bodyText, margin: 0 }}>{METHOD_SCOPE}</p>}
        </ChartCard>
      </MfCol>
    </MfGrid>
  );
}

// --- Shell --------------------------------------------------------------------
// onJumpToFloor(room): StakeholderMap's floor jump. resolveRoomFloor(room) ->
// Promise<floor id | null>: whether that room's floor has a floorplan.
export default function FaCompassWorkspace({ data, universityName, onJumpToFloor, resolveRoomFloor, onClose }) {
  const [activeTab, setActiveTab] = useState('overview');
  const loading = data.scopeRooms === null;

  const handleShowOnMap = (room) => {
    onClose();
    onJumpToFloor?.(room);
  };

  let body;
  if (activeTab === 'method') {
    body = <MethodTab />;
  } else if (loading) {
    body = <div style={emptyStyle}>Loading the room inventory…</div>;
  } else if (activeTab === 'rooms') {
    body = <RoomsTab data={data} resolveRoomFloor={resolveRoomFloor} onShowOnMap={handleShowOnMap} />;
  } else {
    body = <OverviewTab data={data} />;
  }

  return (
    <WorkspaceShell
      size="workspace"
      title={WORKSPACE_TITLE}
      subtitle={workspaceSubtitle(universityName)}
      actions={data.airtableError && typeof data.reload === 'function'
        ? <BarButton onClick={data.reload}>Retry</BarButton>
        : null}
      tabs={TABS}
      activeTab={activeTab}
      onTabChange={setActiveTab}
      onClose={onClose}
    >
      {data.loadError || data.airtableError ? (
        <div role="alert" style={{ marginBottom: 12, fontSize: 12, color: MF.status.error }}>{data.loadError || data.airtableError}</div>
      ) : null}
      {body}
    </WorkspaceShell>
  );
}
