/** @type {import('jest').Config} */
export default {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
    // Redirect the Copilot SDK to a lightweight test mock so that Jest
    // never has to evaluate client.js (which uses import.meta.resolve()).
    '^@github/copilot-sdk$': '<rootDir>/src/__tests__/mocks/copilot-sdk-mock.ts',
    // Chokidar v4 is ESM-only and cannot be loaded by Jest's CJS transform.
    '^chokidar$': '<rootDir>/src/__tests__/mocks/chokidar-mock.ts',
    // bonjour-service uses native mDNS; redirect to mock for unit tests.
    '^bonjour-service$': '<rootDir>/src/__tests__/mocks/bonjour-service-mock.ts',
  },
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        useESM: true,
      },
    ],
  },
  testMatch: [
    '<rootDir>/src/**/__tests__/**/*.test.ts'
  ],
  testPathIgnorePatterns: [
    '/node_modules/',
    '/smoke_tests/',
    '/debug/'
  ],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/index.ts',
    '!src/**/*.d.ts'
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],
  verbose: true
};
