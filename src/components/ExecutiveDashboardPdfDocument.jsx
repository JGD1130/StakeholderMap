// src/components/ExecutiveDashboardPdfDocument.jsx
//
// Executive Dashboard PDF: US Letter landscape, two pages, same content and
// order as the screen (ExecutiveDashboardModal.jsx).
//   Page 1: KPI row · Classroom Time Utilization gauges + Utilization by Room
//           Size · Space Gap by Division + Capital Compass Tier 1 table
//   Page 2: Capital Phasing timeline, full width
// Each page: an orange header band (title + "Hastings College · as of <date>")
// and a footer ("Prepared by Clark & Enersen · Mapfluence" / "Page N of M").
//
// Every value, label, sort order and footnote comes from
// executiveDashboardView.js -- the same builders the screen uses -- and the
// charts are the react-pdf versions in mf/pdf/ (gauge geometry shared with
// the screen via computeGaugeGeometry). Colors come only from mfTokens.
// Text is at least 9pt; only the footer uses 8pt.

import React from 'react';
import { Document, Page, View, Text, StyleSheet } from '@react-pdf/renderer';
import { getPhasingAxisRange } from '../utils/executiveDashboardCalc';
import { INDUSTRY_TARGET_TIME_UTILIZATION } from '../utils/classroomUtilizationCalc';
import { MF } from '../theme/mfTokens';
import {
  PdfChartCard,
  PdfKpiCard,
  PdfLegend,
  PdfMutedLine,
  PdfGauge,
  PdfHBarChart,
  PdfDivergingBars,
  PdfScoreTable,
  PdfPhasingTimeline,
  PDF_FONT,
  PDF_FONT_BOLD
} from './mf/pdf';
import {
  dashboardSubtitle,
  formatSignedSf,
  kpiModels,
  UTILIZATION_TITLE,
  UTILIZATION_SUBTITLE,
  gaugeSection,
  ROOM_SIZE_TITLE,
  ROOM_SIZE_EMPTY,
  pickSizeRangeTable,
  hasRoomSizeBars,
  roomSizeSubtitle,
  roomSizeRows,
  roomSizeFootnote,
  SPACE_GAP_TITLE,
  spaceGapSubtitle,
  spaceGapEmptyMessage,
  spaceGapRows,
  spaceGapFootnote,
  TIER1_TITLE,
  TIER1_FOOTNOTE,
  TIER1_EMPTY,
  tier1Rows,
  PHASING_SUBTITLE,
  PHASING_EMPTY,
  phasingTitle,
  phasingRows,
  phasingLegendItems
} from './executiveDashboardView';

// Letter landscape in points.
const PAGE_HEIGHT = 612;
const MARGIN_X = 28;
const CONTENT_WIDTH = 792 - MARGIN_X * 2; // 736
const HEADER_HEIGHT = 44;
const PAGE_TOP = HEADER_HEIGHT + 12;
const PAGE_BOTTOM = 34;
const GAP = 8;
const CARD_CHROME = 22; // card padding + border, left + right

const styles = StyleSheet.create({
  page: {
    paddingTop: PAGE_TOP,
    paddingBottom: PAGE_BOTTOM,
    paddingHorizontal: MARGIN_X,
    fontFamily: PDF_FONT,
    fontSize: 9,
    color: MF.ink.primary,
    backgroundColor: MF.surface.page
  },
  header: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: HEADER_HEIGHT,
    paddingHorizontal: MARGIN_X,
    justifyContent: 'center',
    backgroundColor: MF.brand.headerOrange
  },
  footer: {
    position: 'absolute',
    bottom: 14,
    left: MARGIN_X,
    right: MARGIN_X,
    flexDirection: 'row',
    justifyContent: 'space-between'
  },
  footerText: { fontSize: 8, color: MF.ink.muted },
  row: { flexDirection: 'row', marginBottom: GAP }
});

