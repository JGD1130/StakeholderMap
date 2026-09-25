// src/components/mf/pdf/PdfScoreTable.jsx
//
// react-pdf version of ScoreTable: Rank · Building · Score (0-100 bar in
// MF.tier[1] + number) · Est. cost (right-aligned). White table on the gray
// card, hairline row rules. Rows arrive ranked from executiveDashboardView.js.
import React from 'react';
import { View, Text } from '@react-pdf/renderer';
import { MF } from '../../../theme/mfTokens';
import { PDF_FONT_BOLD } from './PdfPrimitives';

const RANK_W = 28;
const SCORE_W = 84;
const COST_W = 52;
const BAR_W = 44;

const headerText = { fontSize: 9, color: MF.ink.muted, textTransform: 'uppercase' };
const rowStyle = { flexDirection: 'row', alignItems: 'center', paddingVertical: 4, paddingHorizontal: 6, borderBottomWidth: 0.75, borderBottomColor: MF.line.hairline };

export default function PdfScoreTable({ rows, barColor = MF.tier[1] }) {
  return (
    <View style={{ backgroundColor: MF.surface.page }}>
      <View style={rowStyle}>
        <Text style={[headerText, { width: RANK_W }]}>Rank</Text>
        <Text style={[headerText, { flex: 1 }]}>Building</Text>
        <Text style={[headerText, { width: SCORE_W }]}>Score</Text>
        <Text style={[headerText, { width: COST_W, textAlign: 'right' }]}>Est. cost</Text>
      </View>
      {rows.map((row) => {
        const score = Math.max(0, Math.min(100, Number(row.score) || 0));
        return (
          <View key={row.key} style={rowStyle} wrap={false}>
            <Text style={{ width: RANK_W, fontSize: 9, color: MF.ink.muted }}>{row.rank}</Text>
            <Text style={{ flex: 1, fontSize: 9, fontFamily: PDF_FONT_BOLD, color: MF.ink.primary }}>{row.name}</Text>
            <View style={{ width: SCORE_W, flexDirection: 'row', alignItems: 'center' }}>
              <View style={{ width: BAR_W, height: 5, borderRadius: 2.5, backgroundColor: MF.line.hairline }}>
                <View style={{ width: (BAR_W * score) / 100, height: 5, borderRadius: 2.5, backgroundColor: barColor }} />
              </View>
              <Text style={{ fontSize: 9, color: MF.ink.primary, marginLeft: 5 }}>{row.score}</Text>
            </View>
            <Text style={{ width: COST_W, fontSize: 9, color: MF.ink.primary, textAlign: 'right' }}>{row.costLabel}</Text>
          </View>
        );
      })}
    </View>
  );
}
