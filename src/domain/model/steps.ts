export const FLOW_STEP = {
  TEST_GENERATE: "test_generate",
  TEST_SELF_QUALITY: "test_self_quality",
  TEST_EXTERNAL_REVIEW: "test_external_review",
  IMPL_GENERATE: "impl_generate",
  IMPL_SELF_CRITERIA: "impl_self_criteria",
  IMPL_SELF_QUALITY: "impl_self_quality",
  IMPL_EXTERNAL_REVIEW: "impl_external_review",
  LINT_FIX: "lint_fix",
  APPLY_FIXES: "apply_fixes",
  JUDGE_MINOR: "judge_minor",
  SPEC_GENERATE: "spec_generate",
  TEST_CASE_GENERATE: "test_case_generate",
  SPEC_TC_REVIEW: "spec_tc_review",
  COMPONENT_GENERATE: "component_generate",
  COMPONENT_SELF_REVIEW: "component_self_review",
  PAGE_GENERATE: "page_generate",
  PAGE_REVIEW_DESIGN: "page_review_design",
  PAGE_REVIEW_BEHAVIOR: "page_review_behavior",
  PAGE_REVIEW_CODE: "page_review_code",
  PAGE_BROWSER_VERIFY: "page_browser_verify",
} as const;

export type FlowStep = (typeof FLOW_STEP)[keyof typeof FLOW_STEP];

export const FLOW_MODE = { FULL: "full", LIGHT: "light" } as const;
export type FlowMode = (typeof FLOW_MODE)[keyof typeof FLOW_MODE];

export const LIGHT_SKIP_STEPS: ReadonlySet<FlowStep> = new Set([
  FLOW_STEP.TEST_EXTERNAL_REVIEW,
  FLOW_STEP.IMPL_EXTERNAL_REVIEW,
]);
