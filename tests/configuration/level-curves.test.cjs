const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, writeFileSync, cpSync, mkdtempSync, rmSync } = require('node:fs');
const path = require('node:path');
const { tmpdir } = require('node:os');
const { parseLevelCurves } = require('../../tools/route-content.cjs');
const { generateConfiguration } = require('../../tools/generate-configuration.cjs');
const { loadConfiguration } = require('../../tools/configuration.cjs');
const { loadLevelCurves } = require('../../src/runtime/configuration/loadLevelCurves.ts');
const release = require('../../src/runtime/configuration/generated/release.json');
const policy = require('../../public/config/level-curves.json');
const bytes = () => readFileSync(path.resolve(__dirname, '../../public/config/level-curves.json'));

test('loads the pinned level curve policy beneath the Pages subpath', async () => {
    const urls = [];
    const loaded = await loadLevelCurves('https://example.test/pokeclicker/', { timeoutMs: 1000, fetch: async url => { urls.push(url); return new Response(bytes()); } });
    assert.deepEqual(loaded, parseLevelCurves(policy)); assert.ok(Object.isFrozen(loaded));
    assert.deepEqual(urls, [`https://example.test/pokeclicker/${release.files['level-curves'].path}`]);
});
test('rejects missing and stale level curve policy files before returning rules', async () => {
    await assert.rejects(loadLevelCurves('https://example.test/', { timeoutMs: 1000, fetch: async () => new Response('', { status: 404 }) }), e => e.code === 'http');
    await assert.rejects(loadLevelCurves('https://example.test/', { timeoutMs: 1000, fetch: async () => new Response(JSON.stringify({ ...policy, schemaVersion: 2 })) }), e => e.code === 'integrity');
});
test('level curve policy changes participate in build validation and release identity', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'ecs-level-curves-'));
    try {
        for (const dir of ['schemas', 'public', 'src/contracts/generated', 'src/runtime/configuration/generated']) cpSync(path.resolve(__dirname, '../..', dir), path.join(root, dir), { recursive: true });
        const file = path.join(root, 'public/config/level-curves.json');
        writeFileSync(file, JSON.stringify({ ...policy, curves: [] }));
        assert.throws(() => loadConfiguration(path.join(root, 'public')), /curve/i);
        await assert.rejects(generateConfiguration(false, root), /curve/i);
        const updated = structuredClone(policy); updated.curves[0].thresholds[1]++;
        writeFileSync(file, JSON.stringify(updated));
        await assert.rejects(generateConfiguration(true, root), /release.json is stale/);
        await generateConfiguration(false, root);
        const next = JSON.parse(readFileSync(path.join(root, 'src/runtime/configuration/generated/release.json')));
        assert.notEqual(next.version, release.version); assert.notEqual(next.files['level-curves'].sha256, release.files['level-curves'].sha256);
        await generateConfiguration(true, root);
    } finally { rmSync(root, { recursive: true, force: true }); }
});
