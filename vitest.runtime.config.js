import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'node',
        include: ['tests/runtime/**/*.test.js'],
        coverage: { enabled: false },
        restoreMocks: true,
    },
});
