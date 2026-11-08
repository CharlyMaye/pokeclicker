const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
require('../../tools/lab-configuration.cjs');
const { mountCheckpointFiles } = require('../../src/runtime/lab/mountCheckpointFiles.ts');
const { RouteCombatSimulation } = require('../../src/simulation/combat/RouteCombatSimulation.ts');
const { parseHostCheckpoint } = require('../../src/runtime/persistence/HostCheckpoint.ts');
const lab = require('../../public/config/lab.json');
const configuration = { combat: require('../../public/config/combat.json'), simulation: require('../../public/config/simulation.json') };

test('party checkpoint preview displays saved levels without importing or advancing combat', async () => {
    const dom = new JSDOM('<div id="root"></div>');
    const definition = require('../fixtures/runtime/party-scenario.cjs')();
    const game = new RouteCombatSimulation('preview-party', configuration, definition, 123); game.advanceTo(3000);
    const saved = { formatVersion: 1, activeTimeMs: 3000, combat: game.checkpoint() }, original = game.checkpoint();
    const bytes = new TextEncoder().encode(JSON.stringify(saved));
    const previousReader = global.FileReader;
    global.FileReader = class {
        readAsArrayBuffer() { this.result = bytes.buffer; queueMicrotask(() => this.onload?.()); }
        abort() { this.onabort?.(); }
    };
    let imported = 0, pending;
    const root = dom.window.document.getElementById('root');
    const controller = { state: 'stopped', previewImport(value) { return parseHostCheckpoint(JSON.parse(value), configuration, definition); },
        async importCheckpoint() { imported++; } };
    const ui = mountCheckpointFiles(root, controller, { ...lab, scenario: definition }, { changed() {}, execute(action) { pending = action(); return pending; } });
    try {
        const input = root.querySelector('input'); Object.defineProperty(input, 'files', { value: [{ name: 'party.json', size: bytes.length }] });
        input.dispatchEvent(new dom.window.Event('change')); await pending;
        assert.equal(root.querySelector('fieldset').hidden, false);
        const rows = [...root.querySelectorAll('[data-progress-table="party"] tbody tr')].map(row => [...row.cells].map(cell => cell.textContent));
        assert.deepEqual(rows[0], ['1', '3', '319.5']);
        assert.equal(root.querySelector('[data-party-field="shadowExperience"]').textContent, '372.75');
        assert.equal(imported, 0); assert.deepEqual(game.checkpoint(), original);
        root.querySelector('[data-action="import-cancel"]').click();
        assert.equal(root.querySelector('[data-checkpoint-preview]').children.length, 0); assert.equal(imported, 0);
    } finally { ui.dispose(); global.FileReader = previousReader; dom.window.close(); }
});
