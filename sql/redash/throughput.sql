-- Daily distinct tasks attempted per review level over the trailing window —
-- the pipeline's recent shape, so a stalled or spiking layer is visible.
SELECT
    TO_DATE(ta.ATTEMPTED_AT)             AS day,
    ta.ATTEMPTED_AT_REVIEW_LEVEL::string AS review_level,
    COUNT(DISTINCT ta.TASK)              AS tasks
FROM PUBLIC.TASKATTEMPTS ta
WHERE ta.PROJECT = '{{project_id}}'
  AND ta.ATTEMPTED_AT >= DATEADD(day, -{{days}}, CURRENT_TIMESTAMP())
GROUP BY 1, 2
ORDER BY 1, TRY_TO_NUMBER(review_level)
