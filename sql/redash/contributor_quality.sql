-- Every contributor on the project with a quality tier and a recommended action.
--
-- This is the "who to coach" list. It reproduces the tiers and thresholds the
-- ops dashboard uses (Redash 324826 / 324827) so the two agree, with three
-- deliberate departures, each documented below.
--
-- SOURCE: view.gen_ai_isr, not WORKERCOMMENTS
-- The dashboard rebuilds each contributor's quality from a four-way join —
-- TASKATTEMPTS -> WORKERCOMMENTS (source='qualityMeasurement') -> USERS — and
-- then joins USERS again for names. gen_ai_isr is one row per attempt and
-- already carries AVG_QMS_SCORE, SBQ_FLAG, USELESS, EMAIL, WORKER_TEAM_NAME and
-- LAST_ACTIVE_PT. Same numbers, one source, and it runs in ~2s.
--
-- DEPARTURE 1 — role is not sticky.
-- The dashboard sets is_reviewer with MAX(CASE WHEN level >= 0), so a single L0
-- attempt ever taken marks someone a reviewer permanently, and the much
-- stricter reviewer thresholds (any poor rating at all => untrusted) are then
-- applied to their authoring work forever. Here the role is whichever kind of
-- work they did MORE of inside the window.
--
-- DEPARTURE 2 — internal accounts are labelled, not dropped.
-- The dashboard's action list excludes @outlier.ai while its tier-mix pie does
-- not, so the two charts describe different populations. Nothing is excluded
-- here except the +worker bots; `is_internal` lets the caller decide.
--
-- And @outlier.ai is NOT an internal domain — it is one of the marketplace
-- worker domains, alongside @remotasks.com and personal addresses. The same
-- population appears under all three (latam.coder2187@outlier.ai and
-- latam.coder1514@remotasks.com are both marketplace coders), so excluding it
-- the way the dashboard's action list does silently drops real contributors.
-- Only @scale.com is staff.
--
-- DEPARTURE 3 — bounded window.
-- The dashboard scores over all time, so a contributor who improved months ago
-- never escapes their old average. {{days}} bounds it.
WITH work AS (
    SELECT
        isr.WORKER             AS user_id,
        isr.EMAIL              AS email,
        isr.WORKER_TEAM_NAME   AS team,
        isr.WORK_LEVEL::int    AS work_level,
        isr.WORK_HOURS_SPENT   AS hours,
        isr.AVG_QMS_SCORE      AS qms,
        isr.SBQ_FLAG           AS sbq,
        isr.USELESS            AS useless,
        isr.LAST_ACTIVE_PT     AS last_active_pt
    FROM VIEW.GEN_AI_ISR isr
    WHERE isr.PROJECT_ID = '{{project_id}}'
      AND isr.TYPE_ENTRY = 'fwa'
      AND isr.WORK_DAY  >= DATEADD(day, -{{days}}, CURRENT_DATE)
      AND isr.EMAIL NOT ILIKE '%+worker%'
),
agg AS (
    SELECT
        user_id,
        MAX(email)                                              AS email,
        MAX(team)                                               AS team,
        MAX(last_active_pt)                                     AS last_active_pt,
        COUNT(*)                                                AS attempts,
        COUNT_IF(work_level >= 0)                               AS review_attempts,
        COUNT_IF(work_level <  0)                               AS authoring_attempts,
        ROUND(SUM(hours), 1)                                    AS hours,
        ROUND(SUM(IFF(useless, hours, 0)), 1)                   AS useless_hours,
        COUNT(qms)                                              AS qms_samples,
        ROUND(AVG(qms), 2)                                      AS qms_score,
        ROUND(100.0 * COUNT_IF(qms <= 2) / NULLIF(COUNT(qms), 0), 1) AS pdr,
        ROUND(100.0 * COUNT_IF(sbq)      / NULLIF(COUNT(*), 0),  1)  AS sbq_pct
    FROM work
    GROUP BY user_id
),
roled AS (
    SELECT
        a.*,
        (a.review_attempts > a.authoring_attempts) AS is_reviewer,
        (a.email ILIKE '%@scale.com%')             AS is_internal
    FROM agg a
),
-- Thresholds held in one place so the tier and the action can never disagree —
-- the dashboard repeats the same nine-branch CASE twice, in two queries, and
-- they have already drifted once.
scored AS (
    SELECT
        r.*,
        CASE
            WHEN NOT is_reviewer AND qms_samples < 3                    THEN 'new_attempter'
            WHEN NOT is_reviewer AND (qms_score < 3.0 OR pdr > 35)      THEN 'attempter_disable'
            WHEN NOT is_reviewer AND (qms_score < 3.6 OR pdr >= 10)     THEN 'attempter_untrusted'
            WHEN NOT is_reviewer AND (qms_score >= 4.0 AND pdr < 5)     THEN 'attempter_promote'
            WHEN NOT is_reviewer AND (qms_score >= 3.6 AND pdr < 10)    THEN 'attempter_trusted'
            WHEN is_reviewer     AND qms_samples < 2                    THEN 'new_reviewer'
            WHEN is_reviewer     AND (qms_score < 3.0 OR pdr >= 50)     THEN 'reviewer_demote'
            WHEN is_reviewer     AND (qms_score < 4.0 OR pdr > 0)       THEN 'reviewer_untrusted'
            WHEN is_reviewer     AND (qms_score >= 4.0 AND pdr = 0)     THEN 'reviewer_trusted'
            ELSE 'unclassified'
        END AS tier_key
    FROM roled r
)
SELECT
    email,
    team,
    IFF(is_reviewer, 'reviewer', 'attempter') AS role,
    is_internal,
    attempts,
    review_attempts,
    authoring_attempts,
    hours,
    useless_hours,
    ROUND(100.0 * useless_hours / NULLIF(hours, 0), 1) AS useless_pct,
    qms_samples,
    qms_score,
    pdr,
    sbq_pct,
    last_active_pt,
    tier_key,
    CASE tier_key
        WHEN 'new_attempter'       THEN 'Attempter - new (needs samples)'
        WHEN 'attempter_disable'   THEN 'Attempter - should disable'
        WHEN 'attempter_untrusted' THEN 'Attempter - untrusted'
        WHEN 'attempter_promote'   THEN 'Attempter - promote candidate'
        WHEN 'attempter_trusted'   THEN 'Attempter - trusted'
        WHEN 'new_reviewer'        THEN 'Reviewer - new (needs samples)'
        WHEN 'reviewer_demote'     THEN 'Reviewer - should demote'
        WHEN 'reviewer_untrusted'  THEN 'Reviewer - untrusted'
        WHEN 'reviewer_trusted'    THEN 'Reviewer - trusted'
        ELSE 'Unclassified'
    END AS tier,
    CASE tier_key
        WHEN 'new_attempter'       THEN 'Prioritize in the audit sheet'
        WHEN 'attempter_disable'   THEN 'Disable'
        WHEN 'attempter_untrusted' THEN 'Invite to attempters webinar; throttle to 1 task'
        WHEN 'attempter_promote'   THEN 'Promote to reviewer'
        WHEN 'attempter_trusted'   THEN 'Keep as trusted attempter'
        WHEN 'new_reviewer'        THEN 'Prioritize in the audit sheet'
        WHEN 'reviewer_demote'     THEN 'Demote to attempter'
        WHEN 'reviewer_untrusted'  THEN 'Invite to reviewers webinar; audit in L10 until trusted'
        WHEN 'reviewer_trusted'    THEN 'Move tasks to L12'
        ELSE 'Review manually'
    END AS ops_action,
    -- Steady-state tiers need no action; kept in the result so the tier mix and
    -- the action list are one query over one population.
    (tier_key NOT IN ('attempter_trusted', 'reviewer_trusted')) AS needs_action,
    CASE tier_key
        WHEN 'attempter_disable'   THEN 1
        WHEN 'reviewer_demote'     THEN 2
        WHEN 'attempter_untrusted' THEN 3
        WHEN 'reviewer_untrusted'  THEN 4
        WHEN 'attempter_promote'   THEN 5
        WHEN 'new_attempter'       THEN 6
        WHEN 'new_reviewer'        THEN 6
        ELSE 9
    END AS urgency
FROM scored
ORDER BY urgency, qms_score ASC NULLS LAST, email
