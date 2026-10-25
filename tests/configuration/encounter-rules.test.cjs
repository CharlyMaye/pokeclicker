const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, writeFileSync, cpSync, mkdtempSync, rmSync } = require('node:fs');
const path = require('node:path');
const { tmpdir } = require('node:os');
require('../../tools/route-content.cjs');
const { generateConfiguration } = require('../../tools/generate-configuration.cjs');
const { loadConfiguration } = require('../../tools/configuration.cjs');
const { loadRoutePreparationPolicies } = require('../../src/runtime/configuration/loadRoutePreparationPolicies.ts');
const release = require('../../src/runtime/configuration/generated/release.json');
const encounterPolicy = require('../../public/config/encounter-rules.json');
const healthPolicy = require('../../public/config/route-health.json');
const bytes = name => readFileSync(path.resolve(__dirname, '../../public/config', `${name}.json`));
const fetchFile = async url => new Response(bytes(url.endsWith('/route-health.json') ? 'route-health' : 'encounter-rules'));

test('loads both preparation policies from the same pinned release under the project subpath', async () => {
    const urls = [];
    const result = await loadRoutePreparationPolicies('https://example.test/pokeclicker/', { timeoutMs: 1000, fetch: url => { urls.push(url); return fetchFile(url); } });
    assert.deepEqual(result, { encounterPolicy, healthPolicy }); assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.encounterPolicy));
    assert.deepEqual(urls, ['route-health', 'encounter-rules'].map(name => `https://example.test/pokeclicker/${release.files[name].path}`));
});
test('rejects missing or stale second policy without returning a partial bundle', async () => {
    await assert.rejects(loadRoutePreparationPolicies('https://example.test/', { timeoutMs: 1000, fetch: url => url.endsWith('/encounter-rules.json') ? Promise.resolve(new Response('', { status: 404 })) : fetchFile(url) }), e => e.code === 'http');
    await assert.rejects(loadRoutePreparationPolicies('https://example.test/', { timeoutMs: 1000, fetch: url => url.endsWith('/encounter-rules.json') ? Promise.resolve(new Response(JSON.stringify({ ...encounterPolicy, moneyMinimum: 11 }))) : fetchFile(url) }), e => e.code === 'integrity');
});
test('encounter policy is validated by builds and participates in release identity', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'ecs-encounter-policy-'));
    try {
        for (const dir of ['schemas', 'public', 'src/contracts/generated', 'src/runtime/configuration/generated']) cpSync(path.resolve(__dirname, '../..', dir), path.join(root, dir), { recursive: true });
        const file = path.join(root, 'public/config/encounter-rules.json');
        writeFileSync(file, JSON.stringify({ ...encounterPolicy, tokenDivisor: 0 }));
        assert.throws(() => loadConfiguration(path.join(root, 'public')), /tokenDivisor/); await assert.rejects(generateConfiguration(false, root), /tokenDivisor/);
        writeFileSync(file, JSON.stringify({ ...encounterPolicy, moneyMinimum: 11 }));
        await assert.rejects(generateConfiguration(true, root), /release.json is stale/); await generateConfiguration(false, root);
        const next = JSON.parse(readFileSync(path.join(root, 'src/runtime/configuration/generated/release.json')));
        assert.notEqual(next.version, release.version); assert.notEqual(next.files['encounter-rules'].sha256, release.files['encounter-rules'].sha256);
        await generateConfiguration(true, root);
    } finally { rmSync(root, { recursive: true, force: true }); }
});
