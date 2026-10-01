import { logLevels } from './log-levels';

describe('logLevels', () => {
  it('enables the chosen level and everything more severe', () => {
    expect(logLevels('warn')).toEqual(['fatal', 'error', 'warn']);
    expect(logLevels('debug')).toEqual(['fatal', 'error', 'warn', 'log', 'debug']);
  });

  it('defaults to "log"', () => {
    expect(logLevels(undefined)).toEqual(['fatal', 'error', 'warn', 'log']);
  });

  it('falls back to "log" for an unknown level', () => {
    expect(logLevels('loud')).toEqual(['fatal', 'error', 'warn', 'log']);
  });
});
