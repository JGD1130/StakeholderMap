// scripts/check-mf-tokens.mjs
//
// Asserts src/theme/mfTokens.js reproduces the existing utilization colors:
// the Day/Time heat map anchors and the Executive Dashboard gauge's original
// 8 hard-coded stops. Run: npm run check:tokens
import assert from 'node:assert/strict';
import { register } from 'node:module';

// The app's source uses extensionless relative imports (Vite resolves them);
// teach Node to retry those with ".js".
register(
  'data:text/javascript,' + encodeURIComponent(`
    export async function resolve(specifier, context, next) {
      try {
        return await next(specifier, context);
      } catch (error) {
        const relative = specifier.startsWith('./') || specifier.startsWith('../');
        if (relative && !/\\.[cm]?jsx?$/.test(specifier)) return next(specifier + '.js', context);
        throw error;
      }
    }
  `)
);

const { MF, utilColor, utilTextColor, utilBands } = await import('../src/theme/mfTokens.js');

// WCAG relative luminance and contrast ratio for #rrggbb colors.
function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// The shared Gauge's real arc colors (gaugeGeometry.js is plain JS, no React).
const { GAUGE_BANDS, GAUGE_TRACK } = await import('../src/components/mf/gaugeGeometry.js');
const MIN_FIRST_BAND_CONTRAST = 1.25;
const firstBandContrast = contrast(GAUGE_BANDS[0], GAUGE_TRACK);

// Hard-coded in ExecutiveDashboardModal.jsx / ExecutiveDashboardPdfDocument.jsx
// before Phase 1 Step 2 replaced them with utilBands(8).
const OLD_GAUGE_BANDS = ['#e2ebfc', '#ccdbfa', '#b6cbf8', '#9fbbf6', '#89abf4', '#739bf2', '#5c8bf0', '#467bee'];

const checks = [
  ['utilColor(0) === #eef3fd', () => assert.equal(utilColor(0), '#eef3fd')],
  ['utilColor(50) === #94b3f5', () => assert.equal(utilColor(50), '#94b3f5')],
  ['utilColor(100) === #3b73ed', () => assert.equal(utilColor(100), '#3b73ed')],
  ['utilColor clamps (-10 -> 0, 150 -> 100, NaN -> 0)', () => {
    assert.equal(utilColor(-10), utilColor(0));
    assert.equal(utilColor(150), utilColor(100));
    assert.equal(utilColor(NaN), utilColor(0));
  }],
  ['utilBands(8) equals the old gauge array', () => assert.deepEqual(utilBands(8), OLD_GAUGE_BANDS)],
  ['utilBands(8, { from: 0, to: 100 }) equals the default', () => assert.deepEqual(utilBands(8, { from: 0, to: 100 }), utilBands(8))],
  [
    `Gauge first band ${GAUGE_BANDS[0]} vs track ${GAUGE_TRACK}: contrast ${firstBandContrast.toFixed(2)}:1 (>= ${MIN_FIRST_BAND_CONTRAST}:1)`,
    () => assert.ok(firstBandContrast >= MIN_FIRST_BAND_CONTRAST, `contrast ${firstBandContrast.toFixed(3)}:1 is below ${MIN_FIRST_BAND_CONTRAST}:1`)
  ],
  ['utilTextColor switches above 55', () => {
    assert.equal(utilTextColor(55), MF.ink.secondary);
    assert.equal(utilTextColor(56), '#fff');
  }],
  ['MF.util.target is 0.65 (from INDUSTRY_TARGET_TIME_UTILIZATION)', () => assert.equal(MF.util.target, 0.65)],
  ['MF.brand.headerOrange is #cb421e (from brandColors.js)', () => assert.equal(MF.brand.headerOrange, '#cb421e')]
];

let failed = 0;
for (const [name, run] of checks) {
  try {
    run();
    console.log(`PASS  ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL  ${name}\n      ${error.message.split('\n').join('\n      ')}`);
  }
}
console.log(`\n${checks.length - failed}/${checks.length} checks passed.`);
process.exit(failed ? 1 : 0);
