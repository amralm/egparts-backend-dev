module.exports = {
  testEnvironment: 'node',
  clearMocks: true,
  collectCoverage: true,
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov'],
  collectCoverageFrom: [
    'kernel/**/*.js',
    '!kernel/testing/**/*.js', // Don't require 100% on the fakes themselves
  ],
  coverageThreshold: {
    './kernel/core/': {
      branches: 100,
      functions: 100,
      lines: 100,
      statements: 100,
    },
    './kernel/policy/': {
      branches: 100,
      functions: 100,
      lines: 100,
      statements: 100,
    },
    './kernel/contracts/': {
      branches: 100,
      functions: 100,
      lines: 100,
      statements: 100,
    }
  },
  testMatch: [
    '**/tests/**/*.test.js'
  ]
};
