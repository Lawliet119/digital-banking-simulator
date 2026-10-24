module.exports = {
  ...require('./jest.base'),
  testRegex: 'test/services/.*\\.services-spec\\.ts$',
  testTimeout: 360000,
};
