import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'jsdom',
        include: ['tests/client/**/*.test.js'],
        coverage: { enabled: false },
        restoreMocks: true,
    },
});
