-- Per-contributor quality this window against the window before it.
--
-- The people whose quality is sliding are the ones about to push work into the
-- L1 and L8 problem lanes, so this is the early warning that pairs with
-- blocked_backlog.sql. Flags a drop rather than reporting a level, because the
-- level is already in contributor_quality.sql.
--
-- WINDOWED ON WORK_DAY, WHICH IS WHEN THE WORK HAPPENED.
-- The dashboard equivalent (Redash 324825) windows on TASKATTEMPTS.ATTEMPTED_AT
-- while reading ratings from WORKERCOMMENTS, so a rating awarded well after the
-- attempt lands in the window of the attempt, not of the rating. Measured on
-- this project the lag is small — median 0.25 days, only 58 of 3,262 ratings
-- arrive more than a week later — so this is a modest correction, not a rescue.
-- gen_ai_isr carries the score on the attempt row itself, so the ambiguity does
-- not arise here at all.
WITH work AS (
    SELECT
        isr.WORKER           AS user_id,
        isr.EMAIL            AS email,
        isr.WORK_DAY         AS work_day,
        isr.AVG_QMS_SCORE    AS qms,
        isr.SBQ_FLAG         AS sbq,
        CASE
            WHEN isr.WORK_DAY >= DATEADD(day, -{{window_days}}, CURRENT_DATE)         THEN 'this'
            WHEN isr.WORK_DAY >= DATEADD(day, -2 * {{window_days}}, CURRENT_DATE)     THEN 'prior'
        END AS bucket
    FROM VIEW.GEN_AI_ISR isr
    WHERE isr.PROJECT_ID = '{{project_id}}'
      AND isr.TYPE_ENTRY = 'fwa'
      AND isr.WORK_DAY  >= DATEADD(day, -2 * {{window_days}}, CURRENT_DATE)
      AND isr.EMAIL NOT ILIKE '%+worker%'
),
agg AS (
    SELECT
        user_id,
        MAX(email) AS email,
        COUNT(CASE WHEN bucket = 'this'  THEN qms END)                       AS n_this,
        COUNT(CASE WHEN bucket = 'prior' THEN qms END)                       AS n_prior,
        ROUND(AVG(CASE WHEN bucket = 'this'  THEN qms END), 2)               AS qms_this,
        ROUND(AVG(CASE WHEN bucket = 'prior' THEN qms END), 2)               AS qms_prior,
        ROUND(100.0 * COUNT_IF(bucket = 'this'  AND qms <= 2)
              / NULLIF(COUNT(CASE WHEN bucket = 'this'  THEN qms END), 0), 1) AS pdr_this,
        ROUND(100.0 * COUNT_IF(bucket = 'prior' AND qms <= 2)
              / NULLIF(COUNT(CASE WHEN bucket = 'prior' THEN qms END), 0), 1) AS pdr_prior,
        ROUND(100.0 * COUNT_IF(bucket = 'this'  AND sbq)
              / NULLIF(COUNT_IF(bucket = 'this'), 0), 1)                      AS sbq_pct_this,
        ROUND(100.0 * COUNT_IF(bucket = 'prior' AND sbq)
              / NULLIF(COUNT_IF(bucket = 'prior'), 0), 1)                     AS sbq_pct_prior
    FROM work
    WHERE bucket IS NOT NULL
    GROUP BY user_id
)
SELECT
    email,
    n_prior,
    n_this,
    qms_prior,
    qms_this,
    ROUND(qms_this - qms_prior, 2)  AS qms_change,
    pdr_prior,
    pdr_this,
    ROUND(pdr_this - pdr_prior, 1)  AS pdr_change_pp,
    sbq_pct_prior,
    sbq_pct_this,
    CASE
        WHEN qms_prior IS NULL OR qms_this IS NULL           THEN 'not_enough_data'
        WHEN (qms_this - qms_prior) <= -0.4                  THEN 'quality_dropped'
        WHEN (pdr_this - pdr_prior) >= 10                    THEN 'more_poor_ratings'
        WHEN qms_prior >= 3.6 AND qms_this < 3.6             THEN 'fell_below_trusted'
        ELSE 'stable'
    END AS trend,
    CASE
        WHEN qms_prior IS NULL OR qms_this IS NULL           THEN 9
        WHEN (qms_this - qms_prior) <= -0.4                  THEN 1
        WHEN (pdr_this - pdr_prior) >= 10                    THEN 2
        WHEN qms_prior >= 3.6 AND qms_this < 3.6             THEN 3
        ELSE 8
    END AS urgency
FROM agg
WHERE COALESCE(n_this, 0) + COALESCE(n_prior, 0) > 0
ORDER BY urgency, (qms_this - qms_prior) NULLS LAST, email
