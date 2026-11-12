/**
 * Closed, first-party interview pack.
 *
 * This is deliberately declarative: the existing seed renderer owns layout,
 * auto-save, completion, and the graph. It does not execute pack-supplied
 * code or add score inputs.
 */
export const interviewPack = Object.freeze({
  id: "interview",
  version: "0.1.0",
  label: "한국어 모의 면접",
  seed: {
    objective: "근거를 지키며 한국어 모의 면접 답변을 다듬는다.",
    scope: "첫 모의 면접 Answer Pack",
    horizon: "이번 면접 준비 세션",
    working_assumption: "답변은 일반 텍스트 입력으로 작성하고, 자동 저장된 초안과 명시적 완료를 구분한다.",
    current_blockers: [
      {
        label: "근거 경계",
        detail: "직접 한 일, 협업 범위, 수치의 의미를 답변에서 분리해 확인한다.",
      },
    ],
    potential_follow_ups: [
      {
        label: "대표 프로젝트의 후속 질문",
        unlock_condition: "첫 답변을 사용자 검토 후 완료한 뒤",
      },
      {
        label: "지원동기와 역할 적합성 검증",
        unlock_condition: "회사·팀·직무에 대한 실제 동기가 확인된 뒤",
      },
    ],
    candidate_uncertainties: [],
    questions: [
      {
        id: "intro",
        prompt: "45~60초 자기소개를 해주세요.",
        description: "먼저 어떤 문제를 해결해 온 사람인지 한 문장으로 말하고, 이를 보여 주는 경험 한두 개만 연결해 보세요.",
        answer_effect: "후속 질문은 이 답변에서 언급한 경험과 역할 경계를 중심으로 준비됩니다.",
        kind: "free_text",
      },
      {
        id: "motivation",
        prompt: "왜 지금 이 역할과 회사를 선택했나요?",
        description: "회사 특성을 자신의 동기로 단정하지 말고, 실제 경험·관찰·다음 역할에서 원하는 책임을 연결해 답하세요.",
        answer_effect: "확인되지 않은 동기나 회사 사실은 다음 팩에서 보류 또는 검증 대상으로 남깁니다.",
        kind: "free_text",
      },
      {
        id: "project",
        prompt: "가장 대표적인 프로젝트 하나를 설명해 주세요.",
        description: "문제 → 본인 판단과 구현 → 협업 경계 → 결과와 한계 순서로 답해 보세요.",
        answer_effect: "후속 질문은 결과 수치의 의미, 본인 기여, 다시 한다면 바꿀 점을 구체화합니다.",
        kind: "free_text",
      },
    ],
  },
});

const BUILT_IN_PACKS = Object.freeze({
  [interviewPack.id]: interviewPack,
});

export function getBuiltInPack(id) {
  if (typeof id !== "string" || id.trim() === "") return undefined;
  return BUILT_IN_PACKS[id.trim()];
}

export function builtInPackIds() {
  return Object.keys(BUILT_IN_PACKS).sort();
}
