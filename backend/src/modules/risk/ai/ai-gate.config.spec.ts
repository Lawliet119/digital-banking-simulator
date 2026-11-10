import { AiGate, type AiGateOptions } from './ai-gate';

const base: AiGateOptions = {
  connectionString: 'postgres://u:p@db.internal:5432/app',
  policy: { revision: 'r1', dailyRequestLimit: 10, concurrentLimit: 2 },
  deadlineMs: 1000,
};

describe('AiGate.configurationProblem', () => {
  it('is undefined for a usable gate', () => {
    expect(new AiGate(base).configurationProblem()).toBeUndefined();
  });

  it('names the ssl query parameter problem without echoing the connection string', () => {
    const connectionString = 'postgres://u:secret@db.internal:5432/app?sslmode=require';
    const gate = new AiGate({ ...base, connectionString });
    const problem = gate.configurationProblem();
    expect(problem).toContain('DATABASE_SSL');
    expect(problem).not.toContain('secret');
    expect(problem).not.toContain('db.internal');
  });

  it('reports missing options and out-of-range values', () => {
    expect(new AiGate(undefined).configurationProblem()).toBeDefined();
    expect(new AiGate({ ...base, deadlineMs: 0 }).configurationProblem()).toContain('out of range');
  });
});
