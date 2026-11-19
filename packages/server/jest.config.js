module.exports = {
    // Use ts-jest preset for testing TypeScript files with Jest
    preset: 'ts-jest',
    // Set the test environment to Node.js
    testEnvironment: 'node',

    // Define the root directory for tests and modules
    roots: ['<rootDir>/test'],

    // Use ts-jest to transform TypeScript files and ESM-only dependencies like p-limit/yocto-queue
    transform: {
        '^.+\\.tsx?$': 'ts-jest',
        '.*(?:p-limit|yocto-queue).*\\.m?js$': [
            'ts-jest',
            {
                diagnostics: false,
                tsconfig: {
                    allowJs: true,
                    target: 'es2022',
                    module: 'commonjs',
                    esModuleInterop: true
                }
            }
        ]
    },

    transformIgnorePatterns: ['/node_modules/(?!.*(?:p-limit|yocto-queue)/)'],

    // Regular expression to find test files
    testRegex: '(/__tests__/.*|(\\.|/)(test|spec))\\.tsx?$',

    // Exclude legacy helper files imported directly by test/index.test.ts
    testPathIgnorePatterns: ['/node_modules/', '/dist/', '<rootDir>/test/routes/', '<rootDir>/test/utils/api-key\\.util\\.test\\.ts'],

    // Prevent test imports from writing secret/log artifacts into the repository
    setupFiles: ['<rootDir>/test/setupEnv.ts'],

    // File extensions to recognize in module resolution
    moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],

    // Display individual test results with the test suite hierarchy.
    verbose: true
}
