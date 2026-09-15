// src/components/ExecutiveDashboardPdfDocument.jsx
//
// Executive Dashboard PDF export -- mirrors the live view's visual redesign
// (ExecutiveDashboardModal.jsx: KPI cards, gauges, colored chart cards)
// rather than the earlier text/bullet-list PDF. Per Clark's decision, scoped
// to this ONE export only -- every other jsPDF export in StakeholderMap.jsx
// (7 of them) is untouched and still uses the original hand-drawn
// convention; this file and @react-pdf/renderer are not used anywhere else
// in the codebase.
//
// Pure presentation: takes the exact same `data` shape
// ExecutiveDashboardPanel.jsx's runCalculation() already produces and
// renders it -- no Firestore/Airtable access, no data aggregation of its
// own. All content/data logic (division rollup, near-term filtering) lives
// in executiveDashboardCalc.js and spaceGrowthCalc.js, unchanged by this
// rebuild.
//
// The gauge is a full style match to SpaceDashboardPanel.jsx's real
// OfficeOccupancyGauge -- same exact strokeWidth/needle transform/typography
// as ExecutiveDashboardModal.jsx's live SVG gauge, just re-emitted through
// react-pdf's <Svg>/<Path>/<G> instead of DOM <svg>/<path>/<g> -- kept as a
// duplicate copy here rather than a shared import, same isolation convention
// this module's other small chart helpers already use (see
// executiveDashboardCalc.js's header comment). The arc itself now uses the
// Day/Time Heat Map's graduated blue scale, not Office Occupancy's -- see the
// Gauge component below for the color-stop derivation.
//
// Pagination: each section is one <View wrap={false}> block (heading + its
// content + its chart, together) -- react-pdf's own documented mechanism for
// "never split this group across a page break".
//
// Visual-first, minimal text: the KPI cards, gauges, and charts carry the
// content -- no adjacent line of text restates a number a card/gauge/chart
// already shows.

import React from 'react';
import { Document, Page, View, Text, Svg, G, Line, Rect, Path, Circle, StyleSheet } from '@react-pdf/renderer';
import { formatUsdCompact, formatPct, formatGapSf } from '../utils/executiveDashboardCalc';

const COLORS = {
  heading: '#1d2939',
  label: '#344054',
  muted: '#667085',
  track: '#e4e7ec',
  border: '#d0d7e2',
  cardBorder: '#edf2f7',
  blue: '#3b82f6',
  red: '#dc2626',
  amber: '#d97706',
  green: '#15803d',
  redTint: '#fef3f2',
  redBorder: '#fda29b',
  greenTint: '#f0fdf4',
  greenBorder: '#86efac',
  neutralTint: '#f8fafc'
};

// Page content width in points: LETTER (612pt) minus 36pt margins each side.
const CONTENT_WIDTH = 540;

const styles = StyleSheet.create({
  page: {
    paddingTop: 36,
    paddingBottom: 36,
    paddingHorizontal: 36,
    fontSize: 10.5,
    fontFamily: 'Helvetica',
    color: '#000000'
  },
  title: { fontSize: 18, fontFamily: 'Helvetica-Bold', color: COLORS.heading },
  meta: { fontSize: 9.5, color: COLORS.muted, marginTop: 3, marginBottom: 14 },
  section: {
    marginTop: 12,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: COLORS.cardBorder
  },
  sectionHeading: { fontSize: 12.5, fontFamily: 'Helvetica-Bold', color: COLORS.heading, marginBottom: 8 },
  card: {
    borderWidth: 1,
    borderColor: COLORS.cardBorder,
    borderRadius: 6,
    padding: 10,
    backgroundColor: '#ffffff'
  },
  mutedLine: { fontSize: 10, color: COLORS.muted }
});

