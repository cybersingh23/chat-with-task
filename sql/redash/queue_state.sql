-- What is in flight right now, and how long it has been sitting.
--
-- One row per review level, over tasks whose newest pipeline node is still
-- pending. This is the "can we make the next delivery" query: `pending` is the
-- pool available to draw the batch from, and the age columns say which part of
-- that pool has stopped moving.
--
-- Age is measured from the node's CREATED_AT — when the task entered its current
-- level — not from the task's own creation, so a task that has bounced through
-- rework is aged by its current wait, not its whole history.
WITH latest AS (
    SELECT
        TASK,
        REVIEW_LEVEL::string AS review_level,
        STATUS,
        CREATED_AT
    FROM PUBLIC.PIPELINEV3HUMANNODES
    WHERE PROJECT = '{{project_id}}'
    QUALIFY ROW_NUMBER() OVER (PARTITION BY TASK ORDER BY CREATED_AT DESC) = 1
)
SELECT
    review_level,
    COUNT(*)                                                              AS pending,
    ROUND(AVG(DATEDIFF(hour, CREATED_AT, CURRENT_TIMESTAMP())) / 24.0, 1) AS avg_age_days,
    ROUND(MAX(DATEDIFF(hour, CREATED_AT, CURRENT_TIMESTAMP())) / 24.0, 1) AS oldest_days,
    COUNT_IF(DATEDIFF(day, CREATED_AT, CURRENT_TIMESTAMP()) > {{stale_days}}) AS stale
FROM latest
WHERE STATUS = 'pending'
GROUP BY 1
ORDER BY TRY_TO_NUMBER(review_level)
