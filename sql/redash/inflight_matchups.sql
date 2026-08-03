-- Every task currently in flight, at any review level, with the A/B model
-- matchup it is comparing.
--
-- WHERE THE MATCHUP LIVES
-- There is no model column. The pairing is buried in the annotation payload:
-- TASKATTEMPTS.RESPONSE holds, at a task-specific path, one object per agent
-- instance carrying `instance_id` and `metadata.agent_model`. The instance_id
-- ends in `-A-<hash>` or `-B-<hash>`, and that letter is the side. So the side
-- comes from the id and the model from the metadata beside it.
--
-- The containing path varies per task (it sits under a generated `step-*` key,
-- e.g. before['step-1776811788151-l910ed'].output.items[0].content.data
-- .instances[N].context), so this uses a RECURSIVE flatten and matches on shape
-- — any node that has both an instance_id and a metadata.agent_model — rather
-- than hardcoding a path that only holds for one task template.
--
-- Each side usually appears several times (one node per agent instance) with the
-- same model, hence the DISTINCT before pivoting.
--
-- COST
-- Recursive flatten over a large VARIANT is not cheap, so exactly one attempt is
-- picked per task — the newest whose RESPONSE actually carries the metadata —
-- before any flattening happens.
WITH latest_node AS (
    SELECT
        TASK,
        REVIEW_LEVEL::string AS review_level,
        STATUS,
        CREATED_AT,
        NODE_NAME
    FROM PUBLIC.PIPELINEV3HUMANNODES
    WHERE PROJECT = '{{project_id}}'
    QUALIFY ROW_NUMBER() OVER (PARTITION BY TASK ORDER BY CREATED_AT DESC) = 1
),
inflight AS (
    SELECT TASK, review_level, CREATED_AT AS entered_at
    FROM latest_node
    WHERE STATUS = 'pending'
),
picked AS (
    SELECT ta.TASK, ta.RESPONSE, ta.ATTEMPTED_AT
    FROM PUBLIC.TASKATTEMPTS ta
    JOIN inflight i ON i.TASK = ta.TASK
    WHERE ta.RESPONSE::string ILIKE '%agent_model%'
    QUALIFY ROW_NUMBER() OVER (PARTITION BY ta.TASK ORDER BY ta.ATTEMPTED_AT DESC) = 1
),
sides AS (
    SELECT DISTINCT
        p.TASK,
        REGEXP_SUBSTR(f.value:instance_id::string, '-([AB])-[0-9a-f]+$', 1, 1, 'e', 1) AS side,
        f.value:metadata:agent_model::string AS agent_model
    FROM picked p,
         LATERAL FLATTEN(input => TRY_PARSE_JSON(p.RESPONSE::string), RECURSIVE => TRUE) f
    WHERE f.value:metadata:agent_model IS NOT NULL
      AND f.value:instance_id IS NOT NULL
),
matchup AS (
    SELECT
        TASK,
        MAX(CASE WHEN side = 'A' THEN agent_model END) AS model_a,
        MAX(CASE WHEN side = 'B' THEN agent_model END) AS model_b
    FROM sides
    GROUP BY 1
)
SELECT
    i.TASK                                                                  AS task_id,
    i.review_level,
    ROUND(DATEDIFF(hour, i.entered_at, CURRENT_TIMESTAMP()) / 24.0, 1)      AS age_days,
    m.model_a,
    m.model_b,
    -- Order-independent so "X vs Y" and "Y vs X" aggregate as one matchup.
    CASE
      WHEN m.model_a IS NULL OR m.model_b IS NULL THEN NULL
      ELSE LEAST(m.model_a, m.model_b) || '  vs  ' || GREATEST(m.model_a, m.model_b)
    END                                                                     AS matchup
FROM inflight i
LEFT JOIN matchup m ON m.TASK = i.TASK
ORDER BY TRY_TO_NUMBER(i.review_level), age_days DESC
