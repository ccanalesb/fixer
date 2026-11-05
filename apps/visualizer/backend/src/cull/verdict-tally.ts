import type { PhotoDecision } from './types.js';

export interface VerdictTally {
  filtered_by_culling_profile: number;
  filtered_by_score_forecast: number;
  pending: number;
  passed: number;
  sent_by_hand_passed: number;
}

export function emptyVerdictTally(): VerdictTally {
  return {
    filtered_by_culling_profile: 0,
    filtered_by_score_forecast: 0,
    pending: 0,
    passed: 0,
    sent_by_hand_passed: 0,
  };
}

export function addDecision(tally: VerdictTally, decision: PhotoDecision): void {
  if (decision.verdict === 'pending') tally.pending += 1;
  else if (decision.verdict === 'passed') tally.passed += 1;
  else if (decision.filteredBy === 'culling_profile') tally.filtered_by_culling_profile += 1;
  else tally.filtered_by_score_forecast += 1;
  if (decision.sentByHandOverride) tally.sent_by_hand_passed += 1;
}
