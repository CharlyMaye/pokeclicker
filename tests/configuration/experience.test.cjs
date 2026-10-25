const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, writeFileSync, cpSync, mkdtempSync, rmSync } = require('node:fs');
const path = require('node:path');
const { tmpdir } = require('node:os');
const { parseExperiencePolicy } = require('../../tools/route-content.cjs');
const { generateConfiguration } = require('../../tools/generate-configuration.cjs');
const { loadConfiguration } = require('../../tools/configuration.cjs');
const { loadExperiencePolicy } = require('../../src/runtime/configuration/loadExperiencePolicy.ts');
const release = require('../../src/runtime/configuration/generated/release.json');
const policy = require('../../public/config/experience.json');
const bytes = () => readFileSync(path.resolve(__dirname, '../../public/config/experience.json'));

test('loads the pinned experience policy beneath the Pages subpath', async () => {
    const urls = [];
    const loaded = await loadExperiencePolicy('https://example.test/pokeclicker/', { timeoutMs: 1000, fetch: async url => { urls.push(url); return new Response(bytes()); } });
    assert.deepEqual(loaded, parseExperiencePolicy(policy)); assert.ok(Object.isFrozen(loaded));
    assert.deepEqual(urls, [`https://example.test/pokeclicker/${release.files['experience'].path}`]);
});
test('rejects missing and stale experience policy files before returning rules', async () => {
    await assert.rejects(loadExperiencePolicy('https://example.test/', { timeoutMs: 1000, fetch: async () => new Response('', { status: 404 }) }), e => e.code === 'http');
    await assert.rejects(loadExperiencePolicy('https://example.test/', { timeoutMs: 1000, fetch: async () => new Response(JSON.stringify({ ...policy, experienceDivisor: 10 })) }), e => e.code === 'integrity');
});
test('experience policy changes participate in build validation and release identity', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'ecs-experience-'));
    try {
        for (const dir of ['schemas', 'public', 'src/contracts/generated', 'src/runtime/configuration/generated']) cpSync(path.resolve(__dirname, '../..', dir), path.join(root, dir), { recursive: true });
        const file = path.join(root, 'public/config/experience.json');
        writeFileSync(file, JSON.stringify({ ...policy, experienceDivisor: 0 }));
        assert.throws(() => loadConfiguration(path.join(root, 'public')), /experienceDivisor/);
        await assert.rejects(generateConfiguration(false, root), /experienceDivisor/);
        writeFileSync(file, JSON.stringify({ ...policy, experienceDivisor: 10 }));
        await assert.rejects(generateConfiguration(true, root), /release.json is stale/);
        await generateConfiguration(false, root);
        const next = JSON.parse(readFileSync(path.join(root, 'src/runtime/configuration/generated/release.json')));
        assert.notEqual(next.version, release.version); assert.notEqual(next.files['experience'].sha256, release.files['experience'].sha256);
        await generateConfiguration(true, root);
    } finally { rmSync(root, { recursive: true, force: true }); }
});
