import { afterEach, describe, expect, it, vi } from 'vitest';
import * as ko from 'knockout';
import { DomCombatRenderer } from '../../src/client/renderers/DomCombatRenderer';
import { KnockoutCombatRenderer } from '../../src/client/renderers/KnockoutCombatRenderer';
import { CombatViewModel } from '../../src/client/combat/CombatViewModel';
import { PresentationLoop } from '../../src/client/combat/PresentationLoop';
import { DirectCombatHost } from '../../src/runtime/combat/DirectCombatHost';
import labels from '../fixtures/presentation/combat-labels.json';
import scenario from '../fixtures/simulation/route-transitions.json';
import combat from '../../public/config/combat.json';
import simulation from '../../public/config/simulation.json';

const snapshot = (sequence = 1, atMs = 100, encounter = { phase: 'fighting', enemy: { encounterId: 1, pokemonId: 16, health: 30, maxHealth: 30 } }) => ({
    protocolVersion: 1, type: 'CombatSnapshot', sessionId: 'views', sequence, atMs, location: { region: 0, route: 1 }, encounter,
});
const capturing = { phase: 'capturing', resolvesAtMs: 400, enemy: { encounterId: 1, pokemonId: 16, health: 0, maxHealth: 30 } };
const contents = container => Object.fromEntries([...container.querySelectorAll('[data-combat-field]')].map(node => [node.dataset.combatField, node.textContent]));
function mount() {
    const container = document.createElement('div');
    document.body.appendChild(container);
    return container;
}

afterEach(() => {
    ko.cleanNode(document.body);
    document.body.replaceChildren();
});

for (const Renderer of [DomCombatRenderer, KnockoutCombatRenderer]) {
    describe(Renderer.name, () => {
        it('presents waiting, fighting, capturing and idle states from snapshots alone', () => {
            const container = mount();
            const view = new Renderer(container, 'views', labels);
            expect(contents(container).status).toBe(labels.waiting);
            view.render(snapshot());
            expect(contents(container)).toEqual({ region: '0', route: '1', status: labels.fighting, opponent: '16', health: '30 / 30', capture: labels.unavailable });
            view.render(snapshot(2, 200, capturing));
            expect(contents(container)).toMatchObject({ status: labels.capturing, health: '0 / 30', capture: '200 ms' });
            view.render(snapshot(3, 400, capturing));
            expect(contents(container)).toMatchObject({ status: labels.capturing, capture: '0 ms' });
            view.render(snapshot(4, 500, { phase: 'idle' }));
            expect(contents(container)).toMatchObject({ status: labels.idle, opponent: labels.unavailable, health: labels.unavailable, capture: labels.unavailable });
            view.dispose();
        });

        it('shows the current selection while retaining the source opponent during capture', () => {
            const container = mount();
            const view = new Renderer(container, 'views', labels);
            view.render({ ...snapshot(1, 300, capturing), location: { region: 0, route: 2 } });
            expect(contents(container)).toMatchObject({ route: '2', opponent: '16', capture: '100 ms' });
            view.dispose();
        });

        it('ignores duplicate and stale snapshots without DOM writes and rejects foreign sessions', () => {
            const container = mount();
            const view = new Renderer(container, 'views', labels);
            const current = snapshot(2, 200);
            view.render(current);
            const observer = new MutationObserver(() => {});
            observer.observe(container, { childList: true, subtree: true, characterData: true, attributes: true });
            view.render(current);
            view.render(snapshot(1, 100, { phase: 'idle' }));
            expect(observer.takeRecords()).toEqual([]);
            expect(() => view.render({ ...snapshot(3, 300), sessionId: 'old-session' })).toThrow(/another session/);
            expect(contents(container).status).toBe(labels.fighting);
            view.render(snapshot(3, 300, { phase: 'idle' }));
            expect(contents(container).status).toBe(labels.idle);
            observer.disconnect(); view.dispose();
        });

        it('rejects invalid snapshots before changing displayed state or consuming sequence', () => {
            const container = mount();
            const view = new Renderer(container, 'views', labels);
            view.render(snapshot());
            const before = container.innerHTML;
            const invalid = snapshot(2, 200);
            invalid.encounter.enemy.health = -1;
            expect(() => view.render(invalid)).toThrow();
            expect(container.innerHTML).toBe(before);
            view.render(snapshot(2, 200, capturing));
            expect(contents(container).status).toBe(labels.capturing);
            view.dispose();
        });

        it('renders injected labels as text and copies them before later mutation', () => {
            const container = mount();
            const supplied = { ...labels, title: '<img src=x onerror="alert(1)">', health: 'data-bind="html: payload"' };
            const view = new Renderer(container, 'views', supplied);
            supplied.fighting = 'Changed after startup';
            view.render(snapshot());
            expect(container.querySelector('h2').textContent).toBe(supplied.title);
            expect(container.querySelectorAll('img, script, [data-bind]')).toHaveLength(0);
            expect(contents(container).status).toBe(labels.fighting);
            view.dispose();
        });

        it('removes only its own subtree and leaves neighboring Knockout bindings alive', () => {
            const container = mount();
            const sibling = document.createElement('span');
            const text = ko.observable('Outside');
            ko.applyBindingsToNode(sibling, { text }, {});
            container.appendChild(sibling);
            const view = new Renderer(container, 'views', labels);
            view.render(snapshot());
            view.dispose(); view.dispose();
            text('Still bound');
            expect(container.children).toHaveLength(1);
            expect(sibling.textContent).toBe('Still bound');
            expect(() => view.render(snapshot(2, 200))).toThrow(/disposed/);
        });

        it.each([
            value => { delete value.title; },
            value => { value.unexpected = 'extra'; },
            value => { value.health = ''; },
            value => { value.health = 100; },
            value => { Object.setPrototypeOf(value, { extra: true }); },
            value => { Object.defineProperty(value, 'title', { get() { throw new Error('Getter must not run'); } }); },
        ])('rejects malformed labels without attaching a partial view', mutate => {
            const container = mount();
            const supplied = { ...labels };
            mutate(supplied);
            expect(() => new Renderer(container, 'views', supplied)).toThrow(/Combat label/);
            expect(container.children).toHaveLength(0);
        });
    });
}

