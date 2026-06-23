-- Latest response for a single task, with the annotator's rubric fields
-- extracted from the (very large) RESPONSE variant.
--
-- The annotator UI for this project writes results into several named
-- steps of TASKATTEMPTS.RESPONSE:before.<step>.output.<field>:
--   * step-TextCollection-8e09ffa6535f -> model_ranking      (overall model preference)
--   * step-TextCollection-93171a2f9a85 -> per-model trajectory summaries
--                                         + trajectory preference justification
--   * step-TextCollection-8e1ff10a690f -> Model 1 (alpha)  rubric fields (suffix "1")
--   * step-1771551244463-kuabol        -> Model 2 (beta)   rubric fields (suffix "2")

SELECT
    ta.TASK::string                                                       AS task_id,
    ta._ID::string                                                        AS attempt_id,
    ta.ATTEMPTED_AT                                                       AS attempted_at,
    ta.PROJECT::string                                                    AS project_id,

    -- Full raw before-blob: trajectory CDS urls and other fields not surfaced
    -- by the rubric columns below live here. Lets one query feed both the
    -- evaluation.md render and the trajectory download (see new_review.py).
    ta.RESPONSE:"before"                                                  AS before,

    -- Shared / overall fields
    ta.RESPONSE:"before":"step-TextCollection-8e09ffa6535f":"output":"model_ranking"::string
        AS model_preference,
    ta.RESPONSE:"before":"step-TextCollection-93171a2f9a85":"output":"model_trajectory_justification"::string
        AS trajectory_preference_rationale,

    -- Model 1 (alpha)
    ta.RESPONSE:"before":"step-TextCollection-93171a2f9a85":"output":"model_alpha_reasoning"::string
        AS model1_trajectory_summary,
    ta.RESPONSE:"before":"step-TextCollection-8e1ff10a690f":"output":"correctness_rating1"::int
        AS model1_correctness_rating,
    ta.RESPONSE:"before":"step-TextCollection-8e1ff10a690f":"output":"correctness_justification1"::string
        AS model1_correctness_rationale,
    ta.RESPONSE:"before":"step-TextCollection-8e1ff10a690f":"output":"agent_behavior1"::int
        AS model1_agent_behavior,
    ta.RESPONSE:"before":"step-TextCollection-8e1ff10a690f":"output":"agent_behavior_justification1"::string
        AS model1_agent_behavior_rationale,
    ta.RESPONSE:"before":"step-TextCollection-8e1ff10a690f":"output":"communication1"::int
        AS model1_communication,
    ta.RESPONSE:"before":"step-TextCollection-8e1ff10a690f":"output":"communication_justification1"::string
        AS model1_communication_rationale,
    ta.RESPONSE:"before":"step-TextCollection-8e1ff10a690f":"output":"code_style1"::int
        AS model1_code_style,
    ta.RESPONSE:"before":"step-TextCollection-8e1ff10a690f":"output":"code_style_justification1"::string
        AS model1_code_style_rationale,

    -- Model 2 (beta)
    ta.RESPONSE:"before":"step-TextCollection-93171a2f9a85":"output":"model_beta_trajectory"::string
        AS model2_trajectory_summary,
    ta.RESPONSE:"before":"step-1771551244463-kuabol":"output":"correctness_rating2"::int
        AS model2_correctness_rating,
    ta.RESPONSE:"before":"step-1771551244463-kuabol":"output":"correctness_justification2"::string
        AS model2_correctness_rationale,
    ta.RESPONSE:"before":"step-1771551244463-kuabol":"output":"agent_behavior2"::int
        AS model2_agent_behavior,
    ta.RESPONSE:"before":"step-1771551244463-kuabol":"output":"agent_behavior_justification2"::string
        AS model2_agent_behavior_rationale,
    ta.RESPONSE:"before":"step-1771551244463-kuabol":"output":"communication2"::int
        AS model2_communication,
    ta.RESPONSE:"before":"step-1771551244463-kuabol":"output":"communication_justification2"::string
        AS model2_communication_rationale,
    ta.RESPONSE:"before":"step-1771551244463-kuabol":"output":"code_style2"::int
        AS model2_code_style,
    ta.RESPONSE:"before":"step-1771551244463-kuabol":"output":"code_style_justification2"::string
        AS model2_code_style_rationale
FROM PUBLIC.TASKATTEMPTS ta
WHERE ta.PROJECT = '{{project_id}}'
  AND ta.TASK = '{{task_id}}'
QUALIFY ROW_NUMBER() OVER (PARTITION BY ta.TASK ORDER BY ta.ATTEMPTED_AT DESC) = 1
