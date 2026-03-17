import fs from 'node:fs'
import path from 'node:path'

const repoRoot = process.cwd()
const stakeMapPath = path.join(repoRoot, 'src', 'components', 'StakeholderMap.jsx')
const source = fs.readFileSync(stakeMapPath, 'utf8')

const checks = []

function mustContain(label, fragment) {
  checks.push({ label, ok: source.includes(fragment), detail: fragment })
}

function mustNotContain(label, fragment) {
  checks.push({ label, ok: !source.includes(fragment), detail: fragment })
}

mustContain('Directional halve button exists: vertical', 'Halve Vertical')
mustContain('Directional halve button exists: horizontal', 'Halve Horizontal')
mustNotContain('Legacy auto halve button removed', 'Halve Room')

mustContain('Engagement marker persists roomId', "roomId: String(roomContext?.roomId || '').trim()")
mustContain('Engagement marker persists roomNumber', "roomNumber: String(roomContext?.roomNumber || '').trim()")
mustContain('Engagement marker persists roomLabel', "roomLabel: String(roomContext?.roomLabel || '').trim()")
mustContain('Engagement marker persists roomGuid', "roomGuid: String(roomContext?.roomGuid || '').trim()")
mustContain('Engagement marker persists revitId', "revitId: String(roomContext?.revitId || '').trim()")

mustContain('Engagement help close wired to X button', 'onClick={closeEngagementHelp}')
mustContain('Engagement help close wired to Close button', 'className="close-button-main" onClick={closeEngagementHelp}')

mustContain('Green heat halo layer id defined', "ENGAGEMENT_HEAT_RARELY_HALO_LAYER_ID = 'engagement-heat-rarely-halo-layer'")
mustContain('Green heat halo layer added as heatmap', "id: ENGAGEMENT_HEAT_RARELY_HALO_LAYER_ID")
mustContain('Green heat halo uses heatmap type', "type: 'heatmap'")

const failed = checks.filter((c) => !c.ok)
const passed = checks.length - failed.length

console.log(`[smoke] ${passed}/${checks.length} checks passed`)
if (failed.length) {
  failed.forEach((c) => {
    console.error(`[smoke] FAIL: ${c.label}`)
    console.error(`        expected condition involving: ${c.detail}`)
  })
  process.exit(1)
}

console.log('[smoke] All critical engagement/scenario guardrails look good.')
