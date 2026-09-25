// src/components/ExecutiveDashboardModal.jsx
//
// The Executive Dashboard's actual visual surface -- KPI cards, gauges, and
// colored chart cards. Mounted as a wide centered overlay (reusing the
// existing .mf-ai-modal-panel modal-chrome convention already used for the AI
// panels and Program Test Fit -- StakeholderMap.jsx) rather than living in
// the narrow ~345px .mf-right-rail column those panels share: a real
// KPI-card/gauge grid needs more horizontal room than that rail can ever
// give it without changing its shared width/scroll behavior for every other
// panel stacked inside it. This file owns none of that shared layout -- it
// is a self-contained overlay ExecutiveDashboardPanel.jsx opens/closes.
//
// Pure presentation only: takes the exact `data` shape
// ExecutiveDashboardPanel.jsx's runCalculation() already produces and
// renders it. No Firestore/Airtable access, no aggregation of its own -- all
// underlying numbers still come from executiveDashboardCalc.js, unchanged.
//
// Visual-first, per Clark's explicit refinement: the four detailed panels
// already below the map (Capital Priorities, Capital Phasing, Space Growth,
// Classroom Utilization) hold the full text/data breakdown a scroll away.
// This dashboard is a complement to those, not a restatement -- every
// section here is a number/chart carrying its own meaning, with no adjacent
// sentence re-stating the figure the card/chart/gauge already shows.

import React from 'react';
import { formatCapitalPhasingMonthYear } from '../utils/capitalPhasingImport';
import { formatUsdCompact, formatPct, formatGapSf, formatTier1CapitalNeed } from '../utils/executiveDashboardCalc';
import { INDUSTRY_TARGET_TIME_UTILIZATION } from '../utils/classroomUtilizationCalc';

// Shared semantic palette -- reuses the exact hexes already in use elsewhere
// in this codebase for the same meanings (HANDOFF.md's building-progress
// colors: red/orange/green; CapitalPrioritiesPanel.jsx's Tier 1/Tier 4
// green/red), rather than inventing a parallel color language for this one
// panel.
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

function cardShellStyle(extra) {
  return {
    background: '#fff',
    border: `1px solid ${COLORS.cardBorder}`,
    borderRadius: 10,
    padding: 12,
    ...extra
  };
}

// --- KPI card ---------------------------------------------------------
function KpiCard({ label, value, note, tint, textColor }) {
  return (
    <div
      style={cardShellStyle({
        background: tint || COLORS.neutralTint,
        border: `1px solid ${tint ? (tint === COLORS.redTint ? COLORS.redBorder : COLORS.greenBorder) : COLORS.border}`,
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        minWidth: 0
      })}
    >
      <div style={{ fontSize: 24, fontWeight: 800, color: textColor || COLORS.heading, lineHeight: 1.1 }}>
        {value}
      </div>
      <div style={{ fontSize: 11, fontWeight: 600, color: COLORS.muted, textTransform: 'uppercase', letterSpacing: 0.3 }}>
        {label}
      </div>
      {note ? <div style={{ fontSize: 11, color: COLORS.muted }}>{note}</div> : null}
    </div>
  );
}

function KpiRow({ data }) {
  const gapValue = data.institutionGap.totalGapTarget;
  const gapIsDeficit = gapValue != null && gapValue < 0;
  const gapIsSurplus = gapValue != null && gapValue >= 0;
  const tier1Need = formatTier1CapitalNeed(data.tier1Summary);
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10 }}>
      <KpiCard label="Total Capital Need (Tier 1)" value={tier1Need.value} note={tier1Need.note} />
      <KpiCard label="Tier 1 Buildings" value={data.tier1Summary.tier1Count} />
      <KpiCard label="Near-Term Projects" value={data.phasingSummary.nearTerm.length} />
      <KpiCard
        label={`Space Gap (${data.targetYear})`}
        value={gapValue != null ? formatGapSf(gapValue) : 'N/A'}
        tint={gapIsDeficit ? COLORS.redTint : gapIsSurplus ? COLORS.greenTint : undefined}
        textColor={gapIsDeficit ? COLORS.red : gapIsSurplus ? COLORS.green : undefined}
      />
    </div>
  );
}