// --- KPI card row -----------------------------------------------------
function KpiCard({ label, value, tint, textColor, width }) {
  return (
    <View
      style={[
        styles.card,
        {
          width,
          backgroundColor: tint || COLORS.neutralTint,
          borderColor: tint ? (tint === COLORS.redTint ? COLORS.redBorder : COLORS.greenBorder) : COLORS.border
        }
      ]}
    >
      <Text style={{ fontSize: 19, fontFamily: 'Helvetica-Bold', color: textColor || COLORS.heading }}>{value}</Text>
      <Text style={{ fontSize: 8, color: COLORS.muted, marginTop: 3, textTransform: 'uppercase' }}>{label}</Text>
    </View>
  );
}

function KpiRow({ data }) {
  const gapValue = data.institutionGap.totalGapTarget;
  const gapIsDeficit = gapValue != null && gapValue < 0;
  const gapIsSurplus = gapValue != null && gapValue >= 0;
  const cardWidth = (CONTENT_WIDTH - 3 * 8) / 4;
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
      <KpiCard label="Total Capital Need (Tier 1)" value={formatUsdCompact(data.tier1Summary.totalKnownCost)} width={cardWidth} />
      <KpiCard label="Tier 1 Buildings" value={String(data.tier1Summary.tier1Count)} width={cardWidth} />
      <KpiCard label="Near-Term Projects" value={String(data.phasingSummary.nearTerm.length)} width={cardWidth} />
      <KpiCard
        label={`Space Gap (${data.targetYear})`}
        value={gapValue != null ? formatGapSf(gapValue) : 'N/A'}
        tint={gapIsDeficit ? COLORS.redTint : gapIsSurplus ? COLORS.greenTint : undefined}
        textColor={gapIsDeficit ? COLORS.red : gapIsSurplus ? COLORS.green : undefined}
        width={cardWidth}
      />
    </View>
  );
}

// --- Gauge (speedometer) ------------------------------------------------
// Full property-by-property match to SpaceDashboardPanel.jsx's real
// OfficeOccupancyGauge, mirroring ExecutiveDashboardModal.jsx's live gauge
// exactly -- see that file's Gauge component for the full comparison-table
// reasoning (3 real mismatches found and fixed 2026-09-15: title placement
// above vs. below the svg, title text case, and meta/sublabel color/size/
// spacing that a prior pass never actually checked against the reference's
// real CSS: .mf-gauge-title is 12px/700/0.04em letter-spacing/#666 rendered
// as a div ABOVE the svg with literal ALL-CAPS content; .mf-gauge-meta is
// margin-top: -6px + .muted's 12px/#777). react-pdf has no font-weight-700
// on the default Helvetica family, so the title/sublabel use
// Helvetica-Bold/Helvetica respectively to reproduce the same visual
// weight rather than a literal fontWeight prop.
//
// Per Clark's reversed decision: the arc's red/amber/green "judgment" scale
// (correctly matched to Office Occupancy) is REPLACED here, because it read
// as inconsistent against this same dashboard's Day/Time Occupancy Heat Map,
// which uses a graduated blue "intensity" scale, not a judgment one. The arc
// now uses that Heat Map's own color logic instead -- identical
// GAUGE_BAND_COLORS array copied verbatim from ExecutiveDashboardModal.jsx's
// live gauge (color stops extracted exactly from
// ClassroomUtilizationPanel.jsx's real heatmapCellBackground(pct), ~line
// 3301: alpha = 0.08 + (pct/100) * 0.82 over #2563eb, evaluated at 8 evenly-
// spaced percentage midpoints and composited over white into solid hex --
// computed programmatically, not hand-typed/estimated). Both renderers
// consume this identical precomputed array so they can't drift apart the way
// two independent rgba()-alpha computations could.
const GAUGE_BAND_COLORS = ['#e2ebfc', '#ccdbfa', '#b6cbf8', '#9fbbf6', '#89abf4', '#739bf2', '#5c8bf0', '#467bee'];

