-- One row per reviewer working a given review level: how much they get through,
-- how often they send work back, how hard they grade, and whether the platform
-- considers them trusted.
--
-- Merges three separate dashboard queries that each held one column of this
-- picture — Redash 324861 (SBQ rate), 242441 (trusted-reviewer throughput) and
-- 324777 (tags and last-active) — and adds the one none of them have:
--
-- CALIBRATION. avg_score_given is the mean QMS rating this reviewer AWARDS.
-- Two reviewers with the same throughput and the same send-back rate can still
-- be grading to different standards, and that difference propagates into every
-- verdict downstream of them. A reviewer well off the project mean is worth a
-- calibration conversation regardless of how good their own numbers look.
--
-- Note the two send-back numbers measure opposite directions and should not be
-- compared to each other:
--   sbq_issued  - work THIS reviewer sent back (from their own attempt rows)
--   sbq_pct     - the share of their reviews that was a send-back
WITH reviews AS (
    SELECT
        ta.ATTEMPTED_BY                AS user_id,
        ta._ID                         AS attempt_id,
        ta.REVIEWED_ATTEMPT            AS reviewed_attempt,
        ta.IS_SEND_BACK_TO_QUEUE       AS sbq,
        ta.ATTEMPTED_AT                AS attempted_at,
        ta.V2_TIME_SPENT_SECS          AS secs
    FROM PUBLIC.TASKATTEMPTS ta
    WHERE ta.PROJECT = '{{project_id}}'
      AND ta.ATTEMPTED_AT_REVIEW_LEVEL::int = {{level}}
      AND ta.REVIEW_OUTCOME IS NOT NULL          -- completed reviews only
      AND ta.ATTEMPTED_AT >= DATEADD(day, -{{days}}, CURRENT_TIMESTAMP())
),
throughput AS (
    SELECT
        user_id,
        COUNT(*)                                            AS reviews,
        COUNT_IF(sbq)                                       AS sbq_issued,
        COUNT_IF(NOT sbq)                                   AS sent_forward,
        ROUND(100.0 * COUNT_IF(sbq) / NULLIF(COUNT(*), 0), 1) AS sbq_pct,
        ROUND(AVG(secs) / 3600.0, 2)                        AS avg_hours_per_review,
        MAX(attempted_at)                                   AS last_review_at
    FROM reviews
    GROUP BY user_id
),
-- What this reviewer awards. AUTHOR on the comment is the rater, so this is the
-- grade going out, not the grade coming in.
--
-- Scoped to EXACTLY the reviews counted above, by joining through the review's
-- own REVIEWED_ATTEMPT edge rather than collecting every rating the person ever
-- authored. Without that join the two halves of a row describe different things:
-- a reviewer with one L0 review in the window showed "1 review" beside "135
-- grades given" picked up from their work at other levels, and the calibration
-- delta was computed off the 135.
grades_given AS (
    SELECT
        r.user_id                                AS user_id,
        COUNT(*)                                 AS scores_given,
        ROUND(AVG(TRY_TO_NUMBER(wc.COMMENT)), 2) AS avg_score_given,
        ROUND(100.0 * COUNT_IF(TRY_TO_NUMBER(wc.COMMENT) <= 2)
              / NULLIF(COUNT(*), 0), 1)          AS pct_poor_given
    FROM reviews r
    JOIN PUBLIC.WORKERCOMMENTS wc
      ON wc.ATTEMPT_TO_REVIEW = r.reviewed_attempt
     AND wc.AUTHOR            = r.user_id
    WHERE wc.SOURCE = 'qualityMeasurement'
      AND wc.TYPE   = 'rating'
      AND wc.TITLE IN ('Quality: Overall Task', 'Turn Quality: Final Response')
    GROUP BY r.user_id
),
project_mean AS (
    SELECT ROUND(AVG(avg_score_given), 2) AS mean_score_given FROM grades_given
)
SELECT
    u.EMAIL                                     AS email,
    u.FULL_NAME                                 AS name,
    u.WORKER_TEAM_NAME                          AS team,
    t.reviews,
    t.sbq_issued,
    t.sent_forward,
    t.sbq_pct,
    t.avg_hours_per_review,
    g.scores_given,
    g.avg_score_given,
    g.pct_poor_given,
    pm.mean_score_given                         AS project_mean_score_given,
    ROUND(g.avg_score_given - pm.mean_score_given, 2) AS calibration_delta,
    ARRAY_CONTAINS('mailbox_ring_reviewer'::variant,   u.TAGS_NAME) AS has_reviewer_tag,
    ARRAY_CONTAINS('mailbox_ring_trusted_wr'::variant, u.TAGS_NAME) AS has_trusted_tag,
    u.LAST_ACTIVE_PT                            AS last_active_pt,
    t.last_review_at
FROM throughput t
JOIN VIEW.DIM_USERS u ON u.USER_ID = t.user_id
LEFT JOIN grades_given g ON g.user_id = t.user_id
CROSS JOIN project_mean pm
ORDER BY t.reviews DESC
