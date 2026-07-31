-- Where every task in the ACC project currently sits: newest pipeline node per
-- task, grouped by review level and status. This is the upstream truth the
-- board's local counts cannot see — the board only knows what was uploaded.
WITH latest AS (
    SELECT
        TASK,
        REVIEW_LEVEL::string AS review_level,
        STATUS
    FROM PUBLIC.PIPELINEV3HUMANNODES
    WHERE PROJECT = '{{project_id}}'
    QUALIFY ROW_NUMBER() OVER (PARTITION BY TASK ORDER BY CREATED_AT DESC) = 1
)
SELECT
    review_level,
    STATUS   AS status,
    COUNT(*) AS tasks
FROM latest
GROUP BY 1, 2
ORDER BY TRY_TO_NUMBER(review_level), status
