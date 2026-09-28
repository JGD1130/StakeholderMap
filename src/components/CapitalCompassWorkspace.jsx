// src/components/CapitalCompassWorkspace.jsx
//
// The Capital Compass workspace, on the shared mf/ components: a
// workspace-size WorkspaceShell (Refresh in the title bar) with Overview,
// Budget, Phasing, Deferred Maintenance and Setup tabs. Pure presentation over the useCapitalCompassData result
// (`data`, mounted once in StakeholderMap.jsx) -- no fetching here; Refresh
// calls the hook's reload(). Values, labels and orderings come from
// capitalCompassView.js; tiers are always MF.tier[1-4].
import React, { useMemo, useState } from 'react';
import { MF } from '../theme/mfTokens';
import { WorkspaceShell, MfGrid, MfCol, KpiCard, ChartCard } from './mf';
import { mfOnBarButtonStyle, mfTableHeaderCell, mfTableBodyCell } from './mf/mfStyles';
import { CategoryBars } from './mf/charts';
import {
  WORKSPACE_TITLE,
  workspaceSubtitle,
  overviewKpis,
  tierCountRows,
  tierCostRows,
  TIER_COST_FOOTNOTE,
  rankingRows,
  RANKING_FOOTNOTE
} from './capitalCompassView';
import CapitalCompassBudgetTab from './CapitalCompassBudgetTab.jsx';
import CapitalCompassPhasingTab from './CapitalCompassPhasingTab.jsx';
import CapitalCompassDeferredTab from './CapitalCompassDeferredTab.jsx';
import CapitalCompassSetupTab from './CapitalCompassSetupTab.jsx';

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'budget', label: 'Budget' },
  { id: 'phasing', label: 'Phasing' },
  { id: 'deferred', label: 'Deferred Maintenance' },
  { id: 'setup', label: 'Setup' }
];

const emptyStyle = { fontSize: 12, color: MF.ink.muted };
const numCell = { ...mfTableBodyCell, textAlign: 'right', fontVariantNumeric: 'tabular-nums' };

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

function TierSwatch({ color }) {
  return <span aria-hidden="true" style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 2, background: color, marginRight: 6, verticalAlign: '-1px' }} />;
}