// --- Gauge (speedometer) ------------------------------------------------
// Needle/pivot/label/title/typography still a full property-by-property
// match to SpaceDashboardPanel.jsx's OfficeOccupancyGauge (verified in an
// earlier round against an explicit side-by-side property table -- viewBox,
// arc radius, stroke width 16, needle transform/length/width/color, pivot
// r=6, low/mid/high text, value text, title placement/case, meta/sublabel
// styling all unchanged here).
//
// Per Clark's reversed decision: the arc's red/amber/green "judgment" scale
// (correctly matched to Office Occupancy, confirmed via rendered
// comparison) is REPLACED here, because it read as inconsistent against
// this same dashboard's Day/Time Occupancy Heat Map, which uses a
// graduated blue "intensity" scale, not a judgment one. The arc now uses
// that Heat Map's own color logic instead of Office Occupancy's.
//
// Color stops extracted exactly from ClassroomUtilizationPanel.jsx's real
// heatmapCellBackground(pct) (Day/Time Occupancy Heat Map, ~line 3301):
//   alpha = 0.08 + (pct/100) * 0.82
//   color = rgba(37, 99, 235, alpha)   -- i.e. #2563eb at that alpha
// GAUGE_BAND_COLORS below are that exact formula evaluated at 8 evenly-
// spaced percentage midpoints (6.25, 18.75, ..., 93.75) and composited over
// white (this gauge's own card background) into solid hex -- computed
// programmatically from the formula above (verified with a standalone
// script, not hand-typed/estimated), not an approximated blue ramp. Solid
// stops, not a live rgba() stroke or an SVG <linearGradient>, so the two
// renderers (this file's DOM svg and ExecutiveDashboardPdfDocument.jsx's
// react-pdf Svg) can't alpha-composite the same formula differently and
// drift apart -- both consume this identical array.
const GAUGE_BAND_COLORS = ['#e2ebfc', '#ccdbfa', '#b6cbf8', '#9fbbf6', '#89abf4', '#739bf2', '#5c8bf0', '#467bee'];

// polarToCartesian/describeArc: needed again to COMPUTE 8 arc segments
// (unlike the 3-segment red/amber/green version, which could copy
// OfficeOccupancyGauge's own 3 hand-drawn path strings verbatim -- the Heat
// Map has no arc geometry to copy at all, only a per-cell color formula, so
// an 8-stop graduated arc has to be generated, not transcribed). Same exact
// angle convention (0deg = top, +90 = right, -90 = left, clockwise) already
// used everywhere else in this module.
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

