import { AppRole, getAppRole, parseAppRole, runsHttp, runsWorkers } from './app-role';

describe('app-role', () => {
  describe('parseAppRole', () => {
    it('defaults to both when unset', () => {
      expect(parseAppRole(undefined)).toBe(AppRole.Both);
    });

    it.each([
      ['api', AppRole.Api],
      ['worker', AppRole.Worker],
      ['both', AppRole.Both],
      ['  API ', AppRole.Api],
      ['Worker', AppRole.Worker],
    ])('accepts %j', (raw, expected) => {
      expect(parseAppRole(raw)).toBe(expected);
    });

    it('rejects an unknown role instead of silently running as both', () => {
      expect(() => parseAppRole('apii')).toThrow(/Invalid APP_ROLE "apii"/);
      expect(() => parseAppRole('')).toThrow(/Invalid APP_ROLE/);
    });
  });

  describe('getAppRole', () => {
    it('reads APP_ROLE from the given environment', () => {
      expect(getAppRole({ APP_ROLE: 'worker' })).toBe(AppRole.Worker);
      expect(getAppRole({})).toBe(AppRole.Both);
    });
  });

  describe('what each role runs', () => {
    it.each([
      [AppRole.Api, true, false],
      [AppRole.Worker, false, true],
      [AppRole.Both, true, true],
    ])('%s → http=%s workers=%s', (role, http, workers) => {
      expect(runsHttp(role)).toBe(http);
      expect(runsWorkers(role)).toBe(workers);
    });
  });
});
