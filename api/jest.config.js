module.exports = {
  rootDir: './',
  testPathIgnorePatterns: ['<rootDir>/node_modules/'],
  // Node environment
  testEnvironment: 'node',
  collectCoverageFrom: ['*/**/*.{js,jsx}', '!**/node_modules/**'],
  // Only write lcov files in CIs
  coverageReporters: ['text'].concat(process.env.CI ? 'lcov' : []),
};