# Building Resources Manifest

Populate `public/Data/building-resources.json` to drive:

- `Deferred + Condition` button in building/floor popup panels
- `Planning Docs` button in building/floor popup panels

## Minimal shape

```json
{
  "updatedAt": "2026-04-01",
  "buildings": [
    {
      "building": "Babcock Hall",
      "aliases": ["Babcock", "Babcock Hall"],
      "deferredMaintenance": {
        "summary": "Roof replacement and controls upgrade",
        "priority": "High",
        "totalLow": 450000,
        "totalHigh": 700000,
        "sourceLabel": "Deferred Maintenance Sheet",
        "sourceUrl": "https://example.com/deferred-maintenance.xlsx",
        "updatedAt": "2026-03-31",
        "items": [
          { "label": "Roof membrane", "priority": "High", "cost": 300000 },
          { "label": "HVAC controls", "priority": "Medium", "cost": 120000 }
        ]
      },
      "conditionAssessment": {
        "averageScore": 2.7,
        "scale": "1 (very poor) to 5 (excellent)",
        "notes": "Not sprinkled",
        "sourceLabel": "Building Assessment Scoring",
        "updatedAt": "2026-03-31",
        "architecture": {
          "exterior": 3,
          "interiorFinishes": 2
        },
        "engineering": {
          "mechanical": 2,
          "power": 3
        },
        "functionality": {
          "spaceSize": 3,
          "technology": 2
        }
      },
      "scenarioPdfs": [
        {
          "label": "Current Condition",
          "description": "Existing floor layout from master plan appendix",
          "url": "floorplans/Hastings/Babcock Hall/Scenarios/current-condition.pdf"
        },
        {
          "label": "Scenario A",
          "description": "Renovation option with expanded instructional suite",
          "url": "floorplans/Hastings/Babcock Hall/Scenarios/scenario-a.pdf"
        }
      ]
    }
  ]
}
```

## Notes

- Building matching is alias-friendly (`building`, `id`, `name`, and `aliases` are all checked).
- PDF/document `url` can be either:
  - absolute (`https://...`)
  - repo-hosted relative path (for example `floorplans/Hastings/.../plan.pdf` or `.jpg`)
