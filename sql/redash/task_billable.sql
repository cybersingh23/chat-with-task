-- Billable hours per review level, from the BILLING source of truth:
-- GEN_AI_ISR.WORK_HOURS_SPENT (one row per attempt, TYPE_ENTRY 'fwa').
--
-- Why this exists (2026-08-10): the Pipeline tab computed "billable" from
-- TASKATTEMPTS.V2_TIME_SPENT_SECS, which is the TRACKED clock, not billing —
-- and whole task generations (the re-delivered 69xx batch) have no
-- TASKATTEMPTS rows at all while GEN_AI_ISR carries their attempts. Result:
-- "0 h billable" on a task with four workers and ~8 real hours in History.
SELECT
    TASK_ID                          AS task_id,
    WORK_LEVEL::string               AS review_level,
    COUNT(*)                         AS attempts,
    ROUND(SUM(WORK_HOURS_SPENT), 2)  AS billable_hours,
    COUNT_IF(USELESS)                AS useless_attempts,
    MAX(WORK_DAY)                    AS last_work_day
FROM VIEW.GEN_AI_ISR
WHERE TASK_ID IN ({{task_ids}})
  AND TYPE_ENTRY = 'fwa'
GROUP BY 1, 2
ORDER BY 1, TRY_TO_NUMBER(review_level)