// polarToCartesian/describeArc: identical copies of
// ExecutiveDashboardModal.jsx's own helpers -- needed to compute 8 arc
// segments (the old 3-segment red/amber/green version could copy
// OfficeOccupancyGauge's own 3 hand-drawn path strings verbatim; the Heat
// Map has no arc geometry to copy at all, only a per-cell color formula, so
// an 8-stop graduated arc has to be generated, not transcribed).
function polarToCartesian(cx, cy, r, angleDeg) {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}
function describeArc(cx, cy, r, startAngle, endAngle) {
  const start = polarToCartesian(cx, cy, r, endAngle);
  const end = polarToCartesian(cx, cy, r, startAngle);
  const largeArcFlag = endAngle - startAngle <= 180 ? '0' : '1';
  return `M ${start.x} ${start.y} A ${r} ${r} 0 ${largeArcFlag} 0 ${end.x} ${end.y}`;
}
const GAUGE_SEGMENT_DEG = 180 / GAUGE_BAND_COLORS.length;

function Gauge({ label, pct, sublabel, width }) {
  const svgW = width;
  const svgH = svgW * 0.65; // matches the reference's own 200x130 aspect ratio (130/200 = 0.65)
  const hasValue = Number.isFinite(pct);
  const value = hasValue ? Math.max(0, Math.min(pct, 100)) / 100 : 0;
  const angle = -90 + value * 180;

  return (
    <View style={[styles.card, { width, alignItems: 'center' }]}>
      <Text style={{ fontSize: 12, fontFamily: 'Helvetica-Bold', letterSpacing: 0.04, color: '#666666', textAlign: 'center', textTransform: 'uppercase', marginBottom: 4 }}>
        {label}
      </Text>
      <Svg width={svgW} height={svgH} viewBox="0 0 200 130">
        {/* 8 segments, butt caps (not round) -- matches
            ExecutiveDashboardModal.jsx's live gauge: round caps on every
            segment boundary would show visible bulges/gaps between adjacent
            stops, so butt caps butt cleanly against each other and the ring
            still reads as one continuous graduated arc. */}
        {GAUGE_BAND_COLORS.map((color, i) => {
          const segStart = -90 + i * GAUGE_SEGMENT_DEG;
          const segEnd = -90 + (i + 1) * GAUGE_SEGMENT_DEG;
          return (
            <Path key={color} d={describeArc(100, 110, 80, segStart, segEnd)} stroke={hasValue ? color : COLORS.track} strokeWidth={16} strokeLinecap="butt" fill="none" />
          );
        })}
        {hasValue ? (
          <G transform={`translate(100 110) rotate(${angle})`}>
            <Line x1={0} y1={0} x2={0} y2={-70} stroke="#222222" strokeWidth={3} />
            <Circle cx={0} cy={0} r={6} fill="#222222" />
          </G>
        ) : null}
        <Text x={20} y={125} fontSize={11} fill="#666666">low</Text>
        <Text x={92} y={20} fontSize={11} fill="#666666">mid</Text>
        <Text x={168} y={125} fontSize={11} fill="#666666">high</Text>
        {/* Opaque backing plate behind the value readout -- identical fix
            to ExecutiveDashboardModal.jsx's live gauge (see that file's
            Gauge component for the full root-cause explanation: the needle
            and the value text share the same x-axis, so for pct's whose
            angle lands near-vertical (roughly 30-70%) the needle line
            visually bisects the number). Same rect, same position, so both
            renderers stay consistent. */}
        <Rect x={70} y={76} width={60} height={20} rx={4} fill="#ffffff" />
        <Text x={100} y={90} textAnchor="middle" fontSize={16} fill="#1d2939" style={{ fontFamily: 'Helvetica-Bold' }}>
          {hasValue ? formatPct(pct) : '--'}
        </Text>
      </Svg>
      {sublabel ? <Text style={{ marginTop: -6, fontSize: 12, color: '#777777' }}>{sublabel}</Text> : null}
    </View>
  );
}

