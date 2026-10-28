module.exports = {
  ...require('./jest.base'),
  testRegex: 'test/services/.*\\.services-spec\\.ts$',
  // Ngân sách tệ nhất mỗi it (2 lần start/it): (DOCKER_CHECK_TIMEOUT_MS 15s +
  // OVERALL_START_TIMEOUT_MS 300s + ELASTICMQ_PROBE_TIMEOUT_MS 150s) * 2 = 930s. 1.080.000ms để
  // lại biên ~150s (~16,1%) — DBS-40 vòng 2, xem docs/features/DBS-40-...md §2.
  testTimeout: 1_080_000,
};
