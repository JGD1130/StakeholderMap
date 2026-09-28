// src/components/ClassroomUtilizationWorkspace.jsx
//
// The Classroom Utilization workspace, on the shared mf/ components: a
// workspace-size WorkspaceShell (Recalculate in the title bar), Overview /
// Heat Map / Rooms / Setup tabs, and a Term picker at the right end of the tab
// row. Every tab but Setup shows the selected term only; Setup (admin tools:
// schedule import, terms, data quality) lives in ClassroomUtilizationSetupTab.jsx
// and hides the picker.
//
// Pure presentation over the useClassroomUtilizationData result (`data`,
// mounted once in StakeholderMap.jsx) -- no fetching here, so opening and
// reopening is instant. Values, labels and sort orders come from
// classroomUtilizationView.js; the room size chart uses the Executive
// Dashboard's own executiveDashboardView.js functions so the two match.

import React, { useMemo, useState } from 'react';
import { MF } from '../theme/mfTokens';
import { WorkspaceShell, MfGrid, MfCol, KpiCard, ChartCard, Gauge } from './mf';
import { mfOnBarButtonStyle, mfInputStyle, mfTableHeaderCell, mfTableBodyCell } from './mf/mfStyles';
import { HBarChart, UtilBar, HeatmapGrid, HeatmapLegend } from './mf/charts';
import {
  ROOM_SIZE_TITLE,
  ROOM_SIZE_EMPTY,
  hasRoomSizeBars,
  roomSizeSubtitle,
  roomSizeRows,
  roomSizeFootnote
} from './executiveDashboardView';
import {
  WORKSPACE_TITLE,
  termOptions,
  termDisplayLabel,
  workspaceSubtitle,
  standardWeeklyHours,
  selectedTermEntry,
  noTermDataMessage,
  overviewKpis,
  hasSeatData,
  GAUGE_TITLE,
  gaugeSubtitle,
  gaugeValue,
  sizeRangeTableForTerm,
  BUILDING_TITLE,
  buildingRows,
  HEATMAP_TITLE,
  HEATMAP_SUBTITLE,
  HEATMAP_LEGEND_LABEL,
  NO_CLASSES_THIS_TERM,
  heatmapFootnote,
  heatmapModel
} from './classroomUtilizationView';
import ClassroomUtilizationRoomsTab from './ClassroomUtilizationRoomsTab.jsx';
import ClassroomUtilizationSetupTab from './ClassroomUtilizationSetupTab.jsx';

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'heatmap', label: 'Heat Map' },
  { id: 'rooms', label: 'Rooms' },
  { id: 'setup', label: 'Setup' }
];

const emptyStyle = { fontSize: 12, color: MF.ink.muted };

// --- Title bar / tab row controls ---------------------------------------------
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

function TermPicker({ data }) {
  const options = termOptions(data);
  if (!options.length) return null;
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, fontWeight: 600, color: MF.ink.muted }}>
      Term
      <select
        value={data.selectedTermId || ''}
        onChange={(e) => data.setSelectedTermId(e.target.value)}
        style={mfInputStyle}
      >
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </label>
  );
}

// --- Overview -------------------------------------------------------------------
const headerCell = mfTableHeaderCell;
const bodyCell = mfTableBodyCell;
const numCell = { ...bodyCell, textAlign: 'right', fontVariantNumeric: 'tabular-nums' };

