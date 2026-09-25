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
