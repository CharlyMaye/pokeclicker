const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, cpSync, readFileSync, writeFileSync, rmSync } = require('node:fs');
const path = require('node:path');
const { tmpdir } = require('node:os');
const { generateConfiguration } = require('../../tools/generate-configuration.cjs');

test('generation is reproducible and detects schema and data drift', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'pokeclicker-generation-'));
    const project = path.resolve(__dirname, '../..');
    try {
        for (const folder of ['schemas', 'public', 'src/contracts/generated', 'src/runtime/configuration/generated']) {
            cpSync(path.join(project, folder), path.join(root, folder), { recursive: true });
        }
        await generateConfiguration(true, root);
        const releaseFile = path.join(root, 'src/runtime/configuration/generated/release.json');
        const previousRelease = JSON.parse(readFileSync(releaseFile, 'utf8'));
        const configFile = path.join(root, 'public/config/combat.json');
        const combat = JSON.parse(readFileSync(configFile, 'utf8'));
        combat.clickAttackCooldownMs = 75;
        writeFileSync(configFile, JSON.stringify(combat));
        await assert.rejects(generateConfiguration(true, root), /release.json is stale/);
        await generateConfiguration(false, root);
        const nextRelease = JSON.parse(readFileSync(releaseFile, 'utf8'));
        assert.notEqual(nextRelease.version, previousRelease.version);
        assert.notEqual(nextRelease.files.combat.path, previousRelease.files.combat.path);
        assert.notEqual(nextRelease.files.combat.sha256, previousRelease.files.combat.sha256);
        await generateConfiguration(true, root);

        const schemaFile = path.join(root, 'schemas/combat.schema.json');
        const schema = JSON.parse(readFileSync(schemaFile, 'utf8'));
        schema.properties.schemaVersion.const = 2;
        writeFileSync(schemaFile, JSON.stringify(schema));
        await assert.rejects(generateConfiguration(true, root), /combat.d.ts is stale/);
        await generateConfiguration(false, root);
        assert.match(readFileSync(path.join(root, 'src/contracts/generated/combat.d.ts'), 'utf8'), /schemaVersion: 2/);
        await generateConfiguration(true, root);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
