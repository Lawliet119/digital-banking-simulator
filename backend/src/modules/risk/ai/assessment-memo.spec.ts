import type { AiAssessment, AiStatus } from './ai-contract';
import { AssessmentMemo } from './assessment-memo';

const answer = (status: AiStatus): AiAssessment => ({
  status,
  probability: status === 'SUCCEEDED' ? 0.5 : null,
  provider: 'openai',
  requestedModel: 'm',
  responseModel: null,
  requestId: null,
  rubricSha256: 'a'.repeat(64),
  inputSha256: 'b'.repeat(64),
  usage: null,
});

describe('AssessmentMemo', () => {
  it.each(['SUCCEEDED', 'REFUSED', 'INVALID_RESPONSE'] as const)(
    'remembers a %s answer, which already cost a request',
    status => {
      const memo = new AssessmentMemo();
      memo.remember('e1', answer(status));
      expect(memo.get('e1')?.status).toBe(status);
    },
  );

  it.each(['UNAVAILABLE', 'BUDGET_EXHAUSTED', 'CONFIG_INVALID', 'DISABLED'] as const)(
    'does not remember %s, so a retry can still reach the provider',
    status => {
      const memo = new AssessmentMemo();
      memo.remember('e1', answer(status));
      expect(memo.get('e1')).toBeUndefined();
    },
  );

  it('expires an entry after the TTL', () => {
    let now = 0;
    const memo = new AssessmentMemo(10, 1000, () => now);
    memo.remember('e1', answer('SUCCEEDED'));
    now = 1000;
    expect(memo.get('e1')).toBeDefined();
    now = 1001;
    expect(memo.get('e1')).toBeUndefined();
  });

  it('evicts the oldest entry beyond its bound', () => {
    const memo = new AssessmentMemo(2);
    memo.remember('e1', answer('SUCCEEDED'));
    memo.remember('e2', answer('SUCCEEDED'));
    memo.remember('e3', answer('SUCCEEDED'));
    expect(memo.get('e1')).toBeUndefined();
    expect(memo.get('e2')).toBeDefined();
    expect(memo.get('e3')).toBeDefined();
  });

  it('forgets an event once it is committed', () => {
    const memo = new AssessmentMemo();
    memo.remember('e1', answer('SUCCEEDED'));
    memo.forget('e1');
    expect(memo.get('e1')).toBeUndefined();
  });
});
