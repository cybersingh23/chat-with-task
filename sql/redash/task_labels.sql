-- The annotator's label as PLATFORM currently holds it, for specific tasks —
-- the comparand for the staging backfill match check (spec §8).
--
-- The label lives inside TASKATTEMPTS.RESPONSE as form-step outputs whose
-- field ids do NOT mirror rank.json. Two fields map 1:1 and are extracted
-- here; the full field map (per-model gradings, failure-mode flags, prose) is
-- the eval-side reconciler's job:
--   output.preference_rating   "+2: moderately prefer model b"  -> signed int
--   output.model_ranking       "model a" / "model b"            -> the rank-1 side
--
-- Latest attempt that actually carries the fields, per task — an SBQ re-attempt
-- without the form would otherwise blank the label.
WITH latest AS (
    SELECT TASK, RESPONSE
    FROM PUBLIC.TASKATTEMPTS
    WHERE TASK IN ({{task_ids}})
      AND RESPONSE::string ILIKE '%preference_rating%'
    QUALIFY ROW_NUMBER() OVER (PARTITION BY TASK ORDER BY ATTEMPTED_AT DESC) = 1
)
SELECT
    l.TASK AS task_id,
    MAX(CASE WHEN f.path RLIKE '.*output\\.preference_rating$' THEN f.value::string END) AS preference_rating,
    MAX(CASE WHEN f.path RLIKE '.*output\\.model_ranking$'     THEN f.value::string END) AS model_ranking
FROM latest l,
     LATERAL FLATTEN(input => TRY_PARSE_JSON(l.RESPONSE::string), RECURSIVE => TRUE) f
WHERE f.path RLIKE '.*output\\.(preference_rating|model_ranking)$'
GROUP BY 1