function GaugeRow({ data }) {
  if (data.currentTerm.status === 'unconfigured') {
    return <Text style={styles.mutedLine}>No terms configured — cannot compute Time Utilization.</Text>;
  }
  if (!data.campusRollups.length) {
    return <Text style={styles.mutedLine}>Terms are configured, but no scheduled classes matched any term.</Text>;
  }
  const n = data.campusRollups.length;
  const gap = 8;
  const width = (CONTENT_WIDTH - (n - 1) * gap) / Math.min(n, 3);
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap }}>
      {data.campusRollups.map((c) => (
        <Gauge
          key={c.termId}
          label={`Time Utilization — ${c.termLabel}`}
          pct={c.timeUtilizationPct}
          sublabel={data.currentTerm.termId === c.termId ? 'Current term' : null}
          width={width}
        />
      ))}
    </View>
  );
}

// --- Space Gap by Division -------------------------------------------------
// Exactly the 3 real academic divisions -- mirrors ExecutiveDashboardModal.jsx's
// live SpaceGapCard exactly, see its comment for the Non-Academic/Office
// bucket's build-then-drop history.
function SpaceGapChart({ buckets }) {
  const rowHeight = 30;
  const centerX = CONTENT_WIDTH / 2;
  const halfWidth = CONTENT_WIDTH / 2 - 60;
  const barHeight = 12;
  const maxAbsGap = Math.max(...buckets.filter((b) => b.gapTarget != null).map((b) => Math.abs(b.gapTarget)), 1);
  const svgHeight = rowHeight * buckets.length;

  return (
    <Svg width={CONTENT_WIDTH} height={svgHeight} viewBox={`0 0 ${CONTENT_WIDTH} ${svgHeight}`}>
      <Line x1={centerX} y1={0} x2={centerX} y2={svgHeight - 8} stroke={COLORS.border} strokeWidth={0.75} />
      {buckets.map((b, i) => {
        const rowY = i * rowHeight;
        const barY = rowY + 12;
        return (
          <React.Fragment key={b.label}>
            <Text x={2} y={rowY + 8} fontSize={9} fill={COLORS.label}>{b.label}</Text>
            {b.gapTarget == null ? (
              <Text x={CONTENT_WIDTH - 2} y={barY + barHeight - 3} fontSize={9} fill={COLORS.muted} textAnchor="end">No data</Text>
            ) : (
              (() => {
                const isShortage = b.gapTarget < 0;
                const magnitude = (Math.abs(b.gapTarget) / maxAbsGap) * halfWidth;
                const barX = isShortage ? centerX - magnitude : centerX;
                const barWidth = Math.max(magnitude, 2);
                const valueX = isShortage ? centerX - magnitude - 4 : centerX + magnitude + 4;
                return (
                  <>
                    <Rect x={barX} y={barY} width={barWidth} height={barHeight} fill={isShortage ? COLORS.red : COLORS.green} />
                    <Text x={valueX} y={barY + barHeight - 3} fontSize={9} fill={COLORS.heading} style={{ fontFamily: 'Helvetica-Bold' }} textAnchor={isShortage ? 'end' : 'start'}>
                      {formatGapSf(b.gapTarget)}
                    </Text>
                  </>
                );
              })()
            )}
          </React.Fragment>
        );
      })}
    </Svg>
  );
}

function SpaceGapCard({ buckets }) {
  return (
    <View style={[styles.card, { backgroundColor: COLORS.neutralTint }]}>
      <Text style={{ fontSize: 11, fontFamily: 'Helvetica-Bold', color: COLORS.heading, marginBottom: 6 }}>
        Space Gap by Division
      </Text>
      {!buckets.length ? <Text style={styles.mutedLine}>No division-level gaps available.</Text> : <SpaceGapChart buckets={buckets} />}
    </View>
  );
}

