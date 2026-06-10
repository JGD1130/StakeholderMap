# Deploy Environment Variables Checklist
Date: April 3, 2026
Scope: Stakeholder Map production deploys

## Primary Production Path (GitHub Pages)
This repo deploys the frontend from GitHub Actions workflow:
- `.github/workflows/deploy.yml`

The build now injects:
- `VITE_MAPBOX_PUBLIC_TOKEN` from `secrets.VITE_MAPBOX_PUBLIC_TOKEN`

## Required Frontend Variable
`VITE_MAPBOX_PUBLIC_TOKEN`
- Purpose: provides a Mapbox public token at build time so first-time users are not prompted.
- Where to set: GitHub repo `Settings` -> `Secrets and variables` -> `Actions` -> `New repository secret`.
- Secret name: `VITE_MAPBOX_PUBLIC_TOKEN`
- Secret value: your Mapbox public token (`pk...`).

## Optional Frontend Variables
`VITE_AI_BASE_URL`
- Purpose: override AI backend URL in frontend.
- Default: `https://github-stakeholder-ai.onrender.com`

`VITE_SCENARIO_OP_PERSIST`
- Purpose: enable scenario operation persistence feature flag.
- Default: `false`

## Backend Variables (AI Server)
Set on the backend host (not GitHub Pages frontend build):
- Required: `OPENAI_API_KEY`
- Common: `AIRTABLE_TOKEN`, `AIRTABLE_BASE_ID`, `AIRTABLE_TABLE`, `AIRTABLE_VIEW`

## Optional Backend AI Usage Logging
These support lightweight month-by-month AI usage tracking on the AI server:
- `AI_USAGE_LOG_ENABLED`
  - Default: `true`
  - Purpose: turns structured AI usage logging on/off.
- `AI_USAGE_LOG_TO_FILE`
  - Default: `true`
  - Purpose: appends JSONL usage records to monthly files on the backend host.
- `AI_USAGE_LOG_DIR`
  - Default: `ai-server/logs`
  - Purpose: override where monthly `ai-usage-YYYY-MM.jsonl` files are stored.
- `AI_USAGE_SUMMARY_MAX_MONTHS`
  - Default: `12`
  - Purpose: limits the number of months returned by the summary endpoint.

With file logging enabled, the AI server also exposes:
- `GET /ai/usage-summary`
- Example: `/ai/usage-summary?months=6`

## Pre-Deploy Env Check (2 Minutes)
1. GitHub -> Actions secrets includes `VITE_MAPBOX_PUBLIC_TOKEN`.
2. Workflow file still maps secret into build env.
3. Run or trigger deploy.
4. Open production route `/hastings` in a fresh/incognito browser.
5. Confirm map loads without a token prompt modal.

## Security Notes
- Never commit real tokens into repo files.
- Restrict Mapbox token allowed URLs to production domains (example: `https://jgd1130.github.io/*`).
- Rotate token and update GitHub secret if token exposure is suspected.
