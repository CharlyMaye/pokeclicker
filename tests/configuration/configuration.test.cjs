const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, cpSync, rmSync, writeFileSync, unlinkSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { loadConfiguration, validateConfiguration, MAX_CONFIG_BYTES } = require('../../tools/configuration.cjs');

const publicRoot = path.resolve(__dirname, '../../public');
const baseline = loadConfiguration(publicRoot);
const copy = () => structuredClone(baseline);

test('accepts clicks closer together than a simulation step and returns detached, frozen settings', () => {
    const input = copy();
    const result = validateConfiguration(input);
    input.combat.clickAttackCooldownMs = 1;
    assert.equal(result.combat.clickAttackCooldownMs, 50);
    assert.ok(result.combat.clickAttackCooldownMs < result.simulation.stepMs);
    assert.ok(Object.isFrozen(result));
    assert.ok(Object.values(result).every(Object.isFrozen));
});

for (const value of [0, -1, 0.5, '50', null, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    test(`rejects invalid click cooldown ${String(value)}`, () => {
        const data = copy();
        data.combat.clickAttackCooldownMs = value;
        assert.throws(() => validateConfiguration(data), /combat.json.*clickAttackCooldownMs/);
    });
}

test('rejects missing fields, unknown properties and unsupported versions without repairing input', () => {
    for (const mutate of [
        data => { delete data.combat.autoAttackIntervalMs; },
        data => { data.combat.typo = 10; },
        data => { data.combat.schemaVersion = 2; },
        data => { data.simulation.schemaVersion = 1; },
        data => { data.simulation.schemaVersion = 2; },
        data => { data.simulation = null; },
    ]) {
        const data = copy();
        mutate(data);
        const original = structuredClone(data);
        assert.throws(() => validateConfiguration(data), /config\//);
        assert.deepEqual(data, original);
    }
});

test('rejects an automatic attack interval incompatible with the step', () => {
    const data = copy();
    data.simulation.stepMs = 300;
    assert.throws(() => validateConfiguration(data), /autoAttackIntervalMs.*stepMs/);
});

test('requires positive safe-integer processing limits without implicit defaults', () => {
    for (const field of ['maxStepsPerAdvance', 'maxQueuedCommands', 'maxTransitionsPerStep', 'maxCommandLeadMs', 'maxPendingOutputs']) {
        for (const value of [0, -1, 0.5, '100', null, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, undefined]) {
            const data = copy();
            if (value === undefined) delete data.simulation[field];
            else data.simulation[field] = value;
            assert.throws(() => validateConfiguration(data), new RegExp(`simulation.json.*${field}`));
        }
    }
});

function withFixture(run) {
    const root = mkdtempSync(path.join(tmpdir(), 'pokeclicker-config-'));
    try {
        cpSync(publicRoot, root, { recursive: true });
        run(root, path.join(root, 'config/combat.json'));
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
}

test('fails on missing, malformed, oversized and unregistered configuration files', () => {
    withFixture((root, file) => {
        unlinkSync(file);
        assert.throws(() => loadConfiguration(root), /expected exactly.*combat.json/);
    });
    withFixture((root, file) => {
        writeFileSync(file, '{broken');
        assert.throws(() => loadConfiguration(root), /combat.json/);
    });
    withFixture((root, file) => {
        writeFileSync(file, ' '.repeat(MAX_CONFIG_BYTES + 1));
        assert.throws(() => loadConfiguration(root), /combat.json.*byte limit/);
    });
    withFixture(root => {
        writeFileSync(path.join(root, 'config/unregistered.json'), '{}');
        assert.throws(() => loadConfiguration(root), /unregistered.json/);
    });
});
