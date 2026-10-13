// Fast execution transform only; run `npm run typecheck` separately.
module.exports = {
  rootDir: __dirname,
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  testRegex: '.*\\.spec\\.ts$',
  globalSetup: '<rootDir>/test/global-setup.ts',
  testTimeout: 30000,
  transform: { '^.+\\.tsx?$': ['ts-jest', { tsconfig: { isolatedModules: true } }] },
};
