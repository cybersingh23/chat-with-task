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
-- TWO SOURCES, JOINED ON LEVEL, because neither answers the question alone:
--
--   PUBLIC.TASKATTEMPTS  - tracked time. Gives the per-attempt distribution
--                          (median as well as mean) and the active-vs-total
--                          split the idle share is derived from.
--   VIEW.GEN_AI_ISR      - the billing view, one row per attempt. Gives BILLABLE
--                          hours, plus a `useless` flag, the QMS score and the
--                          send-back flag on that same row.
--
-- An earlier version of this comment called V2_TIME_SPENT_SECS "the billable
-- clock". It is not — it is tracked time, and the two differ. The billing view
-- is the one that costs money, and it is the only source that can tell you the
-- work was WASTED: on this project roughly a third of the hours logged at the
-- authoring level carry the useless flag. Nothing in the app surfaced that.
--
-- V2_ACTIVE_TIME_SPENT_SECS excludes idle, and the gap to V2_TIME_SPENT_SECS is
-- the same "idle is total minus gen" distinction the audit rules use — surfaced
-- so an inflated tracked figure is visible rather than assumed.
--
-- Pre-existing columns keep their names AND their source, so the idle
-- calculation in overview.js is unaffected; the billing columns are additive.
WITH tracked AS (
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
),
billed AS (
    SELECT
        WORK_LEVEL::string                                        AS review_level,
        ROUND(SUM(WORK_HOURS_SPENT), 1)                           AS billable_hours,
        ROUND(SUM(IFF(USELESS, WORK_HOURS_SPENT, 0)), 1)          AS useless_hours,
        ROUND(100.0 * SUM(IFF(USELESS, WORK_HOURS_SPENT, 0))
              / NULLIF(SUM(WORK_HOURS_SPENT), 0), 1)              AS useless_pct,
        COUNT(DISTINCT WORKER)                                    AS workers,
        COUNT(DISTINCT BATCH_NAME)                                AS batches,
        ROUND(AVG(AVG_QMS_SCORE), 2)                              AS avg_qms,
        COUNT(AVG_QMS_SCORE)                                      AS qms_samples,
        ROUND(100.0 * COUNT_IF(SBQ_FLAG) / NULLIF(COUNT(*), 0), 1) AS sbq_pct
    FROM VIEW.GEN_AI_ISR
    WHERE PROJECT_ID = '{{project_id}}'
      AND TYPE_ENTRY = 'fwa'
      AND WORK_DAY  >= DATEADD(day, -{{days}}, CURRENT_DATE)
    GROUP BY 1
)
SELECT
    COALESCE(t.review_level, b.review_level) AS review_level,
    t.tasks,
    t.attempts,
    t.avg_hours,
    t.median_hours,
    t.total_hours,
    t.active_hours,
    t.pct_rejected,
    b.billable_hours,
    b.useless_hours,
    b.useless_pct,
    b.workers,
    b.batches,
    b.avg_qms,
    b.qms_samples,
    b.sbq_pct
FROM tracked t
FULL OUTER JOIN billed b ON b.review_level = t.review_level
ORDER BY TRY_TO_NUMBER(COALESCE(t.review_level, b.review_level))
