# spec/ — customer program documents (committed)

These program docs are **committed to this private repo** so the app is self-contained on
deploy — no manual file placement and no admin upload needed for the QC spec. The app reads
them at runtime (`src/spec.js`). An admin can still upload a newer QC rubric in-app (stored in
`DATA_DIR/rubric.csv`), which overrides `V5_RUBRIC.csv` here without a redeploy.

Required files:

| File | What it is |
|---|---|
| `V5_RUBRIC.csv` | **Authoritative QC rubric (V5)** — platform export; parsed and rendered in the UI as the QC spec, cited by the copilot as `R1`…`R25` |
| `QUALITY_CANON.md` | Distilled fail-bar/severity canon embedded in every copilot + docgen prompt |
| `NWR_CHECKLIST.md` | Customer NWR report format + 29 ONL-* check codes |
| `QC_RUBRIC.md` | Legacy QC Rubric v2 (superseded by V5; kept for reference) |
| `QC_GAP_ANALYSIS.md` | Evidence base for the rubric additions (canonical fabrication/fairness cases) |

Missing files degrade gracefully: the copilot prompt notes the gap and the QC-spec view shows
a notice instead of the rubric.