function Gauge({ label, pct, sublabel, targetPct }) {
  const hasValue = Number.isFinite(pct);
  const value = hasValue ? Math.max(0, Math.min(pct, 100)) / 100 : 0;
  const angle = -90 + value * 180;
  const hasTarget = Number.isFinite(targetPct);
  const targetAngle = hasTarget ? -90 + (Math.max(0, Math.min(targetPct, 100)) / 100) * 180 : null;

  return (
    // flex: '0 1 190px' (grow: 0) instead of '1 1 220px' (grow: 1) -- a real
    // rendered screenshot (headless Chrome, 2026-09-15) proved the actual
    // problem three rounds of property-matching never touched: flex-grow:1
    // in a 2-gauge row at the modal's ~1068px content width let each card
    // stretch to ~500px, and the svg's own maxWidth:260 scaled every stroke
    // width up proportionally with it (16 viewBox units -> ~21px rendered,
    // vs. the reference's ~10px at its real 124px size) -- every individual
    // color/coordinate/stroke-width VALUE was already correct (confirmed:
    // an svg-only, same-size comparison of the two gauges' markup is
    // visually indistinguishable), but at ~2x the reference's linear size
    // the whole gauge reads as chunkier/bolder, not "the same gauge." Not
    // claiming this fixes it -- picked 170/190 as a size closer to the
    // reference's 124px than the old 260px, pending Clark's real review of
    // the rendered comparison, not a guaranteed-final value.
    <div style={cardShellStyle({ display: 'flex', flexDirection: 'column', alignItems: 'center', flex: '0 1 190px', minWidth: 170 })}>
      {/* Title ABOVE the svg, exact position OfficeOccupancyGauge's own
          .mf-gauge-title div renders in (that component's DOM order is
          title -> svg -> meta, not svg -> title) -- a prior version of this
          gauge put the label below the svg, which read as a structural
          mismatch even though every internal SVG property already matched.
          textTransform: uppercase reproduces .mf-gauge-title's literal
          ALL-CAPS content ("OFFICE OCCUPANCY") as a style rather than
          hardcoding this label's own string uppercase. */}
      <div style={{ marginBottom: 4, fontSize: 12, fontWeight: 700, letterSpacing: '0.04em', color: '#666', textAlign: 'center', textTransform: 'uppercase' }}>{label}</div>
      <svg width="100%" viewBox="0 0 200 130" style={{ maxWidth: 170 }} aria-label={label}>
        {/* 8 segments, butt caps (not round) -- round caps on every
            segment boundary would show visible bulges/gaps between
            adjacent stops; butt caps butt cleanly against each other so
            the ring still reads as one continuous graduated arc. */}
        {GAUGE_BAND_COLORS.map((color, i) => {
          const segStart = -90 + i * GAUGE_SEGMENT_DEG;
          const segEnd = -90 + (i + 1) * GAUGE_SEGMENT_DEG;
          return (
            <path key={color} d={describeArc(100, 110, 80, segStart, segEnd)} fill="none" stroke={hasValue ? color : COLORS.track} strokeWidth="16" strokeLinecap="butt" />
          );
        })}
        {/* Industry Target tick -- a static, hardcoded reference notch
            (INDUSTRY_TARGET_TIME_UTILIZATION, classroomUtilizationCalc.js),
            not a live/fetched value. Drawn as a radial line crossing the
            graduated arc band (band spans radius 72-88; tick runs 70-94, a
            few units past each edge so it reads as a notch cutting across
            the ring rather than a segment matching one band's own width).
            Rendered before the needle so the needle still draws on top at
            any pct whose angle happens to land near the target's. */}
        {hasTarget ? (() => {
          const tickInner = polarToCartesian(100, 110, 70, targetAngle);
          const tickOuter = polarToCartesian(100, 110, 94, targetAngle);
          return (
            <line
              x1={tickInner.x}
              y1={tickInner.y}
              x2={tickOuter.x}
              y2={tickOuter.y}
              stroke="#1d2939"
              strokeWidth="3"
              strokeLinecap="round"
            >
              <title>{`Industry Target: ${Math.round(targetPct)}%`}</title>
            </line>
          );
        })() : null}
        {hasValue ? (
          <g transform={`translate(100 110) rotate(${angle})`}>
            <line x1="0" y1="0" x2="0" y2="-70" stroke="#222" strokeWidth="3" />
            <circle cx="0" cy="0" r="6" fill="#222" />
          </g>
        ) : null}
        <text x="20" y="125" fontSize="11" fill="#666">low</text>
        <text x="92" y="20" fontSize="11" fill="#666">mid</text>
        <text x="168" y="125" fontSize="11" fill="#666">high</text>
        {/* Opaque backing plate behind the value readout, drawn AFTER the
            needle so it sits visually in front. Root cause (confirmed by
            actually rendering this gauge headless at several pct values,
            not guessed): the needle is a line from the pivot (100,110) out
            to (100,-70) before rotation, and the value text is centered at
            (100,90) -- directly on that same vertical axis, 20px above the
            pivot. For any pct whose angle is near vertical (roughly the
            30-70% band, e.g. this session's 37%/65% test values), the
            needle's line passes straight through the text and visually
            bisects it. This is the identical geometry
            SpaceDashboardPanel.jsx's OfficeOccupancyGauge reference already
            has (same (100,90) text / (100,110) pivot / length-70 needle) --
            not something the blue-scale rework introduced or repositioned;
            it was just never caught there because Office Occupancy values
            hadn't been checked at pct's that land in this exact collision
            zone. Fixing the geometry (plate) rather than moving the text
            keeps the value in the exact position the reference uses. */}
        <rect x={70} y={76} width={60} height={20} rx={4} fill="#fff" />
        <text x="100" y="90" textAnchor="middle" fontSize="16" fontWeight="700" fill="#1d2939">
          {hasValue ? formatPct(pct) : '--'}
        </text>
      </svg>
      {/* Matches .mf-gauge-meta (margin-top: -6px, pulled tight under the
          arc) + .muted (12px/#777) exactly -- a prior version used 10.5px/
          COLORS.muted (#667085) and a positive margin, neither of which
          was ever actually checked against the reference's real CSS. */}
      {sublabel ? <div style={{ marginTop: -6, fontSize: 12, color: '#777' }}>{sublabel}</div> : null}
    </div>
  );
}

