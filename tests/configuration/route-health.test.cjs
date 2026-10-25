const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, writeFileSync, cpSync, mkdtempSync, rmSync } = require('node:fs');
const path = require('node:path');
const { tmpdir } = require('node:os');
const { parseRouteHealthPolicy } = require('../../tools/route-content.cjs');
const { generateConfiguration } = require('../../tools/generate-configuration.cjs');
const { loadConfiguration } = require('../../tools/configuration.cjs');
const { loadRouteHealthPolicy } = require('../../src/runtime/configuration/loadRouteHealthPolicy.ts');
const release = require('../../src/runtime/configuration/generated/release.json');
const policy = require('../../public/config/route-health.json');
const bytes = () => readFileSync(path.resolve(__dirname, '../../public/config/route-health.json'));

test('loads the pinned route health policy beneath the Pages subpath', async () => {
    const urls = [];
    const loaded = await loadRouteHealthPolicy('https://example.test/pokeclicker/', { timeoutMs: 1000, fetch: async url => { urls.push(url); return new Response(bytes()); } });
    assert.deepEqual(loaded, parseRouteHealthPolicy(policy)); assert.ok(Object.isFrozen(loaded));
    assert.deepEqual(urls, [`https://example.test/pokeclicker/${release.files['route-health'].path}`]);
});
test('rejects missing and stale health policy files before returning rules', async () => {
    await assert.rejects(loadRouteHealthPolicy('https://example.test/', { timeoutMs: 1000, fetch: async () => new Response('', { status: 404 }) }), e => e.code === 'http');
    await assert.rejects(loadRouteHealthPolicy('https://example.test/', { timeoutMs: 1000, fetch: async () => new Response(JSON.stringify({ ...policy, minimumHealth: 21 })) }), e => e.code === 'integrity');
});
test('health policy changes participate in build validation and release identity', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'ecs-route-health-'));
    try {
        for (const dir of ['schemas', 'public', 'src/contracts/generated', 'src/runtime/configuration/generated']) cpSync(path.resolve(__dirname, '../..', dir), path.join(root, dir), { recursive: true });
        const file = path.join(root, 'public/config/route-health.json');
        writeFileSync(file, JSON.stringify({ ...policy, minimumHealth: 0 }));
        assert.throws(() => loadConfiguration(path.join(root, 'public')), /minimumHealth/);
        await assert.rejects(generateConfiguration(false, root), /minimumHealth/);
        writeFileSync(file, JSON.stringify({ ...policy, minimumHealth: 21 }));
        await assert.rejects(generateConfiguration(true, root), /release.json is stale/);
        await generateConfiguration(false, root);
        const next = JSON.parse(readFileSync(path.join(root, 'src/runtime/configuration/generated/release.json')));
        assert.notEqual(next.version, release.version); assert.notEqual(next.files['route-health'].sha256, release.files['route-health'].sha256);
        await generateConfiguration(true, root);
    } finally { rmSync(root, { recursive: true, force: true }); }
});
