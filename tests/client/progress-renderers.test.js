import { afterEach, describe, expect, it } from 'vitest';
import * as ko from 'knockout';
import { CombatSessionRenderer } from '../../src/client/renderers/CombatSessionRenderer';
import { PresentationLoop } from '../../src/client/combat/PresentationLoop';
import { RouteCombatSimulation } from '../../src/simulation/combat/RouteCombatSimulation';
import combat from '../../public/config/combat.json';
import simulation from '../../public/config/simulation.json';
import lab from '../../public/config/lab.json';
const limits = { maxCaptured: 4, maxRoutes: 5 };
const frame = engine => ({ snapshot: engine.snapshot, progress: engine.progress });
const totals = root => Object.fromEntries([...root.querySelectorAll('[data-progress-field]')].map(node => [node.dataset.progressField, node.textContent]));
const rows = (root, name) => [...root.querySelectorAll(`[data-progress-table="${name}"] tbody tr`)].map(row => [...row.cells].map(cell => cell.textContent));
function setup(kind, supplied = lab.progressLabels) {
    const container = document.createElement('div'); document.body.appendChild(container);
    const scenario = structuredClone(lab.scenario); scenario.routes.forEach(route => route.opponents.forEach(opponent => { opponent.captureProbability = 1; }));
    const engine = new RouteCombatSimulation('progress-view', { combat, simulation }, scenario, 123);
    const view = new CombatSessionRenderer(container, 'progress-view', kind, lab.combatLabels, supplied, limits);
    return { container, engine, view };
}
afterEach(() => { ko.cleanNode(document.body); document.body.replaceChildren(); });
for (const kind of ['dom', 'knockout']) {
    describe(`${kind} committed progress presentation`, () => {
        it('shows initial totals, immediate defeat rewards and later capture rewards from the same frame', () => {
            const { container, engine, view } = setup(kind);
            expect(totals(container).money).toBe(lab.progressLabels.waiting);
            view.render(frame(engine)); expect(totals(container)).toEqual({ money: '0', experience: '0', dungeonTokens: '0', defeats: '0', clickAttacks: '0', pokeballs: '2' });
            expect(container.querySelector('[data-progress-notice="captured"]').textContent).toBe(lab.progressLabels.emptyCaptures);
            engine.advanceTo(3000); view.render(frame(engine));
            expect(totals(container)).toMatchObject({ money: '10', experience: '12', dungeonTokens: '0', defeats: '1', pokeballs: '1' });
            expect(container.querySelector('[data-combat-field="status"]').textContent).toBe(lab.combatLabels.capturing);
            expect(rows(container, 'routes')).toEqual([['0', '1', '1', '0']]); expect(rows(container, 'captured')).toEqual([]);
            engine.advanceTo(3300); view.render(frame(engine));
            expect(totals(container).dungeonTokens).toBe('2'); expect(rows(container, 'captured')).toEqual([['16', '1']]);
            expect(rows(container, 'routes')).toEqual([['0', '1', '1', '1']]); view.dispose();
        });
        it('does not rewrite unchanged totals or tables on newer frames, duplicates or stale frames', () => {
            const { container, engine, view } = setup(kind); const early = frame(engine);
            engine.advanceTo(3300); view.render(frame(engine));
            const row = container.querySelector('[data-progress-table="captured"] tbody tr');
            const observer = new MutationObserver(() => {}); observer.observe(container.querySelector('.ecs-progress'), { childList: true, subtree: true, characterData: true });
            engine.advanceTo(3400); view.render(frame(engine)); view.render(frame(engine)); view.render(early);
            expect(observer.takeRecords()).toEqual([]); expect(container.querySelector('[data-progress-table="captured"] tbody tr')).toBe(row);
            observer.disconnect(); view.dispose();
        });
        it('validates the whole frame before changing combat or progress and does not consume rejected sequence', () => {
            const { container, engine, view } = setup(kind); view.render(frame(engine)); const original = container.textContent;
            engine.advanceTo(3000); const next = frame(engine);
            expect(() => view.render({ ...next, progress: { ...next.progress, money: -1 } })).toThrow(); expect(container.textContent).toBe(original);
            expect(() => view.render({ ...next, snapshot: { ...next.snapshot, sessionId: 'foreign' } })).toThrow(); expect(container.textContent).toBe(original);
            view.render(next); expect(totals(container).money).toBe('10'); view.dispose();
        });
        it('treats JSON labels as text and removes all owned nodes and bindings on disposal', () => {
            const labels = { ...lab.progressLabels, title: '<img src=x onerror=alert(1)>', money: '<b>Money</b>' };
            const { container, engine, view } = setup(kind, labels); view.render(frame(engine));
            expect(container.querySelector('img')).toBeNull(); expect(container.querySelector('.ecs-progress h2').textContent).toBe(labels.title);
            const row = container.querySelector('[data-progress-field="money"]'); view.dispose(); view.dispose();
            expect(container.children).toHaveLength(0); expect(ko.contextFor(row)).toBeUndefined(); expect(() => view.render(frame(engine))).toThrow(/disposed/);
        });
    });
}
it('replacing presentation preserves committed totals without additional simulation advances', () => {
    const { container, engine, view } = setup('knockout'); engine.advanceTo(3300); const committed = frame(engine); view.render(committed);
    const expected = totals(container), captured = rows(container, 'captured'); view.dispose();
    const replacement = new CombatSessionRenderer(container, 'progress-view', 'dom', lab.combatLabels, lab.progressLabels, limits);
    let callback; const loop = new PresentationLoop({ latest: committed }, { request(fn) { callback = fn; return () => {}; } }, replacement);
    loop.start(); callback(); callback(); expect(totals(container)).toEqual(expected); expect(rows(container, 'captured')).toEqual(captured);
    expect(engine.progress).toEqual(committed.progress); expect(engine.snapshot.sequence).toBe(committed.snapshot.sequence); loop.dispose();
});