function GaugeRow({ data }) {
  if (data.currentTerm.status === 'unconfigured') {
    return (
      <div style={cardShellStyle({ fontSize: 11.5, color: COLORS.muted })}>
        No terms configured — cannot compute Time Utilization.
      </div>
    );
  }
  if (!data.campusRollups.length) {
    return (
      <div style={cardShellStyle({ fontSize: 11.5, color: COLORS.muted })}>
        Terms are configured, but no scheduled classes matched any term.
      </div>
    );
  }
  // justifyContent: 'center' -- shrinking the gauges (flex-grow: 0, see
  // Gauge's own comment) to fix their oversizing left a large blank gap to
  // the right of a 2-gauge row at the modal's full width, a new dead-space
  // side effect of that fix worth catching before this ships, not just
  // during a live check.
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, justifyContent: 'center' }}>
      {data.campusRollups.map((c) => (
        <Gauge
          key={c.termId}
          label={`Time Utilization — ${c.termLabel}`}
          pct={c.timeUtilizationPct}
          targetPct={INDUSTRY_TARGET_TIME_UTILIZATION * 100}
          sublabel={data.currentTerm.termId === c.termId ? 'Current term' : null}
        />
      ))}
    </div>
  );
}

// --- Space Gap by Division -------------------------------------------------
// Diverging (signed) bar chart -- gapTarget's sign is load-bearing (shortage
// vs. surplus, see spaceGrowthCalc.js), so magnitude alone would silently
// drop the one fact that tells a reader which direction the gap runs.
// Same construction as the PDF version's SpaceGapChart, ported to plain DOM
// SVG tags.
//
// Exactly the 3 real academic divisions, per Clark's 2026-09-15 decision.
// A 4th "Non-Academic/Office" bucket (current SF only, no gap) was built and
// shipped for one round, then dropped outright per explicit instruction --
// this card never renders anything but a division's real signed SF gap (or
// an empty-state message if that division has no resolvable rows), no
// special-cased row.
//
// airtableFetchFailed (2026-09-15, confirmed root cause of a real board-
// facing incident): an empty `buckets` array is ambiguous on its own -- it's
// what a genuine "no divisions resolved" result looks like, but it's ALSO
// exactly what a failed Airtable fetch produces (computeDepartmentSpaceGrowth
// can't create a single row without a resolvable per-room Airtable area, see
// spaceGrowthCalc.js), which is what actually happened on this dashboard's
// first production load -- a Render cold-start timeout silently emptied this
// card while every other section rendered normally, and the generic "No
// division-level gaps available" message read as broken/finished rather than
// "still loading, try again." ExecutiveDashboardPanel.jsx's runCalculation
// now threads that distinction through explicitly instead of leaving the UI
// to guess from an empty array alone.
function SpaceGapCard({ buckets, airtableFetchFailed }) {
  const width = 520;
  const rowHeight = 34;
  const centerX = width / 2;
  const halfWidth = width / 2 - 70;
  const barHeight = 14;
  const maxAbsGap = Math.max(...buckets.filter((b) => b.gapTarget != null).map((b) => Math.abs(b.gapTarget)), 1);
  // Height reflects however many buckets actually render this call -- never
  // a hardcoded row count -- so this SVG never over- or under-allocates
  // vertical space relative to its own content, whatever that count is.
  const height = rowHeight * buckets.length;

  return (
    <div style={cardShellStyle({ background: COLORS.neutralTint })}>
      <div style={{ fontSize: 12.5, fontWeight: 700, color: COLORS.heading, marginBottom: 8 }}>
        Space Gap by Division
      </div>
      {!buckets.length ? (
        <div style={{ fontSize: 11, color: COLORS.muted }}>
          {airtableFetchFailed
            ? 'Space data is still loading -- click Recalculate to try again.'
            : 'No division-level gaps available.'}
        </div>
      ) : (
        <svg viewBox={`0 0 ${width} ${height}`} style={{ width: '100%', height: 'auto' }}>
          <line x1={centerX} y1={0} x2={centerX} y2={height - 8} stroke={COLORS.border} strokeWidth={1} />
          {buckets.map((b, i) => {
            const rowY = i * rowHeight;
            const barY = rowY + 12;
            return (
              <React.Fragment key={b.label}>
                <text x={4} y={rowY + 9} fontSize={10.5} fill={COLORS.label}>{b.label}</text>
                {b.gapTarget == null ? (
                  <text x={width - 4} y={barY + barHeight - 3} fontSize={10.5} fill={COLORS.muted} textAnchor="end">No data</text>
                ) : (
                  (() => {
                    const isShortage = b.gapTarget < 0;
                    const magnitude = (Math.abs(b.gapTarget) / maxAbsGap) * halfWidth;
                    const barX = isShortage ? centerX - magnitude : centerX;
                    const barWidth = Math.max(magnitude, 3);
                    const valueX = isShortage ? centerX - magnitude - 6 : centerX + magnitude + 6;
                    return (
                      <>
                        <rect x={barX} y={barY} width={barWidth} height={barHeight} rx={2} fill={isShortage ? COLORS.red : COLORS.green} />
                        <text x={valueX} y={barY + barHeight - 3} fontSize={10.5} fontWeight={700} fill={COLORS.heading} textAnchor={isShortage ? 'end' : 'start'}>
                          {formatGapSf(b.gapTarget)}
                        </text>
                      </>
                    );
                  })()
                )}
              </React.Fragment>
            );
          })}
        </svg>
      )}
    </div>
  );
}