function BuildingTable({ rows, showSeat }) {
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', background: MF.surface.page, fontFamily: MF.type.family }}>
      <thead>
        <tr>
          <th style={headerCell}>Building</th>
          <th style={{ ...headerCell, textAlign: 'right' }}>Classrooms</th>
          <th style={{ ...headerCell, textAlign: 'right' }}>Hours/wk</th>
          <th style={headerCell}>Time util.</th>
          {showSeat ? <th style={{ ...headerCell, textAlign: 'right' }}>Seat util.</th> : null}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.key}>
            <td style={{ ...bodyCell, fontWeight: 600 }}>{row.building}</td>
            <td style={numCell}>{row.roomCount}</td>
            <td style={numCell}>{row.hoursLabel}</td>
            <td style={bodyCell}><UtilBar value={row.timePct} /></td>
            {showSeat ? <td style={numCell}>{row.seatLabel}</td> : null}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function OverviewTab({ data, entry }) {
  const weekHours = standardWeeklyHours(data, data.selectedTermId);
  const sizeTable = useMemo(() => sizeRangeTableForTerm(entry), [entry]);
  const hasBars = hasRoomSizeBars(sizeTable);
  const buildings = useMemo(() => buildingRows(entry), [entry]);
  const isCurrent = data.selectedTermId === data.currentTermId;

  return (
    <MfGrid>
      {overviewKpis(entry, weekHours).map(({ key, ...props }) => (
        <MfCol key={key} span={3}>
          <KpiCard {...props} />
        </MfCol>
      ))}

      <MfCol span={5}>
        <ChartCard title={GAUGE_TITLE} subtitle={gaugeSubtitle(weekHours)} autoHeight>
          {() => (
            <div style={{ display: 'flex', justifyContent: 'center' }}>
              <div style={{ flex: '0 1 240px', minWidth: 200 }}>
                <Gauge
                  value={gaugeValue(entry)}
                  title={termDisplayLabel(data, data.selectedTermId)}
                  pill={isCurrent ? 'Current' : undefined}
                />
              </div>
            </div>
          )}
        </ChartCard>
      </MfCol>
      <MfCol span={7}>
        <ChartCard
          title={ROOM_SIZE_TITLE}
          subtitle={roomSizeSubtitle(sizeTable)}
          footnote={hasBars ? roomSizeFootnote(sizeTable) : null}
          autoHeight
        >
          {({ width }) => (hasBars ? (
            <HBarChart
              width={width}
              rows={roomSizeRows(sizeTable)}
              target={MF.util.target}
              color={MF.util.base}
              ariaLabel={roomSizeSubtitle(sizeTable)}
            />
          ) : (
            <div style={emptyStyle}>{ROOM_SIZE_EMPTY}</div>
          ))}
        </ChartCard>
      </MfCol>

      <MfCol span={12}>
        <ChartCard title={BUILDING_TITLE} autoHeight>
          {() => (buildings.length ? <BuildingTable rows={buildings} showSeat={hasSeatData(entry)} /> : <div style={emptyStyle}>{NO_CLASSES_THIS_TERM}</div>)}
        </ChartCard>
      </MfCol>
    </MfGrid>
  );
}

// --- Heat Map -------------------------------------------------------------------
function HeatmapTab({ entry }) {
  const model = useMemo(() => heatmapModel(entry?.heatmap), [entry]);
  return (
    <MfGrid>
      <MfCol span={12}>
        <ChartCard
          title={HEATMAP_TITLE}
          subtitle={HEATMAP_SUBTITLE}
          footnote={model ? heatmapFootnote(entry.outsideHeatmapCount) : null}
          autoHeight
        >
          {() => (model ? (
            <>
              <div style={{ marginBottom: 12 }}>
                <HeatmapLegend label={HEATMAP_LEGEND_LABEL} />
              </div>
              <HeatmapGrid columns={model.columns} rows={model.rows} ariaLabel={model.ariaLabel} />
            </>
          ) : (
            <div style={emptyStyle}>{NO_CLASSES_THIS_TERM}</div>
          ))}
        </ChartCard>
      </MfCol>
    </MfGrid>
  );
}

// --- Shell --------------------------------------------------------------------
export default function ClassroomUtilizationWorkspace({ data, onClose }) {
  const [activeTab, setActiveTab] = useState('overview');
  const loading = data.status === 'loading';
  const entry = selectedTermEntry(data);

  const actions = (
    <BarButton onClick={() => void data.recalculate()} disabled={loading}>
      {loading ? 'Calculating…' : 'Recalculate'}
    </BarButton>
  );

  let body;
  if (activeTab === 'setup') {
    body = <ClassroomUtilizationSetupTab data={data} />;
  } else if (!data.results) {
    body = <div style={emptyStyle}>{loading ? 'Calculating…' : 'No utilization data loaded.'}</div>;
  } else if (!entry) {
    body = <div style={emptyStyle}>{noTermDataMessage(data)}</div>;
  } else if (activeTab === 'heatmap') {
    body = <HeatmapTab entry={entry} />;
  } else if (activeTab === 'rooms') {
    body = <ClassroomUtilizationRoomsTab data={data} entry={entry} />;
  } else {
    body = <OverviewTab data={data} entry={entry} />;
  }

  return (
    <WorkspaceShell
      size="workspace"
      title={WORKSPACE_TITLE}
      subtitle={workspaceSubtitle(data)}
      actions={actions}
      tabs={TABS}
      activeTab={activeTab}
      onTabChange={setActiveTab}
      tabsEnd={activeTab === 'setup' ? null : <TermPicker data={data} />}
      onClose={onClose}
    >
      {data.status === 'error' && data.error ? (
        <div role="alert" style={{ marginBottom: 12, fontSize: 12, color: MF.status.error }}>{data.error}</div>
      ) : null}
      {body}
    </WorkspaceShell>
  );
}