describe('Knockout resource ownership', () => {
    it('binds health ratio to a native progress element and cleans descendant bindings', () => {
        const container = mount();
        const view = new KnockoutCombatRenderer(container, 'views', labels);
        const value = container.querySelector('[data-combat-field="health"]');
        const cleaned = vi.fn();
        ko.utils.domNodeDisposal.addDisposeCallback(value, cleaned);
        const data = snapshot();
        data.encounter.enemy.health = 15;
        view.render(data);
        expect(container.querySelector('progress').value).toBe(0.5);
        expect(container.querySelector('progress').max).toBe(1);
        expect(container.querySelector('progress').getAttribute('aria-label')).toBe(labels.health);
        view.dispose();
        expect(cleaned).toHaveBeenCalledTimes(1);
        expect(ko.contextFor(value)).toBeUndefined();
    });

    it('cleans a fully bound private subtree if mounting fails', () => {
        const container = mount();
        let root;
        const cleaned = vi.fn();
        vi.spyOn(container, 'appendChild').mockImplementation(node => {
            root = node;
            ko.utils.domNodeDisposal.addDisposeCallback(root, cleaned);
            throw new Error('Mount failed');
        });
        expect(() => new KnockoutCombatRenderer(container, 'views', labels)).toThrow('Mount failed');
        expect(root.parentNode).toBe(null);
        expect(cleaned).toHaveBeenCalledTimes(1);
        expect(ko.contextFor(root.querySelector('[data-combat-field]'))).toBeUndefined();
    });
});

class ManualScheduler {
    tasks = [];
    schedule(callback) {
        const task = { callback, canceled: false, called: false };
        this.tasks.push(task);
        return () => { task.canceled = true; };
    }
    request(callback) { return this.schedule(callback); }
    fire() {
        const task = this.tasks.find(item => !item.called && !item.canceled);
        if (!task) throw new Error('Missing test callback');
        task.called = true; task.callback();
    }
}

function runWithPresentations(first, replacement, framesPerWake = 1) {
    const timer = new ManualScheduler(), frames = new ManualScheduler();
    const container = mount();
    let time = 1000, host;
    const events = [], outcomes = [];
    host = new DirectCombatHost({ sessionId: 'views', configuration: { combat, simulation }, scenario, seed: 123,
        now: () => time, scheduler: timer, onOutputAvailable: () => {
            while (host.pendingOutput) {
                const output = host.pendingOutput;
                events.push(...output.events); outcomes.push(...output.commands);
                host.acknowledge(output.snapshot.sequence);
            }
        } });
    [50, 100, 150].forEach((atMs, index) => host.submit({ protocolVersion: 1, sessionId: 'views', sequence: index + 1, atMs, type: 'ClickAttack' }));
    host.submit({ protocolVersion: 1, sessionId: 'views', sequence: 4, atMs: 200, type: 'ChangeRoute', destination: { region: 0, route: 2 } });
    let display = first ? new PresentationLoop(host, frames, new first(container, 'views', labels)) : null;
    host.start(); display?.start();
    for (let active = 100; active <= 12000; active += 100) {
        time = 1000 + active; timer.fire();
        if (display) {
            for (let frame = 0; frame < framesPerWake; frame++) frames.fire();
            if (active === 300 && replacement) {
                expect(contents(container)).toMatchObject({ route: '2', status: labels.capturing, capture: '50 ms' });
                const before = host.progress;
                const stale = frames.tasks.find(task => !task.called && !task.canceled);
                display.dispose();
                expect(container.children).toHaveLength(0);
                display = new PresentationLoop(host, frames, new replacement(container, 'views', labels));
                display.start(); stale.callback(); frames.fire();
                expect(contents(container)).toMatchObject({ route: '2', status: labels.capturing, capture: '50 ms' });
                expect(host.progress).toEqual(before);
            }
        }
    }
    const result = { snapshot: host.latest, progress: host.progress, events, outcomes };
    display?.dispose(); host.dispose(); container.remove();
    return result;
}

describe('interchangeable presentations of one real engine', () => {
    it.each([[DomCombatRenderer, KnockoutCombatRenderer, 1], [KnockoutCombatRenderer, DomCombatRenderer, 3]])(
        'replaces a renderer during capture without changing outcomes', (first, replacement, framesPerWake) => {
            expect(runWithPresentations(first, replacement, framesPerWake)).toEqual(runWithPresentations(null, null));
        },
    );

    it('keeps presentation projections detached and preserves fractional Pokemon IDs', () => {
        const model = new CombatViewModel('views', labels);
        const input = snapshot();
        input.encounter.enemy.pokemonId = 19.01;
        const projected = model.update(input);
        input.encounter.enemy.health = 0;
        expect(projected.text.opponent).toBe('19.01');
        expect(projected.text.health).toBe('30 / 30');
        expect(Object.isFrozen(projected.text)).toBe(true);
        expect(Object.isFrozen(model.labels)).toBe(true);
    });
});