// --- Capital Phasing timeline --------------------------------------------
// One thin bar per near-term project spanning [next phase start ->
// completion] along a shared date axis, a dashed "Today" marker, endpoint
// date labels, and yearly tick marks for every calendar year boundary
// strictly between the axis's start and end.
function PhasingTimelineChart({ nearTerm }) {
  const rowHeight = 20;
  const axisX0 = 4;
  const axisX1 = CONTENT_WIDTH - 4;
  const axisWidth = axisX1 - axisX0;
  const edgeClearance = 32;

  const now = new Date();
  const starts = nearTerm.map((p) => new Date(p.nextPhaseStart).getTime());
  const ends = nearTerm.map((p) => new Date(p.completionDate).getTime());
  const minTime = Math.min(now.getTime(), ...starts);
  const maxTime = Math.max(...ends, minTime + 1);
  const span = maxTime - minTime;
  const xForTime = (ms) => axisX0 + ((ms - minTime) / span) * axisWidth;

  const barsTop = 20;
  const axisY = barsTop + nearTerm.length * rowHeight + 6;
  const svgHeight = axisY + 26;

  const todayX = xForTime(now.getTime());
  const showTodayLabel = todayX - axisX0 > edgeClearance && axisX1 - todayX > edgeClearance;

  const minDate = new Date(minTime);
  const maxDate = new Date(maxTime);
  const yearTicks = [];
  for (let yr = minDate.getUTCFullYear() + 1; yr <= maxDate.getUTCFullYear(); yr += 1) {
    const t = Date.UTC(yr, 0, 1);
    if (t > minTime && t < maxTime) yearTicks.push(t);
  }

  return (
    <Svg width={CONTENT_WIDTH} height={svgHeight} viewBox={`0 0 ${CONTENT_WIDTH} ${svgHeight}`}>
      {nearTerm.map((p, i) => {
        const rowY = barsTop + i * rowHeight;
        const x0 = xForTime(new Date(p.nextPhaseStart).getTime());
        const x1 = xForTime(new Date(p.completionDate).getTime());
        return (
          <React.Fragment key={p.projectId}>
            <Text x={axisX0} y={rowY - 2} fontSize={8} fill={COLORS.label}>{p.projectName}</Text>
            <Rect x={Math.min(x0, x1)} y={rowY} width={Math.max(x1 - x0, 4)} height={8} rx={1.5} fill={COLORS.blue} />
          </React.Fragment>
        );
      })}

      <Line x1={axisX0} y1={axisY} x2={axisX1} y2={axisY} stroke={COLORS.border} strokeWidth={0.75} />

      <Line x1={todayX} y1={10} x2={todayX} y2={axisY} stroke={COLORS.muted} strokeWidth={1} strokeDasharray="2,2" />
      {showTodayLabel ? <Text x={todayX} y={8} fontSize={7.5} fill={COLORS.muted} textAnchor="middle">Today</Text> : null}

      {yearTicks.map((t) => {
        const tx = xForTime(t);
        const showLabel = tx - axisX0 > edgeClearance && axisX1 - tx > edgeClearance;
        return (
          <React.Fragment key={t}>
            <Line x1={tx} y1={axisY - 3} x2={tx} y2={axisY + 3} stroke={COLORS.border} strokeWidth={0.75} />
            {showLabel ? (
              <Text x={tx} y={axisY + 13} fontSize={7.5} fill={COLORS.muted} textAnchor="middle">
                {new Date(t).getUTCFullYear()}
              </Text>
            ) : null}
          </React.Fragment>
        );
      })}

      <Text x={axisX0} y={axisY + 13} fontSize={8} fill={COLORS.muted}>
        {new Date(minTime).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}
        {minTime === now.getTime() ? ' (today)' : ''}
      </Text>
      <Text x={axisX1} y={axisY + 13} fontSize={8} fill={COLORS.muted} textAnchor="end">
        {new Date(maxTime).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}
      </Text>
    </Svg>
  );
}

