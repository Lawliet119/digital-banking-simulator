// Tests against a real PostgreSQL (docker compose locally, a service container in CI). Each file
// creates its own throwaway database, so suites never see each other's rows. Not part of
// `test:e2e` on purpose: those run without Docker.
module.exports = {
  ...require('./jest.base'),
  testRegex: 'test/(db|security)/.*\\.db-spec\\.ts$', // DBS-158: the security suite lives in test/security
  testTimeout: 120000,
  globalSetup: '<rootDir>/test/support/jest-global-setup.ts',
  globalTeardown: '<rootDir>/test/support/jest-global-teardown.ts',
};
