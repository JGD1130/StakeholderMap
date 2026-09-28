// src/components/CapitalCompassDeferredTab.jsx
//
// Deferred Maintenance tab of the Capital Compass workspace, from the uploaded
// deferred maintenance data: four totals, a stacked bar per building (0–5 yr
// + 6–10 yr, 0–5 yr high to low) and a table. Values come from
// capitalCompassView.js.
import React, { useMemo } from 'react';
import { MF } from '../theme/mfTokens';
import { MfGrid, MfCol, KpiCard, ChartCard } from './mf';
import { mfTableHeaderCell, mfTableBodyCell } from './mf/mfStyles';
import { StackedBars, ChartLegend } from './mf/charts';
import {
  deferredKpis,
  deferredStackRows,
  deferredTableRows,
  DM_SEGMENTS,
  DM_FOOTNOTE,
  formatUsdAxis
} from './capitalCompassView';

const numCell = { ...mfTableBodyCell, textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' };
const numHead = { ...mfTableHeaderCell, textAlign: 'right' };
const emptyStyle = { fontSize: 12, color: MF.ink.muted };
const EMPTY = 'No deferred maintenance uploaded yet — add it on the Setup tab.';

export default function CapitalCompassDeferredTab({ data }) {
  const stackRows = useMemo(() => deferredStackRows(data), [data]);
  const tableRows = useMemo(() => deferredTableRows(data), [data]);

  return (
    <MfGrid>
      {deferredKpis(data).map(({ key, ...props }) => (
        <MfCol key={key} span={3}>
          <KpiCard {...props} />
        </MfCol>
      ))}

      <MfCol span={12}>
        <ChartCard
          title="Deferred Maintenance by Building"
          subtitle="Project cost, 0–5 yr and 6–10 yr, highest 0–5 yr first"
          footnote={stackRows.length ? DM_FOOTNOTE : null}
          autoHeight
        >
          {({ width }) => (stackRows.length ? (
            <>
              <ChartLegend items={DM_SEGMENTS.map((s) => ({ key: s.key, label: s.label, color: s.color }))} />
              <StackedBars width={width} rows={stackRows} formatTick={formatUsdAxis} ariaLabel="Deferred maintenance by building, 0–5 year and 6–10 year" />
            </>
          ) : (
            <div style={emptyStyle}>{EMPTY}</div>
          ))}
        </ChartCard>
      </MfCol>

      <MfCol span={12}>
        <ChartCard title="Buildings" footnote={tableRows.length ? DM_FOOTNOTE : null} autoHeight>
          {() => (tableRows.length ? (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', background: MF.surface.page, fontFamily: MF.type.family }}>
                <thead>
                  <tr>
                    <th style={mfTableHeaderCell}>Building</th>
                    <th style={numHead}>0–5 yr</th>
                    <th style={numHead}>6–10 yr</th>
                    <th style={numHead}>Demolition</th>
                    <th style={numHead}>Renovation</th>
                    <th style={numHead}>$/SF</th>
                  </tr>
                </thead>
                <tbody>
                  {tableRows.map((r) => (
                    <tr key={r.key}>
                      <td style={{ ...mfTableBodyCell, fontWeight: 600 }}>{r.building}</td>
                      <td style={numCell}>{r.dm05}</td>
                      <td style={numCell}>{r.dm610}</td>
                      <td style={numCell}>{r.demolition}</td>
                      <td style={numCell}>{r.renovation}</td>
                      <td style={numCell}>{r.perSf}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div style={emptyStyle}>{EMPTY}</div>
          ))}
        </ChartCard>
      </MfCol>
    </MfGrid>
  );
}
