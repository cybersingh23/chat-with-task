-- Average handling time per review level across the project over a trailing
-- window: how many tasks and attempts each level absorbed, and what it cost in
-- hours. Feeds the "cost per layer" panel on L12 Stats.
--
-- Narrower than level_economics.sql (no distribution, no rework rate) but drawn
-- from the same two sources so the two can never disagree: tracked time from
-- TASKATTEMPTS, billable and wasted hours from the billing view.
--
-- total_hours and avg_hours_per_attempt keep their original meaning — tracked
-- seconds from TASKATTEMPTS — so nothing downstream shifts. The billing columns
-- are additive.
WITH tracked AS (
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
),
billed AS (
    SELECT
        WORK_LEVEL::string                                        AS review_level,
        ROUND(SUM(WORK_HOURS_SPENT), 1)                           AS billable_hours,
        ROUND(SUM(IFF(USELESS, WORK_HOURS_SPENT, 0)), 1)          AS useless_hours,
        COUNT(DISTINCT WORKER)                                    AS workers,
        ROUND(AVG(AVG_QMS_SCORE), 2)                              AS avg_qms,
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
    t.total_hours,
    t.avg_hours_per_attempt,
    b.billable_hours,
    b.useless_hours,
    b.workers,
    b.avg_qms,
    b.sbq_pct
FROM tracked t
FULL OUTER JOIN billed b ON b.review_level = t.review_level
ORDER BY TRY_TO_NUMBER(COALESCE(t.review_level, b.review_level))
