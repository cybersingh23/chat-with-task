-- Full pipeline node history for one or more ACC tasks: every review level the
-- task passed through, who worked it, and when. `is_current` marks the newest
-- node per task — i.e. where the task actually sits right now.
--
-- Worker team is worth surfacing to an auditor: a task worked by someone under
-- a Banned/Cheating team path is signal, not trivia.
WITH nodes AS (
    SELECT
        TASK,
        REVIEW_LEVEL::string AS review_level,
        STATUS,
        NODE_NAME,
        WORKER,
        CREATED_AT,
        UPDATED_AT,
        ATTEMPT_TO_REVIEW,
        ROW_NUMBER() OVER (PARTITION BY TASK ORDER BY CREATED_AT DESC) AS rn
    FROM PUBLIC.PIPELINEV3HUMANNODES
    WHERE TASK IN ({{task_ids}})
)
SELECT
    n.TASK              AS task_id,
    n.review_level      AS review_level,
    n.STATUS            AS status,
    n.NODE_NAME         AS node_name,
    n.WORKER            AS worker_id,
    u.FULL_NAME         AS worker_name,
    u.WORKER_TEAM_NAME  AS worker_team,
    n.CREATED_AT        AS started_at,
    n.UPDATED_AT        AS ended_at,
    n.ATTEMPT_TO_REVIEW AS attempt_id,
    (n.rn = 1)          AS is_current
FROM nodes n
LEFT JOIN VIEW.DIM_USERS u ON u.USER_ID = n.WORKER
ORDER BY n.TASK, n.CREATED_AT
