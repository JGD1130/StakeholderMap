import fs from 'node:fs'
import path from 'node:path'

const repoRoot = process.cwd()
const mapSource = fs.readFileSync(path.join(repoRoot, 'src', 'components', 'StakeholderMap.jsx'), 'utf8')
const adapterSource = fs.readFileSync(path.join(repoRoot, 'src', 'tenants', 'mapTenantAdapter.js'), 'utf8')
const checks = []

function check(label, ok, detail = '') {
  checks.push({ label, ok, detail })
}

check('Default adapter remains available', adapterSource.includes("id: 'default'"))
check('Hastings adapter owns its tenant id', adapterSource.includes("id: 'hastings'"))
check('Sarpy adapter owns its tenant id', adapterSource.includes("id: 'sarpy-county'"))
check('Cherokee adapter owns its tenant id', adapterSource.includes("id: 'cherokee-mental-health'"))
check('Hastings Airtable sync policy is enabled', adapterSource.includes("getAirtableSyncEnabled: ({ config }) => Boolean(config?.enableMapfluenceAI !== false)"))
check('Hastings uses shared room precedence', adapterSource.includes('preferAirtableRoomData: false'))
check('Sarpy owns Airtable room precedence', adapterSource.includes('preferAirtableRoomData: true'))
check('Sarpy owns public floor asset preference', adapterSource.includes('getPreferPublicFloorAsset: ({ isSarpyPublicReadonlyMode, floorplanCampus })'))
check('Sarpy avoids unavailable department endpoint', adapterSource.includes('getDepartmentOptionsEndpointEnabled: () => false'))
check('Cherokee Airtable sync is disabled', adapterSource.includes('getAirtableSyncEnabled: () => false'))
check('Cherokee has no Airtable scope hints', adapterSource.includes('getAirtableScopeHints: () => []'))
check('Shared map consumes the tenant Airtable policy', mapSource.includes('airtableSyncEnabled'))
check('Shared map consumes the tenant room policy', mapSource.includes('roomDataPolicy.preferAirtableRoomData'))
check('Shared map consumes the tenant scope policy', mapSource.includes('tenantAdapter.getAirtableScopeHints'))
check('Shared map does not restore Sarpy room precedence inline', !mapSource.includes('preferAirtableRoomData: isSarpyCountyInstance'))
check('Cherokee photo feature uses tenant runtime', !mapSource.includes("enablePhotoUpload={universityId === 'cherokee-mental-health'}"))

const failed = checks.filter((entry) => !entry.ok)
console.log(`[tenant-smoke] ${checks.length - failed.length}/${checks.length} checks passed`)
if (failed.length) {
  failed.forEach((entry) => console.error(`[tenant-smoke] FAIL: ${entry.label}${entry.detail ? ` (${entry.detail})` : ''}`))
  process.exit(1)
}
console.log('[tenant-smoke] Tenant policy boundaries look intact.')