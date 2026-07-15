import fs from 'node:fs'
import path from 'node:path'

const repoRoot = process.cwd()
const stakeMapPath = path.join(repoRoot, 'src', 'components', 'StakeholderMap.jsx')
const appPath = path.join(repoRoot, 'src', 'App.jsx')
const registryPath = path.join(repoRoot, 'src', 'tenants', 'registry.js')
const hastingsConfigPath = path.join(repoRoot, 'src', 'Configs', 'Hastings.json')
const firestoreRulesPath = path.join(repoRoot, 'firestore.rules')
const source = fs.readFileSync(stakeMapPath, 'utf8')
const appSource = fs.readFileSync(appPath, 'utf8')
const registrySource = fs.readFileSync(registryPath, 'utf8')
const hastingsConfigSource = fs.readFileSync(hastingsConfigPath, 'utf8')
const firestoreRulesSource = fs.readFileSync(firestoreRulesPath, 'utf8')

const checks = []

function mustContain(label, fragment) {
  checks.push({ label, ok: source.includes(fragment), detail: fragment })
}

function mustNotContain(label, fragment) {
  checks.push({ label, ok: !source.includes(fragment), detail: fragment })
}

function appMustContain(label, fragment) {
  checks.push({ label, ok: appSource.includes(fragment), detail: fragment })
}

function registryMustContain(label, fragment) {
  checks.push({ label, ok: registrySource.includes(fragment), detail: fragment })
}

function configMustContain(label, fragment) {
  checks.push({ label, ok: hastingsConfigSource.includes(fragment), detail: fragment })
}

function rulesMustContain(label, fragment) {
  checks.push({ label, ok: firestoreRulesSource.includes(fragment), detail: fragment })
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
mustContain('Green heat halo layer added as heatmap', 'id: ENGAGEMENT_HEAT_RARELY_HALO_LAYER_ID')
mustContain('Green heat halo uses heatmap type', "type: 'heatmap'")
mustContain('Condition save handler is implemented', 'const handleConditionSave = useCallback(async (buildingIdRaw, nextConditionRaw)')
mustContain('Assessment save handler is implemented', 'const handleAssessmentSave = useCallback((savedAssessment)')
mustContain('Technical panel open sets map view', 'setMapView(MAP_VIEWS.TECHNICAL);')

appMustContain('Technical standalone route exists', 'path="/:universityId/technical"')
appMustContain('Client route exists', 'path="/:universityId/client"')
appMustContain('Legacy admin workflow redirect component exists', 'function LegacyAdminWorkflowRedirect()')
appMustContain('Legacy admin engagement redirects to full admin', 'path="/:universityId/admin/engagement" element={<LegacyAdminWorkflowRedirect />}')
appMustContain('Legacy admin technical redirects to full admin', 'path="/:universityId/admin/technical" element={<LegacyAdminWorkflowRedirect />}')
appMustContain('Canonical tenant id helper is imported', "import { getTenantConfigId, getTenantId, resolveTenant } from './tenants/registry';")
appMustContain('Canonical tenant id is resolved before route rendering', 'const canonicalUniversityId = getTenantId(universityId);')
appMustContain('Client workspace gate accepts viewer editor and admin', 'title="Client Workspace" requiredRoles={[\'viewer\', \'editor\', \'admin\']}')
appMustContain('Internal admin gate is admin only', 'title="Internal Admin Workspace" requiredRoles={[\'admin\']}')
appMustContain('Secure gate signed-out copy exists', 'Sign in to continue.')
appMustContain('Secure gate unauthorized copy exists', 'does not currently have access to this workspace.')
appMustContain('Secure gate role assignment guidance exists', 'Ask an admin to assign the correct Hastings role (`viewer`, `editor`, or `admin`).')

mustContain('Admin engagement marker placement gated by admin role', '? (isAdminUser && stakeholderWorkflowActive && !isTechnicalPanelOpen)')
mustContain('Full admin Engagement marker tools use shared workflow mode', 'if (!(adminEngagementToolsMode && stakeholderWorkflowActive)) return [];')
mustContain('Archive selected requires admin role', 'Admin sign-in required for marker archive actions.')
mustContain('Permanent delete requires admin role', 'Admin sign-in required for permanent delete.')
mustContain('Building condition toggle disabled for non-admin', 'disabled={!isAdminUser}')
mustContain('Admin engagement read-only marker message shown', 'Read-only: sign in as campus admin to add markers in this admin route.')
mustContain('Client access controls appear in shared header', "const showAuthAccessControls = isAdminMode || isClientMode;")
mustContain('Client header shows read-only summary', "? 'Read-only access'")
mustContain('Client header shows room edit summary', "? 'Room edits enabled'")
mustContain('Client workspace title is defined', 'title: `${activeUniversityName} Client Workspace`,')
mustContain('Single-option map view selector stays hidden', 'const showMapViewSelector = visibleMapViewOptions.length > 1 || isTechnicalOnlyMode;')
mustContain('Room edit feature flag is read from config or tenant', 'const roomEditEnabledForCurrentTenant = (config?.enableRoomEdit ?? tenant?.features?.enableRoomEdit ?? false) === true;')
mustContain('Role management feature flag is read from config or tenant', 'const roleManagementEnabled = (config?.enableRoleManagement ?? tenant?.features?.enableRoleManagement ?? false) === true;')
mustContain('Client room edit writes allow editor and admin', "return userRole === 'editor' || userRole === 'admin';")
mustContain('Read-only client users cannot keep room edit modal open', 'if (roomEditCanWrite) return;')
mustContain('Room edit save reports failed saves distinctly', "alert('Failed to save the selected room changes. Please try again.');")
mustContain('Room edit save reports partial failures distinctly', "Reopen the rooms to verify and retry.")

registryMustContain('Hastings alias list includes public and demo slugs', "aliases: ['hastings', 'hastings-demo']")
registryMustContain('Hastings maintenance workflow disabled in tenant registry', 'enableMaintenanceWorkflow: false,')
registryMustContain('Hastings room edit enabled in tenant registry', 'enableRoomEdit: true,')
registryMustContain('Hastings client auth required in tenant registry', 'requireClientAuth: true,')
registryMustContain('Hastings client route configured in tenant registry', "clientWorkspaceRoute: 'client',")
registryMustContain('Hastings role management enabled in tenant registry', 'enableRoleManagement: true')
registryMustContain('Canonical tenant id helper exists in registry', 'export function getTenantId(universityId) {')

configMustContain('Hastings maintenance workflow disabled in config', '"enableMaintenanceWorkflow": false')
configMustContain('Hastings room edit enabled in config', '"enableRoomEdit": true')
configMustContain('Hastings client auth required in config', '"requireClientAuth": true')
configMustContain('Hastings client route configured in config', '"clientWorkspaceRoute": "client"')
configMustContain('Hastings role management enabled in config', '"enableRoleManagement": true')

rulesMustContain('Viewer helper exists in Firestore rules', 'function isUniversityViewer(universityId) {')
rulesMustContain('Editor helper exists in Firestore rules', 'function isUniversityEditor(universityId) {')
rulesMustContain('Admin helper exists in Firestore rules', 'function isUniversityAdmin(universityId) {')
rulesMustContain('Role docs are self-readable or admin-readable', 'allow read: if isSignedIn() && (request.auth.uid == userId || isUniversityAdmin(universityId));')
rulesMustContain('Nested room writes require editor or admin', 'allow write: if isUniversityEditor(universityId);')

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

console.log('[smoke] All critical Hastings client and shared route guardrails look good.')