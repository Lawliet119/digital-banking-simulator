import type { AiAssessment } from './ai-contract';
import { persistedAssessment } from './persisted-assessment';

const answer: AiAssessment = {
  status: 'SUCCEEDED',
  probability: 0.9,
  provider: 'openai',
  requestedModel: 'gpt-x',
  responseModel: 'gpt-x-2026',
  requestId: 'req_1',
  rubricSha256: 'a'.repeat(64),
  inputSha256: 'b'.repeat(64),
  usage: null,
};

describe('persistedAssessment', () => {
  it('keeps the whole answer when the final status is SUCCEEDED', () => {
    expect(persistedAssessment('SUCCEEDED', answer)).toEqual({
      probability: 0.9,
      provider: 'openai',
      requestedModel: 'gpt-x',
      responseModel: 'gpt-x-2026',
      rubricSha256: 'a'.repeat(64),
      inputSha256: 'b'.repeat(64),
      requestId: 'req_1',
    });
  });

  it('drops the probability when SUCCEEDED was downgraded to INVALID_RESPONSE', () => {
    const stored = persistedAssessment('INVALID_RESPONSE', answer);
    expect(stored.probability).toBeNull();
    // The provider block stays: risk_decisions_mode_metadata requires it for this status.
    expect(stored.provider).toBe('openai');
    expect(stored.rubricSha256).toBe('a'.repeat(64));
  });

  it('drops probability, response model and request id when downgraded to CONFIG_INVALID', () => {
    const stored = persistedAssessment('CONFIG_INVALID', answer);
    expect(stored.probability).toBeNull();
    expect(stored.responseModel).toBeNull();
    expect(stored.requestId).toBeNull();
  });

  it('stores nothing when there was no assessment', () => {
    expect(Object.values(persistedAssessment('DISABLED', undefined)).every(v => v === null)).toBe(
      true,
    );
  });
});