function PhasingTimelineCard({ nearTerm }) {
  return (
    <View style={[styles.card, { backgroundColor: COLORS.neutralTint, marginTop: 8 }]}>
      <Text style={{ fontSize: 11, fontFamily: 'Helvetica-Bold', color: COLORS.heading, marginBottom: 6 }}>
        Capital Phasing Timeline (Next ~2 Years)
      </Text>
      {!nearTerm.length ? <Text style={styles.mutedLine}>No near-term projects.</Text> : <PhasingTimelineChart nearTerm={nearTerm} />}
    </View>
  );
}

// --- Capital Priorities Tier 1 list ---------------------------------------
function urgencyColor(total) {
  if (total >= 94) return COLORS.red;
  if (total >= 87) return COLORS.amber;
  return COLORS.green;
}

function Tier1ListCard({ tier1Summary }) {
  return (
    <View style={[styles.card, { backgroundColor: COLORS.neutralTint, marginTop: 8 }]}>
      <Text style={{ fontSize: 11, fontFamily: 'Helvetica-Bold', color: COLORS.heading, marginBottom: 6 }}>
        Capital Priorities — Tier 1
      </Text>
      {!tier1Summary.tier1Count ? (
        <Text style={styles.mutedLine}>No Tier 1 buildings currently.</Text>
      ) : (
        tier1Summary.tier1Buildings.map((b) => (
          <View key={b.buildingId} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 3, borderBottomWidth: 0.5, borderBottomColor: COLORS.cardBorder }}>
            <Svg width={8} height={8}><Circle cx={4} cy={4} r={4} fill={urgencyColor(b.total)} /></Svg>
            <Text style={{ fontSize: 9.5, fontFamily: 'Helvetica-Bold', color: COLORS.heading, marginLeft: 6, flex: 1 }}>{b.originalId}</Text>
            <Text style={{ fontSize: 9, color: COLORS.muted, width: 34, textAlign: 'right' }}>{b.total}</Text>
            <Text style={{ fontSize: 9.5, fontFamily: 'Helvetica-Bold', color: COLORS.heading, width: 60, textAlign: 'right' }}>
              {b.resolvedCost != null ? formatUsdCompact(b.resolvedCost) : '—'}
            </Text>
          </View>
        ))
      )}
    </View>
  );
}

export default function ExecutiveDashboardPdfDocument({ data }) {
  return (
    <Document>
      <Page size="LETTER" style={styles.page}>
        <Text style={styles.title}>Executive Dashboard</Text>
        <Text style={styles.meta}>Generated {new Date().toLocaleDateString()}</Text>

        <View style={styles.section} wrap={false}>
          <KpiRow data={data} />
        </View>

        <View style={styles.section} wrap={false}>
          <Text style={styles.sectionHeading}>Time Utilization</Text>
          <GaugeRow data={data} />
        </View>

        <View style={styles.section} wrap={false}>
          <Text style={styles.sectionHeading}>Space Growth ({data.targetYear})</Text>
          {!data.hasAnySpaceConfig ? <Text style={styles.mutedLine}>No space categories configured yet.</Text> : <SpaceGapCard buckets={data.spaceGapBuckets} />}
        </View>

        <View style={styles.section} wrap={false}>
          <Text style={styles.sectionHeading}>Capital Phasing &amp; Priorities</Text>
          {!data.hasAnyCapitalPhasing ? (
            <Text style={styles.mutedLine}>No Capital Phasing projects uploaded yet.</Text>
          ) : (
            <PhasingTimelineCard nearTerm={data.phasingSummary.nearTerm} />
          )}
          {!data.hasAnyCapitalPriorities ? (
            <Text style={[styles.mutedLine, { marginTop: 8 }]}>No buildings have been scored yet in Capital Priorities.</Text>
          ) : (
            <Tier1ListCard tier1Summary={data.tier1Summary} />
          )}
        </View>
      </Page>
    </Document>
  );
}
