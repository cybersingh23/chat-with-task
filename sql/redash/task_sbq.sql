-- SBQ status for specific tasks: has any completed review sent this task back,
-- and when did that last happen?
--
-- Feeds the staging backfill check (spec §7): SBQ from Redash is a fact where
-- the board's SBQ verdict is a judgement, and the two are reconciled — never
-- silently overridden — before a task is allowed into a backfill export.
SELECT
    TASK                                                       AS task_id,
    COUNT_IF(IS_SEND_BACK_TO_QUEUE)                            AS sbq_attempts,
    MAX(CASE WHEN IS_SEND_BACK_TO_QUEUE THEN ATTEMPTED_AT END) AS last_sbq_at,
    MAX(ATTEMPTED_AT)                                          AS last_attempt_at
FROM PUBLIC.TASKATTEMPTS
WHERE TASK IN ({{task_ids}})
GROUP BY 1
