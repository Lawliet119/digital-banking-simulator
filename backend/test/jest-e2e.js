module.exports = {
  ...require('./jest.base'),
  testRegex: 'test/.*\\.e2e-spec\\.ts$',
  testTimeout: 30000,
};
