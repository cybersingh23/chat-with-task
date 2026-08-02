-- Delivery batches, reconstructed from the pipeline.
--
-- There is no "delivered" flag upstream. What a delivery actually looks like in
-- PIPELINEV3HUMANNODES is a BULK CLOSE-OUT: a few hundred tasks all having their
-- terminal level-12 node canceled inside the same hour, as the pipeline releases
-- a packaged batch. Ordinary attrition closes a handful of nodes at a time, so a
-- size floor separates the two.
--
-- Verified against known deliveries: the 2026-07-29 10:00 PT sweep is exactly 350
-- tasks (the 0728 23:48 customer delivery), and 2026-06-30 20:00 PT is 200 (the
-- 0630 19:45 delivery). Packaging happens Tuesday evening PT; the sweep lands
-- that night or Wednesday morning, which is why the raw day-of-week histogram
-- looks Wednesday-heavy even though the delivery day is Tuesday.
--
-- Times are converted to America/Los_Angeles because the delivery cadence is
-- anchored there; UTC would split a Tuesday-evening delivery onto Wednesday.
WITH latest AS (
    SELECT
        TASK,
        REVIEW_LEVEL::string AS review_level,
        STATUS,
        CONVERT_TIMEZONE('America/Los_Angeles', UPDATED_AT) AS closed_pt
    FROM PUBLIC.PIPELINEV3HUMANNODES
    WHERE PROJECT = '{{project_id}}'
    QUALIFY ROW_NUMBER() OVER (PARTITION BY TASK ORDER BY CREATED_AT DESC) = 1
),
sweeps AS (
    SELECT
        closed_pt::date  AS delivered_on,
        HOUR(closed_pt)  AS hour_pt,
        COUNT(*)         AS tasks
    FROM latest
    WHERE review_level = '12'
      AND STATUS = 'canceled'
    GROUP BY 1, 2
)
SELECT
    delivered_on,
    DAYNAME(delivered_on) AS day_name,
    hour_pt,
    tasks
FROM sweeps
WHERE tasks >= {{min_batch}}
ORDER BY delivered_on DESC, hour_pt DESC
LIMIT {{limit}}
