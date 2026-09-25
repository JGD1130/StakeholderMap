// src/components/mf/pdf/PdfPrimitives.jsx
//
// @react-pdf/renderer versions of the mf/ card pieces (ChartCard, KpiCard,
// legend), styled from the same tokens. Units are points. Minimum text size
// 9pt (the page footer alone may use 8pt).
import React from 'react';
import { View, Text } from '@react-pdf/renderer';
import { MF } from '../../../theme/mfTokens';

export const PDF_FONT = 'Helvetica';
export const PDF_FONT_BOLD = 'Helvetica-Bold';
export const PDF_MIN_FONT = 9;

// react-pdf's built-in Helvetica only covers WinAnsi characters; the true
// minus sign (U+2212) isn't one of them and would render blank. Swap it for
// an en dash, which reads the same at these sizes. The screen keeps U+2212.
export function pdfSafe(text) {
  return text == null ? text : String(text).replace(/−/g, '–');
}

const cardStyle = {
  backgroundColor: MF.surface.card,
  borderWidth: 1,
  borderColor: MF.line.border,
  borderRadius: 6,
  paddingVertical: 8,
  paddingHorizontal: 10
};

// Title (11pt bold), optional subtitle and footnote (9pt muted), children between.
export function PdfChartCard({ title, subtitle, footnote, width, style, children }) {
  return (
    <View style={[cardStyle, { width }, style]} wrap={false}>
      {title ? <Text style={{ fontFamily: PDF_FONT_BOLD, fontSize: 11, color: MF.ink.primary }}>{pdfSafe(title)}</Text> : null}
      {subtitle ? <Text style={{ fontSize: 9, color: MF.ink.muted, marginTop: 3 }}>{pdfSafe(subtitle)}</Text> : null}
      <View style={{ marginTop: title || subtitle ? 7 : 0 }}>{children}</View>
      {footnote ? <Text style={{ fontSize: 9, color: MF.ink.muted, marginTop: 6 }}>{pdfSafe(footnote)}</Text> : null}
    </View>
  );
}

// KpiCard: value, uppercase label, context line; a missing value shows "—"
// with the reason. `indicator` = 3pt left accent bar (surplus / deficit);
// never a tinted background, never colored text.
export function PdfKpiCard({ value, label, context, missing, indicator, width }) {
  const isMissing = value === null || value === undefined || Boolean(missing);
  const accent = indicator === 'deficit' ? MF.diverging.deficit : indicator === 'surplus' ? MF.diverging.surplus : null;
  return (
    <View style={[cardStyle, { width, position: 'relative', paddingLeft: accent ? 13 : 10 }]} wrap={false}>
      {accent ? (
        <View
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            bottom: 0,
            width: 3,
            backgroundColor: accent,
            borderTopLeftRadius: 6,
            borderBottomLeftRadius: 6
          }}
        />
      ) : null}
      <Text style={{ fontFamily: PDF_FONT_BOLD, fontSize: 16, color: MF.ink.primary }}>{pdfSafe(isMissing ? '—' : String(value))}</Text>
      <Text style={{ fontSize: 9, color: MF.ink.muted, marginTop: 3, textTransform: 'uppercase' }}>{pdfSafe(label)}</Text>
      {(isMissing && missing?.reason) || context ? (
        <Text style={{ fontSize: 9, color: MF.ink.secondary, marginTop: 2 }}>
          {pdfSafe(isMissing && missing?.reason ? missing.reason : context)}
        </Text>
      ) : null}
    </View>
  );
}

// "■ Deficit ■ Surplus" -- items: [{ key, label, color }]
export function PdfLegend({ items }) {
  if (!items?.length) return null;
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginBottom: 6 }}>
      {items.map((item) => (
        <View key={item.key} style={{ flexDirection: 'row', alignItems: 'center', marginRight: 12 }}>
          <View style={{ width: 8, height: 8, borderRadius: 1.5, backgroundColor: item.color, marginRight: 4 }} />
          <Text style={{ fontSize: 9, color: MF.ink.muted }}>{item.label}</Text>
        </View>
      ))}
    </View>
  );
}

export function PdfMutedLine({ children }) {
  return <Text style={{ fontSize: 9, color: MF.ink.muted }}>{pdfSafe(children)}</Text>;
}
