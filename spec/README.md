# spec/ — customer program documents (not committed)

Everything in this directory except this README is **gitignored** — customer spec material
must not land on GitHub. The app reads these files from disk at runtime (`src/spec.js`); to
deploy, copy them onto the server host alongside the repo.

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
