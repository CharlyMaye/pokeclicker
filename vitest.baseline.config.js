import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'jsdom',
        setupFiles: 'vitest.setup.js',
        include: ['tests/baseline/**/*.test.js'],
        coverage: { enabled: false },
        restoreMocks: true,
    },
});