// --- Capital Phasing timeline --------------------------------------------
// Deliberately not a full Gantt: one thin bar per near-term project spanning
// [next phase start -> completion] on a shared date axis, a dashed "Today"
// marker, endpoint date labels, and yearly tick marks for every calendar
// year boundary strictly between the axis's start/end -- the fix that was
// still outstanding for the live view (the PDF export already had it).
function PhasingTimelineCard({ nearTerm }) {
  return (
    <div style={cardShellStyle({ background: COLORS.neutralTint })}>
      <div style={{ fontSize: 12.5, fontWeight: 700, color: COLORS.heading, marginBottom: 8 }}>
        Capital Phasing Timeline (Next ~2 Years)
      </div>
      {!nearTerm.length ? (
        <div style={{ fontSize: 11, color: COLORS.muted }}>No near-term projects.</div>
      ) : (
        (() => {
          const width = 520;
          const rowHeight = 24;
          const axisX0 = 6;
          const axisX1 = width - 6;
          const axisWidth = axisX1 - axisX0;
          const edgeClearance = 38;

          const now = new Date();
          const starts = nearTerm.map((p) => new Date(p.nextPhaseStart).getTime());
          const ends = nearTerm.map((p) => new Date(p.completionDate).getTime());
          const minTime = Math.min(now.getTime(), ...starts);
          const maxTime = Math.max(...ends, minTime + 1);
          const span = maxTime - minTime;
          const xForTime = (ms) => axisX0 + ((ms - minTime) / span) * axisWidth;

          const barsTop = 22;
          const axisY = barsTop + nearTerm.length * rowHeight + 8;
          const height = axisY + 30;

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
            <svg viewBox={`0 0 ${width} ${height}`} style={{ width: '100%', height: 'auto' }}>
              {nearTerm.map((p, i) => {
                const rowY = barsTop + i * rowHeight;
                const x0 = xForTime(new Date(p.nextPhaseStart).getTime());
                const x1 = xForTime(new Date(p.completionDate).getTime());
                return (
                  <React.Fragment key={p.projectId}>
                    <text x={axisX0} y={rowY - 3} fontSize={9.5} fill={COLORS.label}>{p.projectName}</text>
                    <rect
                      x={Math.min(x0, x1)} y={rowY} width={Math.max(x1 - x0, 5)} height={9}
                      rx={2} fill={COLORS.blue}
                    />
                  </React.Fragment>
                );
              })}

              <line x1={axisX0} y1={axisY} x2={axisX1} y2={axisY} stroke={COLORS.border} strokeWidth={1} />

              <line
                x1={todayX} y1={10} x2={todayX} y2={axisY}
                stroke={COLORS.muted} strokeWidth={1} strokeDasharray="3,3"
              />
              {showTodayLabel ? (
                <text x={todayX} y={9} fontSize={9} fill={COLORS.muted} textAnchor="middle">Today</text>
              ) : null}

              {yearTicks.map((t) => {
                const tx = xForTime(t);
                const showLabel = tx - axisX0 > edgeClearance && axisX1 - tx > edgeClearance;
                return (
                  <React.Fragment key={t}>
                    <line x1={tx} y1={axisY - 4} x2={tx} y2={axisY + 4} stroke={COLORS.border} strokeWidth={1} />
                    {showLabel ? (
                      <text x={tx} y={axisY + 15} fontSize={9} fill={COLORS.muted} textAnchor="middle">
                        {new Date(t).getUTCFullYear()}
                      </text>
                    ) : null}
                  </React.Fragment>
                );
              })}

              <text x={axisX0} y={axisY + 15} fontSize={9} fill={COLORS.muted}>
                {new Date(minTime).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}
                {minTime === now.getTime() ? ' (today)' : ''}
              </text>
              <text x={axisX1} y={axisY + 15} fontSize={9} fill={COLORS.muted} textAnchor="end">
                {new Date(maxTime).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}
              </text>
            </svg>
          );
        })()
      )}
    </div>
  );
}

