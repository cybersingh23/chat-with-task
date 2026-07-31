-- Average handling time per review level across the project over a trailing
-- window: how many tasks and attempts each level absorbed, and what it cost in
-- hours. Feeds the "cost per layer" panel on L12 Stats.
SELECT
    ta.ATTEMPTED_AT_REVIEW_LEVEL::string             AS review_level,
    COUNT(DISTINCT ta.TASK)                          AS tasks,
    COUNT(*)                                         AS attempts,
    ROUND(SUM(ta.V2_TIME_SPENT_SECS) / 3600.0, 1)    AS total_hours,
    ROUND(AVG(ta.V2_TIME_SPENT_SECS) / 3600.0, 2)    AS avg_hours_per_attempt
FROM PUBLIC.TASKATTEMPTS ta
WHERE ta.PROJECT = '{{project_id}}'
  AND ta.ATTEMPTED_AT >= DATEADD(day, -{{days}}, CURRENT_TIMESTAMP())
GROUP BY 1
ORDER BY TRY_TO_NUMBER(review_level)
