-- SBQ status for specific tasks — split into LIFETIME counts and an OPEN flag.
--
-- The trap this version fixes (2026-08-10, found on the first live quadrant
-- report): COUNT_IF(IS_SEND_BACK_TO_QUEUE) alone counts send-backs over the
-- task's whole history. A task sent back twice at L0 during authoring, then
-- fixed and delivered clean through L10 and L12, still read "SBQ" forever —
-- 13 of 13 "must be pulled from L12" alarms were exactly this artifact.
--
-- An SBQ is OPEN only if the task has not re-entered review (L10/L12) since
-- the last send-back: sbq_open = last_sbq_at is newer than the last time a
-- node at level 10 or 12 was created. Downstream (verify blockers, backfill
-- exclusion, quadrants) gates on sbq_open; sbq_attempts stays informational.
--
-- Feeds the staging backfill check (spec §7): SBQ from Redash is a fact where
-- the board's SBQ verdict is a judgement, and the two are reconciled — never
-- silently overridden — before a task is allowed into a backfill export.
WITH sb AS (
    SELECT
        TASK,
        COUNT_IF(IS_SEND_BACK_TO_QUEUE)                            AS sbq_attempts,
        MAX(CASE WHEN IS_SEND_BACK_TO_QUEUE THEN ATTEMPTED_AT END) AS last_sbq_at,
        MAX(ATTEMPTED_AT)                                          AS last_attempt_at
    FROM PUBLIC.TASKATTEMPTS
    WHERE TASK IN ({{task_ids}})
    GROUP BY 1
), prog AS (
    -- Last time the task ENTERED a review level at or above QM. CREATED_AT is
    -- node entry; UPDATED_AT is last touch and would lie here.
    SELECT TASK, MAX(CREATED_AT) AS last_review_entered_at
    FROM PUBLIC.PIPELINEV3HUMANNODES
    WHERE TASK IN (SELECT TASK FROM sb)
      AND REVIEW_LEVEL::string IN ('10', '12')
    GROUP BY 1
)
SELECT
    sb.TASK                      AS task_id,
    sb.sbq_attempts,
    sb.last_sbq_at,
    sb.last_attempt_at,
    prog.last_review_entered_at,
    (sb.sbq_attempts > 0
     AND (prog.last_review_entered_at IS NULL
          OR sb.last_sbq_at > prog.last_review_entered_at)) AS sbq_open
FROM sb
LEFT JOIN prog ON prog.TASK = sb.TASK