// --- Capital Priorities Tier 1 list ---------------------------------------
// Score-based color coding within Tier 1 (80-100): higher score = more
// urgent within the already-most-urgent tier, using the same red/amber/green
// trio as the gauge bands above rather than a fourth palette.
function urgencyColor(total) {
  if (total >= 94) return COLORS.red;
  if (total >= 87) return COLORS.amber;
  return COLORS.green;
}

// Compact WRAPPING row of chips (not a one-per-line vertical list) -- this
// card is back to its own full-width row below the SpaceGap/Phasing grid
// (see that grid's comment above), and a tall narrow list there left most
// of the row's width blank beside it, which was the actual "original
// blank-space problem" this card was condensed to avoid. Chips wrap
// left-to-right, filling that width directly; each chip carries the same
// dot/name/score/cost fields the old list rows did, just laid out inline
// and allowed to wrap onto a second line only if there are enough Tier 1
// buildings to need it.
function Tier1ListCard({ tier1Summary }) {
  return (
    <div style={cardShellStyle({ background: COLORS.neutralTint })}>
      <div style={{ fontSize: 12.5, fontWeight: 700, color: COLORS.heading, marginBottom: 6 }}>
        Capital Compass — Tier 1
      </div>
      {!tier1Summary.tier1Count ? (
        <div style={{ fontSize: 11, color: COLORS.muted }}>No Tier 1 buildings currently.</div>
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {tier1Summary.tier1Buildings.map((b) => (
            <div
              key={b.buildingId}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '4px 8px',
                borderRadius: 999,
                background: '#fff',
                border: `1px solid ${COLORS.cardBorder}`
              }}
            >
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: urgencyColor(b.total), flexShrink: 0 }} />
              <span style={{ fontSize: 11, fontWeight: 600, color: COLORS.heading, whiteSpace: 'nowrap' }}>
                {b.originalId}
              </span>
              <span style={{ fontSize: 10, color: COLORS.muted }}>{b.total}</span>
              <span style={{ fontSize: 11, fontWeight: 700, color: COLORS.heading, whiteSpace: 'nowrap' }}>
                {b.resolvedCost != null ? formatUsdCompact(b.resolvedCost) : '—'}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function ExecutiveDashboardModal({ data, loading, loadError, onRecalculate, onExportPdf, onClose }) {
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 10010,
        display: 'grid',
        placeItems: 'center',
        background: 'rgba(0,0,0,0.45)'
      }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="mf-ai-modal-panel"
        style={{
          // Narrowed back down per Clark's explicit before/after comparison
          // (2026-09-15): at 1100px the 2-gauge row (each gauge card fixed
          // at flex '0 1 190px', see Gauge's own comment) only fills ~390px
          // of a ~1068px content area, leaving a large dead margin on both
          // sides. 1100px has no other reference point in this codebase --
          // this file is untracked/new with no git history to diff against,
          // but every other .mf-ai-modal-panel usage in StakeholderMap.jsx
          // caps out at 760px (the single most common value, used by 6 of
          // 11 other modals; narrower ones go down to 520px for lighter
          // content) -- 1100px is a clear outlier against that established
          // convention, not a deliberate one-off. Reverted to that same
          // 760px convention rather than a bespoke number. At 760px (728px
          // content after the 16px padding each side), the KPI row's 4 cards
          // (auto-fit, minmax 170px) still fit on one line, the Space
          // Gap/Capital Priorities/Capital Phasing grid (minmax 320px per
          // column) still fits without its own overflow, and the gauge
          // row's dead-margin flanks shrink from ~678px combined down to
          // ~338px -- roughly half -- since a single shared modal width
          // can't be simultaneously snug for both the ~390px-wide gauge row
          // and the ~652px-wide 2-column grid below it.
          width: 'min(760px, 92vw)',
          maxHeight: '90vh',
          overflow: 'auto',
          padding: 16
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ fontWeight: 800, fontSize: 18, color: COLORS.heading }}>Executive Dashboard</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn" type="button" onClick={onRecalculate} disabled={loading}>
              {loading ? 'Calculating…' : 'Recalculate'}
            </button>
            <button className="btn secondary" type="button" onClick={onExportPdf} disabled={!data}>Export to PDF</button>
            <button className="btn" type="button" onClick={onClose}>Close</button>
          </div>
        </div>

        {loadError ? <div style={{ marginTop: 10, fontSize: 11.5, color: COLORS.red }}>{loadError}</div> : null}

        {loading && !data ? (
          <div style={{ marginTop: 16, fontSize: 12, color: COLORS.muted }}>Calculating…</div>
        ) : data ? (
          <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 14 }}>
            <KpiRow data={data} />
            <GaugeRow data={data} />
            {/* Reverted from last round's single 3-column row (SpaceGapCard/
                PhasingTimelineCard/Tier1ListCard all in one grid) back
                toward the original narrower 2-up + stacked arrangement, per
                Clark's explicit "revert to something closer to the
                original... stacked card arrangement" instruction. Tier 1 is
                structurally adjacent to Space Gap, not a separate full-width
                row down the page.
                Left column is a plain flex column (SpaceGapCard + Tier1ListCard
                stacked, each sized purely by its own content), NOT a 2-row
                CSS Grid area spanned by Capital Phasing -- an earlier version
                used grid-template-areas with Phasing spanning both rows, which
                real rendering (headless Chrome, several data shapes,
                2026-09-15) proved forces the "auto" row TRACKS themselves
                (not just the items) to grow so their combined height fits
                Phasing's content, whichever of Space Gap/Tier 1 happened to
                be the shorter row absorbing the slack as dead space below its
                own content -- alignItems:'start' keeps each CARD pinned to
                the top of its own cell, but does nothing about the cell
                itself being taller than the card needs. A plain flex column
                has no such row-track concept: each card here always renders
                at exactly its own natural height, with any real mismatch
                between the two columns' total heights showing as a single
                gap below the shorter column as a whole, never inflating an
                individual card. */}
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'minmax(320px, 1fr) minmax(320px, 1fr)',
                gap: 12,
                alignItems: 'start'
              }}
            >
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
                <SpaceGapCard buckets={data.spaceGapBuckets} airtableFetchFailed={data.airtableFetchFailed} />
                <Tier1ListCard tier1Summary={data.tier1Summary} />
              </div>
              <div style={{ minWidth: 0 }}>
                <PhasingTimelineCard nearTerm={data.phasingSummary.nearTerm} />
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
