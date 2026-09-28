// src/components/CapitalCompassPhasingTab.jsx
//
// Phasing tab of the Capital Compass workspace: four KPIs, the phasing
// timeline for ALL projects (the Executive Dashboard shows only near-term
// ones), and a project table. Values come from capitalCompassView.js.
import React, { useMemo } from 'react';
import { MF } from '../theme/mfTokens';
import { MfGrid, MfCol, KpiCard, ChartCard } from './mf';
import { mfTableHeaderCell, mfTableBodyCell } from './mf/mfStyles';
import { PhasingTimeline, ChartLegend } from './mf/charts';
import {
  phasingKpis,
  phasingTimelineModel,
  PHASING_SUBTITLE,
  phasingFootnote,
  phasingTableRows
} from './capitalCompassView';

const numCell = { ...mfTableBodyCell, textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' };
const emptyStyle = { fontSize: 12, color: MF.ink.muted };

export default function CapitalCompassPhasingTab({ data }) {
  const timeline = useMemo(() => phasingTimelineModel(data), [data]);
  const tableRows = useMemo(() => phasingTableRows(data), [data]);

  return (
    <MfGrid>
      {phasingKpis(data).map(({ key, ...props }) => (
        <MfCol key={key} span={3}>
          <KpiCard {...props} />
        </MfCol>
      ))}

      <MfCol span={12}>
        <ChartCard title="Capital Phasing" subtitle={PHASING_SUBTITLE} footnote={phasingFootnote(timeline.unschedulable)} autoHeight>
          {({ width }) => (timeline.rows.length ? (
            <>
              <ChartLegend items={timeline.legend} />
              <PhasingTimeline width={width} rows={timeline.rows} range={timeline.range} ariaLabel="Capital phasing timeline, all projects" />
            </>
          ) : (
            <div style={emptyStyle}>No phasing uploaded yet — add it on the Setup tab.</div>
          ))}
        </ChartCard>
      </MfCol>

      <MfCol span={12}>
        <ChartCard title="Projects" autoHeight>
          {() => (tableRows.length ? (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', background: MF.surface.page, fontFamily: MF.type.family }}>
                <thead>
                  <tr>
                    <th style={mfTableHeaderCell}>Project</th>
                    <th style={mfTableHeaderCell}>Building</th>
                    <th style={mfTableHeaderCell}>Type</th>
                    <th style={mfTableHeaderCell}>Completion</th>
                    <th style={{ ...mfTableHeaderCell, textAlign: 'right' }}>Cost (2026 $)</th>
                    <th style={{ ...mfTableHeaderCell, textAlign: 'right' }}>Escalated</th>
                    <th style={mfTableHeaderCell}>Phases</th>
                  </tr>
                </thead>
                <tbody>
                  {tableRows.map((r) => (
                    <tr key={r.key}>
                      <td style={{ ...mfTableBodyCell, fontWeight: 600 }}>{r.project}</td>
                      <td style={mfTableBodyCell}>{r.building}</td>
                      <td style={{ ...mfTableBodyCell, whiteSpace: 'nowrap' }}>
                        <span aria-hidden="true" style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 2, background: r.typeColor, marginRight: 6, verticalAlign: '-1px' }} />
                        {r.typeLabel}
                      </td>
                      <td style={{ ...mfTableBodyCell, whiteSpace: 'nowrap' }}>{r.completion}</td>
                      <td style={numCell}>{r.cost}</td>
                      <td style={numCell}>{r.escalated}</td>
                      <td style={{ ...mfTableBodyCell, color: MF.ink.secondary }}>{r.phases}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div style={emptyStyle}>No phasing uploaded yet — add it on the Setup tab.</div>
          ))}
        </ChartCard>
      </MfCol>
    </MfGrid>
  );
}
