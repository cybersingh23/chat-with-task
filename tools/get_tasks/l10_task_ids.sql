-- Task IDs for every UNPAUSED task currently sitting at a given review level.
-- Placeholders are substituted by pull_l10.py: {{project_id}}, {{review_level}}, {{status}}.
-- Latest pipeline node per task decides its current level/status.
WITH latest_nodes AS (
    SELECT task, review_level, status
    FROM PUBLIC_RAW.PIPELINEV3HUMANNODES
    WHERE project = '{{project_id}}'
    QUALIFY ROW_NUMBER() OVER (PARTITION BY task ORDER BY created_at DESC) = 1
)
SELECT task AS task_id
FROM latest_nodes
WHERE review_level = {{review_level}}
  AND status = '{{status}}';
