// src/components/mf/pdf/PdfGauge.jsx
//
// react-pdf gauge. Geometry and arc colors come from the same
// computeGaugeGeometry the screen Gauge uses, so the two can't drift; only
// the font sizes are scaled for print.
import React from 'react';
import { View, Text, Svg, G, Line, Path, Circle, Text as SvgText } from '@react-pdf/renderer';
import { MF, utilColor } from '../../../theme/mfTokens';
import { computeGaugeGeometry } from '../gaugeGeometry';
import { PDF_FONT_BOLD } from './PdfPrimitives';

const LABEL_FONT = 9;
const VALUE_FONT = 18;

export default function PdfGauge({ width, value, target = MF.util.target, title, pill }) {
  const g = computeGaugeGeometry({ width, value, target, labelFont: LABEL_FONT, valueFont: VALUE_FONT });
  return (
    <View style={{ width, alignItems: 'center' }} wrap={false}>
      {title ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', marginBottom: 2 }}>
          <Text style={{ fontFamily: PDF_FONT_BOLD, fontSize: 10, color: MF.ink.primary }}>{title}</Text>
          {pill ? (
            <Text
              style={{
                marginLeft: 5,
                paddingVertical: 1,
                paddingHorizontal: 5,
                borderRadius: 6,
                fontSize: 9,
                fontFamily: PDF_FONT_BOLD,
                color: MF.util.base,
                backgroundColor: utilColor(10)
              }}
            >
              {pill}
            </Text>
          ) : null}
        </View>
      ) : null}
      <Svg width={g.width} height={g.height} viewBox={`0 0 ${g.width} ${g.height}`}>
        {g.segments.map((s) => (
          <Path key={`${s.from}-${s.to}`} d={s.d} stroke={s.color} strokeWidth={g.stroke} strokeLinecap="butt" fill="none" />
        ))}
        {g.tick ? (
          <G>
            <Line x1={g.tick.x1} y1={g.tick.y1} x2={g.tick.x2} y2={g.tick.y2} stroke={MF.ink.primary} strokeWidth={2} strokeLinecap="round" />
            <SvgText x={g.tick.label.x} y={g.tick.label.y} fontSize={g.labelFont} fill={MF.ink.primary} textAnchor={g.tick.label.anchor}>
              {g.tick.label.text}
            </SvgText>
          </G>
        ) : null}
        {g.needle ? (
          <G>
            <Line x1={g.needle.x1} y1={g.needle.y1} x2={g.needle.x2} y2={g.needle.y2} stroke={MF.ink.primary} strokeWidth={2.5} strokeLinecap="round" />
            <Circle cx={g.cx} cy={g.cy} r={g.needle.pivotR - 1} fill={MF.ink.primary} />
          </G>
        ) : null}
        {g.endLabels.map((l) => (
          <SvgText key={l.text} x={l.x} y={l.y} fontSize={g.labelFont} fill={MF.ink.muted} textAnchor={l.anchor}>{l.text}</SvgText>
        ))}
        <SvgText x={g.valueLabel.x} y={g.valueLabel.y} fontSize={g.valueFont} fill={MF.ink.primary} textAnchor={g.valueLabel.anchor} style={{ fontFamily: PDF_FONT_BOLD }}>
          {g.valueLabel.text}
        </SvgText>
      </Svg>
    </View>
  );
}
