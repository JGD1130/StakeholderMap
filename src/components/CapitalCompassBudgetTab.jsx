// src/components/CapitalCompassBudgetTab.jsx
//
// Budget tab of the Capital Compass workspace: the budget cap (slider + number,
// saved through the shared hook), four KPIs, and the funding line -- every
// scored building in priority order, its place in the running total, and the
// dashed budget line. Each row can take a manual cost ("Edit cost"), which
// overrides every other source, or drop it again ("Use computed"). Rows,
// statuses and totals come from capitalCompassView.js fundingModel, which
// follows capitalCompassCalc.js computeFundingLine exactly.
import React, { useMemo, useState } from 'react';
import { MF } from '../theme/mfTokens';
import { MfGrid, MfCol, KpiCard, ChartCard } from './mf';
import { mfInputStyle } from './mf/mfStyles';
import { FundingLine } from './mf/charts';
import { formatUsdCompact } from '../utils/capitalCompassCalc';
import { fundingModel, budgetKpis, FUNDING_SUBTITLE, FUNDING_FOOTNOTE } from './capitalCompassView';

const linkStyle = {
  padding: 0,
  fontSize: 12,
  color: MF.ink.secondary,
  textDecoration: 'underline',
  whiteSpace: 'nowrap',
  '--mf-focus-color': MF.util.base
};

function LinkButton({ onClick, children }) {
  return (
    <button type="button" className="mf-shell-tab" onClick={onClick} style={linkStyle}>
      {children}
    </button>
  );
}

function BudgetCapControl({ data }) {
  const cap = Number(data.budgetCap) || 0;
  const sliderMax = Math.max(Number(data.knownCostTotal) || 0, cap, 1);
  const step = Math.max(1000, Math.round(sliderMax / 500));
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 16 }}>
      <input
        type="range"
        aria-label="Budget cap"
        min={0}
        max={sliderMax}
        step={step}
        value={Math.min(cap, sliderMax)}
        onChange={(e) => data.setBudgetCap(e.target.value)}
        style={{ flex: '1 1 320px', minWidth: 200, accentColor: MF.diverging.surplus }}
      />
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, fontWeight: 600, color: MF.ink.muted }}>
        $
        <input
          type="number"
          aria-label="Budget cap in dollars"
          min={0}
          step={step}
          value={Math.round(cap)}
          onChange={(e) => data.setBudgetCap(e.target.value)}
          style={{ ...mfInputStyle, width: 150, fontVariantNumeric: 'tabular-nums' }}
        />
      </label>
      <span style={{ fontSize: 12, color: MF.ink.secondary }}>
        All known costs: {formatUsdCompact(data.knownCostTotal)}
      </span>
    </div>
  );
}

// "Edit cost" / inline input / "Use computed" for one funding-line row.
function CostActions({ row, editing, draft, onStartEdit, onDraftChange, onSave, onCancel, onUseComputed }) {
  if (editing) {
    return (
      <>
        <input
          type="number"
          min={0}
          autoFocus
          aria-label={`Manual cost for ${row.name}`}
          value={draft}
          onChange={(e) => onDraftChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onSave();
            if (e.key === 'Escape') { e.stopPropagation(); onCancel(); }
          }}
          style={{ ...mfInputStyle, width: 120 }}
        />
        <LinkButton onClick={onSave}>Save</LinkButton>
        <LinkButton onClick={onCancel}>Cancel</LinkButton>
      </>
    );
  }
  return (
    <>
      <LinkButton onClick={onStartEdit}>Edit cost</LinkButton>
      {row.source === 'manual' ? <LinkButton onClick={onUseComputed}>Use computed</LinkButton> : null}
    </>
  );
}

export default function CapitalCompassBudgetTab({ data }) {
  const model = useMemo(() => fundingModel(data), [data]);
  const [editingKey, setEditingKey] = useState(null);
  const [draft, setDraft] = useState('');

  const renderActions = (row) => (
    <CostActions
      row={row}
      editing={editingKey === row.key}
      draft={draft}
      onStartEdit={() => { setEditingKey(row.key); setDraft(row.amount != null ? String(Math.round(row.amount)) : ''); }}
      onDraftChange={setDraft}
      onSave={() => { data.setManualCost(row.name, draft); setEditingKey(null); }}
      onCancel={() => setEditingKey(null)}
      onUseComputed={() => data.setManualCost(row.name, null)}
    />
  );

  return (
    <MfGrid>
      <MfCol span={12}>
        <ChartCard title="Budget cap" subtitle="Buildings are funded highest score first until the next one no longer fits. Saved automatically." autoHeight>
          {() => <BudgetCapControl data={data} />}
        </ChartCard>
      </MfCol>

      {budgetKpis(data, model).map(({ key, ...props }) => (
        <MfCol key={key} span={3}>
          <KpiCard {...props} />
        </MfCol>
      ))}

      <MfCol span={12}>
        <ChartCard title="Funding Line" subtitle={FUNDING_SUBTITLE} footnote={model.rows.length ? FUNDING_FOOTNOTE : null} autoHeight>
          {() => (model.rows.length ? (
            <FundingLine
              rows={model.rows}
              axisMax={model.axisMax}
              budgetCap={model.budgetCap}
              budgetLabel={`Budget ${formatUsdCompact(model.budgetCap)}`}
              formatAmount={formatUsdCompact}
              renderActions={renderActions}
              ariaLabel="Funding line: scored buildings in priority order against the budget cap"
            />
          ) : (
            <div style={{ fontSize: 12, color: MF.ink.muted }}>No buildings scored yet.</div>
          ))}
        </ChartCard>
      </MfCol>
    </MfGrid>
  );
}
