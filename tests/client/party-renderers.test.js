import { afterEach, describe, expect, it } from 'vitest';
import * as ko from 'knockout';
import { CombatSessionRenderer } from '../../src/client/renderers/CombatSessionRenderer';
import { PresentationLoop } from '../../src/client/combat/PresentationLoop';
import { RouteCombatSimulation } from '../../src/simulation/combat/RouteCombatSimulation';
import makeParty from '../fixtures/runtime/party-scenario.cjs';
import combat from '../../public/config/combat.json';
import simulation from '../../public/config/simulation.json';
import lab from '../../public/config/lab.json';
const limits = { maxCaptured: 100, maxRoutes: 100, maxParty: 3 };
const frame = engine => ({ snapshot: engine.snapshot, progress: engine.progress, party: engine.partyExperience });
const rows = root => [...root.querySelectorAll('[data-progress-table="party"] tbody tr')].map(row => [...row.cells].map(cell => cell.textContent));
function setup(kind, definition = makeParty(), labels = lab.progressLabels) {
    const container = document.createElement('div'); document.body.appendChild(container);
    const engine = new RouteCombatSimulation('party-view', { combat, simulation }, definition, 123);
    const bounds = { maxCaptured: 100, maxRoutes: 100, ...(definition.formatVersion === 4 ? { maxParty: definition.party.members.length } : {}) };
    const view = new CombatSessionRenderer(container, 'party-view', kind, lab.combatLabels, labels, bounds);
    return { container, engine, view };
}
afterEach(() => { ko.cleanNode(document.body); document.body.replaceChildren(); });
for (const kind of ['dom', 'knockout']) {
    describe(`${kind} party presentation`, () => {
        it('shows committed levels and fractional experience with the same defeat count', () => {
            const { container, engine, view } = setup(kind); view.render(frame(engine));
            expect(rows(container)).toEqual([['1', '1', '0'], ['2', '100', '800000'], ['3.01', '1', '0']]);
            engine.advanceTo(3000); view.render(frame(engine));
            expect(rows(container)[0]).toEqual(['1', '3', '319.5']);
            expect(rows(container)).toEqual(engine.partyExperience.members.map(p => [String(p.pokemonId), String(p.level), String(p.experience)]));
            expect(container.querySelector('[data-party-field="shadowExperience"]').textContent).toBe('372.75');
            expect(container.querySelector('[data-party-field="grants"]').textContent).toBe(container.querySelector('[data-progress-field="defeats"]').textContent); view.dispose();
        });
        it('validates the whole frame before changing any panel and allows a corrected retry', () => {
            const { container, engine, view } = setup(kind); view.render(frame(engine)); const before = container.innerHTML;
            engine.advanceTo(3000); const next = frame(engine), invalid = structuredClone(next); invalid.party.grants++;
            expect(() => view.render(invalid)).toThrow(); expect(container.innerHTML).toBe(before);
            view.render(next); expect(rows(container)[0][1]).toBe('3'); view.dispose();
        });
        it('ignores stale frames and retains unchanged table nodes', () => {
            const { container, engine, view } = setup(kind); const initial = frame(engine);
            engine.advanceTo(3000); view.render(frame(engine)); const row = container.querySelector('[data-progress-table="party"] tbody tr');
            const observer = new MutationObserver(() => {}); observer.observe(container.querySelector('[data-progress-table="party"]'), { childList: true, subtree: true, characterData: true });
            engine.advanceTo(3100); view.render(frame(engine)); view.render(frame(engine)); view.render(initial);
            expect(observer.takeRecords()).toEqual([]); expect(container.querySelector('[data-progress-table="party"] tbody tr')).toBe(row);
            observer.disconnect(); view.dispose();
        });
        it('distinguishes empty and disabled parties', () => {
            const definition = structuredClone(makeParty()); definition.party.members = [];
            const empty = setup(kind, definition); empty.view.render(frame(empty.engine));
            expect(empty.container.querySelector('[data-progress-notice="party"]').textContent).toBe(lab.progressLabels.emptyParty); empty.view.dispose();
            const disabled = setup(kind, lab.scenario); disabled.view.render({ snapshot: disabled.engine.snapshot, progress: disabled.engine.progress });
            expect(disabled.container.querySelector('[data-progress-notice="party"]').textContent).toBe(lab.progressLabels.partyDisabled);
            expect(rows(disabled.container)).toEqual([]); disabled.view.dispose();
        });
        it('renders JSON labels as text and releases bindings on disposal', () => {
            const labels = { ...lab.progressLabels, party: '<img src=x>', level: '<b>Level</b>' };
            const { container, engine, view } = setup(kind, makeParty(), labels); view.render(frame(engine));
            const table = container.querySelector('[data-progress-table="party"]');
            expect(table.querySelector('caption').textContent).toBe(labels.party); expect(table.querySelector('img')).toBeNull();
            const cell = table.querySelector('td'); view.dispose(); view.dispose(); expect(container.children).toHaveLength(0); expect(ko.contextFor(cell)).toBeUndefined();
        });
    });
}
for (const frames of [0, 1, 7]) {
    it(`replaces presentation after ${frames} display frames without advancing the world`, () => {
        const { container, engine, view } = setup('knockout'); engine.advanceTo(3000); const committed = frame(engine);
        let callback; const loop = new PresentationLoop({ latest: committed }, { request(fn) { callback = fn; return () => {}; } }, view); loop.start();
        for (let n = 0; n < frames; n++) callback();
        const checkpoint = engine.checkpoint(); loop.dispose();
        const replacement = new CombatSessionRenderer(container, 'party-view', 'dom', lab.combatLabels, lab.progressLabels, limits); replacement.render(committed);
        expect(rows(container)).toEqual(committed.party.members.map(p => [String(p.pokemonId), String(p.level), String(p.experience)]));
        expect(engine.checkpoint()).toEqual(checkpoint); replacement.dispose();
    });
}
