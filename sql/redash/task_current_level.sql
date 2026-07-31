-- Current pipeline position for a specific set of tasks. Powers the board
-- cross-join: "of the tasks I marked HARD_FAIL, where are they now upstream?"
SELECT
    TASK                 AS task_id,
    REVIEW_LEVEL::string AS review_level,
    STATUS               AS status,
    CREATED_AT           AS entered_at,
    UPDATED_AT           AS updated_at
FROM PUBLIC.PIPELINEV3HUMANNODES
WHERE TASK IN ({{task_ids}})
QUALIFY ROW_NUMBER() OVER (PARTITION BY TASK ORDER BY CREATED_AT DESC) = 1