function PageChrome({ subtitle }) {
  return (
    <>
      <View style={styles.header} fixed>
        <Text style={{ fontFamily: PDF_FONT_BOLD, fontSize: 14, color: MF.surface.page }}>Executive Dashboard</Text>
        <Text style={{ fontSize: 9, color: MF.surface.page, opacity: 0.85, marginTop: 2 }}>{subtitle}</Text>
      </View>
      <View style={styles.footer} fixed>
        <Text style={styles.footerText}>{'Prepared by Clark & Enersen · Mapfluence'}</Text>
        <Text style={styles.footerText} render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`} />
      </View>
    </>
  );
}

// --- Page 1 -------------------------------------------------------------------
function KpiRow({ data }) {
  const width = (CONTENT_WIDTH - GAP * 3) / 4;
  return (
    <View style={styles.row} wrap={false}>
      {kpiModels(data).map(({ key, ...props }, i) => (
        <View key={key} style={{ marginLeft: i ? GAP : 0 }}>
          <PdfKpiCard {...props} width={width} />
        </View>
      ))}
    </View>
  );
}

function GaugesCard({ data, width, style }) {
  const section = gaugeSection(data);
  const inner = width - CARD_CHROME;
  const gaugeWidth = section.gauges ? Math.min(160, (inner - 12 * (section.gauges.length - 1)) / section.gauges.length) : 0;
  return (
    <PdfChartCard title={UTILIZATION_TITLE} subtitle={UTILIZATION_SUBTITLE} width={width} style={style}>
      {section.message ? (
        <PdfMutedLine>{section.message}</PdfMutedLine>
      ) : (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
          {section.gauges.map((g, i) => (
            <View key={g.key} style={{ marginLeft: i ? 12 : 0 }}>
              <PdfGauge width={gaugeWidth} value={g.value} title={g.title} pill={g.pill} />
            </View>
          ))}
        </View>
      )}
    </PdfChartCard>
  );
}

function RoomSizeCard({ data, width, style }) {
  const table = pickSizeRangeTable(data);
  const hasBars = hasRoomSizeBars(table);
  return (
    <PdfChartCard
      title={ROOM_SIZE_TITLE}
      subtitle={roomSizeSubtitle(table)}
      footnote={hasBars ? roomSizeFootnote(table) : null}
      width={width}
      style={style}
    >
      {hasBars ? (
        <PdfHBarChart width={width - CARD_CHROME} rows={roomSizeRows(table)} target={INDUSTRY_TARGET_TIME_UTILIZATION} color={MF.util.base} />
      ) : (
        <PdfMutedLine>{ROOM_SIZE_EMPTY}</PdfMutedLine>
      )}
    </PdfChartCard>
  );
}

function SpaceGapCard({ data, width, style }) {
  const hasBuckets = data.spaceGapBuckets.length > 0;
  return (
    <PdfChartCard
      title={SPACE_GAP_TITLE}
      subtitle={spaceGapSubtitle(data)}
      footnote={hasBuckets ? spaceGapFootnote(data) : null}
      width={width}
      style={style}
    >
      {hasBuckets ? (
        <>
          <PdfLegend
            items={[
              { key: 'deficit', label: 'Deficit', color: MF.diverging.deficit },
              { key: 'surplus', label: 'Surplus', color: MF.diverging.surplus }
            ]}
          />
          <PdfDivergingBars width={width - CARD_CHROME} rows={spaceGapRows(data.spaceGapBuckets, data.targetYear)} formatValue={formatSignedSf} />
        </>
      ) : (
        <PdfMutedLine>{spaceGapEmptyMessage(data)}</PdfMutedLine>
      )}
    </PdfChartCard>
  );
}

function Tier1Card({ data, width, style }) {
  const hasRows = data.tier1Summary.tier1Count > 0;
  return (
    <PdfChartCard title={TIER1_TITLE} footnote={hasRows ? TIER1_FOOTNOTE : null} width={width} style={style}>
      {hasRows ? <PdfScoreTable rows={tier1Rows(data.tier1Summary)} /> : <PdfMutedLine>{TIER1_EMPTY}</PdfMutedLine>}
    </PdfChartCard>
  );
}

// --- Page 2 -------------------------------------------------------------------
function PhasingCard({ data }) {
  const nearTerm = data.phasingSummary.nearTerm;
  const rows = nearTerm.length ? phasingRows(nearTerm) : [];
  // Page height left for the chart itself after the header band, footer,
  // card title/subtitle, legend and padding.
  const chartMaxHeight = PAGE_HEIGHT - PAGE_TOP - PAGE_BOTTOM - 70;
  return (
    <PdfChartCard title={phasingTitle(nearTerm)} subtitle={PHASING_SUBTITLE} width={CONTENT_WIDTH}>
      {rows.length ? (
        <>
          <PdfLegend items={phasingLegendItems(rows)} />
          <PdfPhasingTimeline
            width={CONTENT_WIDTH - CARD_CHROME}
            rows={rows}
            range={getPhasingAxisRange(nearTerm, new Date())}
            maxHeight={chartMaxHeight}
          />
        </>
      ) : (
        <PdfMutedLine>{PHASING_EMPTY}</PdfMutedLine>
      )}
    </PdfChartCard>
  );
}

export default function ExecutiveDashboardPdfDocument({ data }) {
  const subtitle = dashboardSubtitle(new Date());
  const half = (CONTENT_WIDTH - GAP) / 2;
  const spaceGapWidth = ((CONTENT_WIDTH - GAP) * 7) / 12;
  const tier1Width = CONTENT_WIDTH - GAP - spaceGapWidth;

  return (
    <Document title="Executive Dashboard" author="Clark & Enersen · Mapfluence">
      <Page size="LETTER" orientation="landscape" style={styles.page}>
        <PageChrome subtitle={subtitle} />
        <KpiRow data={data} />
        <View style={styles.row} wrap={false}>
          <GaugesCard data={data} width={half} />
          <RoomSizeCard data={data} width={half} style={{ marginLeft: GAP }} />
        </View>
        <View style={styles.row} wrap={false}>
          <SpaceGapCard data={data} width={spaceGapWidth} />
          <Tier1Card data={data} width={tier1Width} style={{ marginLeft: GAP }} />
        </View>
      </Page>

      <Page size="LETTER" orientation="landscape" style={styles.page}>
        <PageChrome subtitle={subtitle} />
        <PhasingCard data={data} />
      </Page>
    </Document>
  );
}
