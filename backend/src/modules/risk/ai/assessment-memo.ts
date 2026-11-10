import type { AiAssessment } from './ai-contract';

/**
 * Remembers, per event, an AI answer that already cost a request, so a retry of the same event on
 * this worker (the database step failed after the call) does not call the provider and spend the
 * daily budget again. In memory and bounded: another worker, or a restart, still calls once more.
 * Answers that spent nothing (no permit, budget exhausted, bad config) are never remembered, so a
 * retry can still reach the provider once capacity is back.
 */
export class AssessmentMemo {
  private readonly entries = new Map<string, { at: number; assessment: AiAssessment }>();

  constructor(
    private readonly maxEntries = 256,
    private readonly ttlMs = 10 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  get(eventId: string): AiAssessment | undefined {
    const hit = this.entries.get(eventId);
    if (!hit) return undefined;
    if (this.now() - hit.at > this.ttlMs) {
      this.entries.delete(eventId);
      return undefined;
    }
    return hit.assessment;
  }

  remember(eventId: string, assessment: AiAssessment): void {
    if (
      assessment.status === 'UNAVAILABLE' ||
      assessment.status === 'BUDGET_EXHAUSTED' ||
      assessment.status === 'CONFIG_INVALID' ||
      assessment.status === 'DISABLED'
    ) {
      return;
    }
    this.entries.delete(eventId); // re-insert to refresh the insertion order
    this.entries.set(eventId, { at: this.now(), assessment });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string;
      this.entries.delete(oldest);
    }
  }

  forget(eventId: string): void {
    this.entries.delete(eventId);
  }
}
