const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, cpSync, readFileSync, writeFileSync, rmSync } = require('node:fs');
const path = require('node:path');
const { tmpdir } = require('node:os');
const { parseLabConfiguration } = require('../../tools/lab-configuration.cjs');
const { generateConfiguration } = require('../../tools/generate-configuration.cjs');
const lab = require('../../public/config/lab.json');
const { loadLabConfiguration } = require('../../src/runtime/lab/loadLabConfiguration.ts');
const release = require('../../src/runtime/configuration/generated/release.json');

test('lab configuration detaches and freezes nested runtime, text, scenario and theme values', () => {
    const input = structuredClone(lab); const result = parseLabConfiguration(input);
    input.theme.text = '#000000'; input.scenario.routes[0].opponents[0].health = 1; input.text.title = 'changed';
    assert.equal(result.theme.text, lab.theme.text); assert.equal(result.scenario.routes[0].opponents[0].health, lab.scenario.routes[0].opponents[0].health);
    assert.ok(Object.isFrozen(result.theme)); assert.ok(Object.isFrozen(result.text)); assert.ok(Object.isFrozen(result.scenario.routes[0].opponents[0]));
});
for (const [label, mutate] of [
    ['obsolete lab version', value => { value.schemaVersion = 1; }],
    ['missing progress labels', value => { delete value.progressLabels; }],
    ['blank progress label', value => { value.progressLabels.money = ' '; }],
    ['previous lab version', value => { value.schemaVersion = 2; }],
    ['missing export filename', value => { delete value.checkpointFilename; }],
    ['unsafe export filename', value => { value.checkpointFilename = '../backup.json'; }],
    ['missing import confirmation text', value => { delete value.text.confirmImport; }],
    ['missing policy', value => { delete value.requestTimeoutMs; }],
    ['unsupported renderer', value => { value.initialRenderer = 'html'; }],
    ['unknown fields', value => { value.unknown = 1; }],
    ['browser timer overflow', value => { value.startupTimeoutMs = 2 ** 31; }],
    ['zero storage bound', value => { value.maxCheckpointBytes = 0; }],
    ['nonportable slot', value => { value.saveSlot = '../legacy'; }],
    ['invalid seed', value => { value.seed = 0; }],
    ['blank text', value => { value.text.title = ' '; }],
    ['CSS injection', value => { value.theme.text = 'red; display:none'; }],
    ['invalid layout', value => { value.theme.gapRem = Infinity; }],
    ['invalid route reference', value => { value.scenario.initialLocation.route = 99; }],
    ['missing combat label', value => { delete value.combatLabels.title; }],
]) {
    test(`lab rejects ${label} without fallback`, () => { const value = structuredClone(lab); mutate(value); assert.throws(() => parseLabConfiguration(value)); });
}
test('accessors are rejected without execution', () => {
    let called = false; const value = structuredClone(lab);
    Object.defineProperty(value, 'seed', { enumerable: true, get() { called = true; return 123; } });
    assert.throws(() => parseLabConfiguration(value)); assert.equal(called, false);
});
test('lab data participates in deterministic release identity and stale generation checks', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'ecs-lab-config-'));
    try {
        for (const folder of ['schemas', 'public', 'src/contracts/generated', 'src/runtime/configuration/generated']) cpSync(path.resolve(__dirname, '../..', folder), path.join(root, folder), { recursive: true });
        const changed = structuredClone(lab); changed.theme.accent = '#ffffff';
        writeFileSync(path.join(root, 'public/config/lab.json'), JSON.stringify(changed));
        await assert.rejects(generateConfiguration(true, root), /release.json is stale/);
        await generateConfiguration(false, root);
        const next = JSON.parse(readFileSync(path.join(root, 'src/runtime/configuration/generated/release.json')));
        assert.notEqual(next.version, release.version); assert.notEqual(next.files.lab.sha256, release.files.lab.sha256);
        await generateConfiguration(true, root);
    } finally { rmSync(root, { recursive: true, force: true }); }
});
test('runtime loads all pinned lab documents under a project subpath and fails on a missing lab', async () => {
    const urls = [];
    const fetch = async url => { urls.push(url); const name = Object.keys(release.files).find(name => url.endsWith(release.files[name].path)); return new Response(readFileSync(path.resolve(__dirname, '../../public/config', `${name}.json`))); };
    const result = await loadLabConfiguration('https://example.test/pokeclicker/', { timeoutMs: 1000, fetch });
    assert.deepEqual(result.lab, parseLabConfiguration(lab)); assert.equal(urls.length, 3); assert.ok(urls.every(url => url.startsWith('https://example.test/pokeclicker/configuration/')));
    await assert.rejects(loadLabConfiguration('https://example.test/pokeclicker/', { timeoutMs: 1000, fetch: url => url.endsWith('/lab.json') ? Promise.resolve(new Response('', { status: 404 })) : fetch(url) }), error => error.code === 'http');
});
