-- Daily intake into level 12 — the rate at which tasks become DELIVERABLE.
--
-- Level 12 is the deliverable state: a task sitting at L12 is ready to package,
-- and anything upstream is supply that has not arrived yet. So the number that
-- actually tracks progress toward a delivery is the L12 population, and the
-- number that predicts it is how fast tasks enter L12.
--
-- This matters because L12 fills LATE. For the 2026-07-29 batch of 350, 281 of
-- them (80%) entered L12 in the final three days and 135 on delivery day itself.
-- A small L12 count early in the week is therefore normal rather than alarming,
-- and judging a Sunday against the target without that context reads as a crisis
-- when it is a cadence.
--
-- One row per day: how many tasks entered L12 for the first time that day.
-- MIN over the task's L12 nodes, so a task that bounced back into L12 after
-- rework is counted once, on its first arrival.
WITH first_l12 AS (
    SELECT
        TASK,
        MIN(CONVERT_TIMEZONE('America/Los_Angeles', CREATED_AT)) AS entered_pt
    FROM PUBLIC.PIPELINEV3HUMANNODES
    WHERE PROJECT = '{{project_id}}'
      AND REVIEW_LEVEL::string = '12'
    GROUP BY 1
)
SELECT
    entered_pt::date  AS day,
    DAYNAME(entered_pt) AS day_name,
    COUNT(*)          AS entered
FROM first_l12
WHERE entered_pt >= DATEADD(day, -{{days}}, CURRENT_TIMESTAMP())
GROUP BY 1, 2
ORDER BY 1
