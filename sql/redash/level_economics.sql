-- What each review level costs and how much of its work comes back.
--
-- Two different measures live here on purpose, because they answer two different
-- questions and must never share an axis:
--   total_hours  — where the project's time actually goes (concentration)
--   avg_hours    — what one attempt at this level costs (unit economics)
-- pct_rejected is the rework signal: the share of attempts a reviewer sent back.
-- A level that is cheap per attempt but rejects heavily is still expensive,
-- because every rejection re-runs an earlier, dearer level.
--
-- V2_TIME_SPENT_SECS is the billable clock. V2_ACTIVE_TIME_SPENT_SECS excludes
-- idle, and the gap between them is the same "idle is total minus gen"
-- distinction the audit rules use — surfaced here so an inflated billable figure
-- is visible rather than assumed.
SELECT
    ATTEMPTED_AT_REVIEW_LEVEL::string                                  AS review_level,
    COUNT(DISTINCT TASK)                                               AS tasks,
    COUNT(*)                                                           AS attempts,
    ROUND(AVG(V2_TIME_SPENT_SECS) / 3600.0, 2)                         AS avg_hours,
    ROUND(MEDIAN(V2_TIME_SPENT_SECS) / 3600.0, 2)                      AS median_hours,
    ROUND(SUM(V2_TIME_SPENT_SECS) / 3600.0, 0)                         AS total_hours,
    ROUND(SUM(V2_ACTIVE_TIME_SPENT_SECS) / 3600.0, 0)                  AS active_hours,
    ROUND(100.0 * COUNT_IF(REVIEW_OUTCOME = 'rejected')
          / NULLIF(COUNT(*), 0), 1)                                    AS pct_rejected
FROM PUBLIC.TASKATTEMPTS
WHERE PROJECT = '{{project_id}}'
  AND ATTEMPTED_AT >= DATEADD(day, -{{days}}, CURRENT_TIMESTAMP())
GROUP BY 1
ORDER BY TRY_TO_NUMBER(review_level)
