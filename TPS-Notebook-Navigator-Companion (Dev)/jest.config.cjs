module.exports = {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  extensionsToTreatAsEsm: ['.ts'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { useESM: true, tsconfig: '<rootDir>/tsconfig.test.json' }]
  },
  moduleNameMapper: {    '^obsidian$': '<rootDir>/tests/mocks/obsidian.ts',    '^(\\.{1,2}/.*)\\.js$': '$1'
  }
};
