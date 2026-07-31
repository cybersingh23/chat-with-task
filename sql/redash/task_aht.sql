-- Time worked per review level for one or more tasks. V2_TIME_SPENT_SECS is the
-- billable clock; V2_ACTIVE_TIME_SPENT_SECS excludes idle, so the gap between
-- the two is the same "idle is total minus gen" distinction the audit rules use.
-- One row per (task, level).
SELECT
    TASK                                              AS task_id,
    ATTEMPTED_AT_REVIEW_LEVEL::string                 AS review_level,
    COUNT(*)                                          AS attempts,
    ROUND(SUM(V2_TIME_SPENT_SECS) / 3600.0, 2)        AS hours,
    ROUND(SUM(V2_ACTIVE_TIME_SPENT_SECS) / 3600.0, 2) AS active_hours,
    MAX(ATTEMPTED_AT)                                 AS last_attempt_at
FROM PUBLIC.TASKATTEMPTS
WHERE TASK IN ({{task_ids}})
GROUP BY 1, 2
ORDER BY 1, TRY_TO_NUMBER(review_level)