function ScoreBar({ value, max = 100, color, width = 72 }) {
  const fill = Math.max(0, Math.min(1, (Number(value) || 0) / max)) * 100;
  return (
    <span aria-hidden="true" style={{ position: 'relative', display: 'inline-block', width, height: 6, borderRadius: 3, background: MF.line.hairline, overflow: 'hidden', verticalAlign: 'middle' }}>
      <span style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${fill}%`, background: color }} />
    </span>
  );
}

// The open-book score: every criterion's points, a thin bar, and the chosen
// level's description.
function ScoreBreakdown({ row }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(160px, 1fr) 64px 80px minmax(200px, 3fr)', columnGap: 12, rowGap: 8, alignItems: 'center', padding: '8px 4px 4px' }}>
      {row.breakdown.map((c) => (
        <React.Fragment key={c.key}>
          <span style={{ fontSize: 12, fontWeight: 600, color: MF.ink.primary }}>{c.label}</span>
          <span style={{ fontSize: 12, color: MF.ink.primary, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
            {c.points == null ? '—' : c.points} / {c.max}
          </span>
          <ScoreBar value={c.points} max={c.max} color={row.color} width={80} />
          <span style={{ fontSize: 12, color: MF.ink.secondary, lineHeight: 1.4 }}>
            <span style={{ fontWeight: 600 }}>{c.levelLabel}</span>
            {c.desc ? ` — ${c.desc}` : ''}
          </span>
        </React.Fragment>
      ))}
    </div>
  );
}

function RankingTable({ rows }) {
  const [expandedKey, setExpandedKey] = useState(null);
  const columnCount = 7;
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', background: MF.surface.page, fontFamily: MF.type.family }}>
        <thead>
          <tr>
            <th style={{ ...mfTableHeaderCell, width: 44 }}>Rank</th>
            <th style={mfTableHeaderCell}>Building</th>
            <th style={mfTableHeaderCell}>Tier</th>
            <th style={mfTableHeaderCell}>Score</th>
            <th style={mfTableHeaderCell}>Horizon</th>
            <th style={{ ...mfTableHeaderCell, textAlign: 'right' }}>Est. cost</th>
            <th style={{ ...mfTableHeaderCell, textAlign: 'right' }}>Updated</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const open = expandedKey === row.key;
            const toggle = () => setExpandedKey(open ? null : row.key);
            return (
              <React.Fragment key={row.key}>
                <tr onClick={toggle} style={{ cursor: 'pointer', background: open ? MF.surface.card : undefined }}>
                  <td style={{ ...mfTableBodyCell, color: MF.ink.muted }}>{row.rank}</td>
                  <td style={mfTableBodyCell}>
                    <button
                      type="button"
                      className="mf-shell-tab"
                      aria-expanded={open}
                      onClick={(e) => { e.stopPropagation(); toggle(); }}
                      style={{ padding: 0, fontSize: 12, fontWeight: 600, color: MF.ink.primary, textAlign: 'left', '--mf-focus-color': MF.util.base }}
                    >
                      <span aria-hidden="true" style={{ display: 'inline-block', width: 12, color: MF.ink.muted }}>{open ? '▾' : '▸'}</span>
                      {row.name}
                    </button>
                  </td>
                  <td style={{ ...mfTableBodyCell, whiteSpace: 'nowrap' }}><TierSwatch color={row.color} />{row.tierLabel}</td>
                  <td style={{ ...mfTableBodyCell, whiteSpace: 'nowrap' }}>
                    <ScoreBar value={row.score} color={row.color} />
                    <span style={{ marginLeft: 8, fontVariantNumeric: 'tabular-nums' }}>{row.score}</span>
                  </td>
                  <td style={{ ...mfTableBodyCell, color: MF.ink.secondary }}>{row.horizon}</td>
                  <td style={numCell}>
                    {row.costLabel}
                    {row.sourceTag ? <div style={{ fontSize: 11, color: MF.ink.muted }}>{row.sourceTag}</div> : null}
                  </td>
                  <td style={{ ...numCell, color: MF.ink.secondary, whiteSpace: 'nowrap' }}>{row.updated}</td>
                </tr>
                {open ? (
                  <tr style={{ background: MF.surface.card }}>
                    <td colSpan={columnCount} style={{ ...mfTableBodyCell, paddingTop: 0 }}>
                      <ScoreBreakdown row={row} />
                    </td>
                  </tr>
                ) : null}
              </React.Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function OverviewTab({ data, mapBuildingCount }) {
  const countRows = useMemo(() => tierCountRows(data), [data]);
  const costRows = useMemo(() => tierCostRows(data), [data]);
  const ranking = useMemo(() => rankingRows(data), [data]);

  return (
    <MfGrid>
      {overviewKpis(data, mapBuildingCount).map(({ key, ...props }) => (
        <MfCol key={key} span={3}>
          <KpiCard {...props} />
        </MfCol>
      ))}

      <MfCol span={6}>
        <ChartCard title="Buildings by Tier" subtitle="Scored buildings in each priority tier" autoHeight>
          {({ width }) => <CategoryBars width={width} rows={countRows} ariaLabel="Scored buildings by priority tier" />}
        </ChartCard>
      </MfCol>
      <MfCol span={6}>
        <ChartCard title="Cost by Tier" subtitle="Estimated cost of the scored buildings in each tier" footnote={TIER_COST_FOOTNOTE} autoHeight>
          {({ width }) => <CategoryBars width={width} rows={costRows} ariaLabel="Estimated cost by priority tier" />}
        </ChartCard>
      </MfCol>

      <MfCol span={12}>
        <ChartCard title="Priority Ranking" subtitle="Click a building to see how its score adds up" footnote={RANKING_FOOTNOTE} autoHeight>
          {() => (ranking.length ? <RankingTable rows={ranking} /> : <div style={emptyStyle}>No buildings scored yet.</div>)}
        </ChartCard>
      </MfCol>
    </MfGrid>
  );
}

// buildingNames: every building on the map (for scoring and the deferred
// maintenance name match). getBuildingResourceEntry: building-resources.json
// lookup, for the scoring suggestions.
export default function CapitalCompassWorkspace({ data, buildingNames = [], getBuildingResourceEntry = null, onClose }) {
  const mapBuildingCount = buildingNames.length;
  const [activeTab, setActiveTab] = useState('overview');
  const loading = data.status === 'loading';

  return (
    <WorkspaceShell
      size="workspace"
      title={WORKSPACE_TITLE}
      subtitle={workspaceSubtitle(data, mapBuildingCount)}
      actions={(
        <BarButton onClick={() => void data.reload()} disabled={loading}>
          {loading ? 'Refreshing…' : 'Refresh'}
        </BarButton>
      )}
      tabs={TABS}
      activeTab={activeTab}
      onTabChange={setActiveTab}
      onClose={onClose}
    >
      {data.status === 'error' && data.error ? (
        <div role="alert" style={{ marginBottom: 12, fontSize: 12, color: MF.status.error }}>{data.error}</div>
      ) : null}
      {activeTab === 'budget' ? <CapitalCompassBudgetTab data={data} /> : null}
      {activeTab === 'phasing' ? <CapitalCompassPhasingTab data={data} /> : null}
      {activeTab === 'deferred' ? <CapitalCompassDeferredTab data={data} /> : null}
      {activeTab === 'setup' ? (
        <CapitalCompassSetupTab data={data} buildingNames={buildingNames} getBuildingResourceEntry={getBuildingResourceEntry} />
      ) : null}
      {activeTab === 'overview' ? <OverviewTab data={data} mapBuildingCount={mapBuildingCount} /> : null}
    </WorkspaceShell>
  );
}
