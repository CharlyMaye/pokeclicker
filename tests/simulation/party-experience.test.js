import { describe, expect, it, vi } from 'vitest';
import { advancePartyExperience, createPartyState, parsePartyDefinition, parsePartySnapshot, projectPartyState } from '../../src/simulation/experience/partyExperience';
import { parseLevelCurves } from '../../src/simulation/experience/levelCurves';
import { withPartyExperience } from '../../src/simulation/experience/withPartyExperience';
import { RouteCombatSimulation } from '../../src/simulation/combat/RouteCombatSimulation';
import { parseCombatCheckpoint } from '../../src/simulation/combat/checkpoint';
import createScenario from '../fixtures/runtime/party-scenario.cjs';
import combat from '../../public/config/combat.json';
import simulation from '../../public/config/simulation.json';
const definitionInput = () => ({ levelCurves: { schemaVersion: 1, curves: [{ id: 'test', thresholds: [0, 10, 30, 60, Number.MAX_SAFE_INTEGER] }] }, members: [
    { pokemonId: 1, curveId: 'test', experience: 8, level: 1, maxLevel: 3, multiplier: 1.5, shadow: false },
    { pokemonId: 2, curveId: 'test', experience: 30, level: 3, maxLevel: 3, multiplier: 2, shadow: true },
] });
const game = (scenario = createScenario(), checkpoint, random) => new RouteCombatSimulation('party', { combat, simulation }, scenario, 123, random, checkpoint);
const click = (sequence, atMs) => ({ protocolVersion: 1, sessionId: 'party', sequence, atMs, type: 'ClickAttack' });
function prepared() {
    const g = game(); [50, 100, 150].forEach((t, i) => g.submit(click(i + 1, t)));
    g.submit({ ...click(4, 200), type: 'ChangeRoute', destination: { region: 0, route: 2 } }); return g;
}
describe('party experience components', () => {
    it('applies ordered grants, preserves overshoot, and stops storing after reaching the cap', () => {
        const definition = parsePartyDefinition(definitionInput()), initial = createPartyState(definition);
        const first = advancePartyExperience(definition, initial, 10), second = advancePartyExperience(definition, first, 10), third = advancePartyExperience(definition, second, 10);
        expect(first.members.get(1)).toEqual({ pokemonId: 1, experience: 23, level: 2 });
        expect(second.members.get(1)).toEqual({ pokemonId: 1, experience: 38, level: 3 });
        expect(third.members.get(1)).toEqual(second.members.get(1)); expect(third.shadowExperience).toBe(60); expect(third.grants).toBe(3);
        expect(initial.members.get(1).experience).toBe(8);
        expect(advancePartyExperience(definition, initial, 30).members.get(1).experience).toBe(53);
    });
    it('promotes exactly at a threshold and preserves fractional experience', () => {
        const input = definitionInput(); input.members[0].experience = 8.5; input.members[0].multiplier = 0.5;
        const definition = parsePartyDefinition(input), initial = createPartyState(definition);
        expect(advancePartyExperience(definition, initial, 2).members.get(1)).toEqual({ pokemonId: 1, experience: 9.5, level: 1 });
        expect(advancePartyExperience(definition, initial, 3).members.get(1)).toEqual({ pokemonId: 1, experience: 10, level: 2 });
    });
    it('supports empty parties, zero bonuses and members above a lowered cap', () => {
        const input = definitionInput(); input.members[0].multiplier = 0; input.members[1].maxLevel = 2;
        const d = parsePartyDefinition(input), state = advancePartyExperience(d, createPartyState(d), 10);
        expect(state.members.get(1).experience).toBe(8); expect(state.members.get(2).level).toBe(3);
        expect(parsePartySnapshot(projectPartyState(state), d, 1).grants).toBe(1);
        const empty = parsePartyDefinition({ ...input, members: [] });
        expect(projectPartyState(advancePartyExperience(empty, createPartyState(empty), 10))).toEqual({ grants: 1, shadowExperience: 0, members: [] });
    });
    it.each([
        ['duplicate member', d => { d.members.push(d.members[0]); }], ['unknown curve', d => { d.members[0].curveId = 'missing'; }],
        ['inconsistent level', d => { d.members[0].level = 2; }], ['uncapped excessive experience', d => { d.members[0].experience = 12; }],
        ['unsupported cap', d => { d.members[0].maxLevel = 5; }], ['sentinel experience', d => { d.members[0].experience = Number.MAX_SAFE_INTEGER; }],
        ['negative bonus', d => { d.members[0].multiplier = -1; }], ['missing shadow', d => { delete d.members[0].shadow; }],
    ])('rejects %s', (_label, mutate) => { const d = definitionInput(); mutate(d); expect(() => parsePartyDefinition(d)).toThrow(); });
    it.each([
        ['empty curves', p => { p.curves = []; }], ['duplicate curve', p => { p.curves.push(p.curves[0]); }],
        ['unordered thresholds', p => { p.curves[0].thresholds[2] = 5; }], ['missing sentinel', p => { p.curves[0].thresholds.pop(); }],
        ['wrong origin', p => { p.curves[0].thresholds[0] = 1; }], ['fractional threshold', p => { p.curves[0].thresholds[1] = 1.5; }],
    ])('rejects %s', (_label, mutate) => { const p = definitionInput().levelCurves; mutate(p); expect(() => parseLevelCurves(p)).toThrow(); });
    it('rejects member accessors without executing them and returns immutable snapshots', () => {
        const input = definitionInput(), get = vi.fn(() => 1); Object.defineProperty(input.members[0], 'experience', { get });
        expect(() => parsePartyDefinition(input)).toThrow(); expect(get).not.toHaveBeenCalled();
        const d = parsePartyDefinition(definitionInput()), snapshot = projectPartyState(createPartyState(d));
        expect(Object.isFrozen(d.members[0])).toBe(true); expect(Object.isFrozen(snapshot.members[0])).toBe(true);
    });
});
describe('transactional combat party progression', () => {
    it('commits exactly one party grant with a defeat before a pending capture', () => {
        const g = prepared(); g.advanceTo(300); const saved = g.checkpoint();
        expect(saved.formatVersion).toBe(3); expect(saved.sourceLocation.route).toBe(1); expect(saved.snapshot.location.route).toBe(2);
        expect(saved.party.grants).toBe(1); expect(saved.party).toEqual(g.partyExperience);
        expect(saved.party.members[0]).toEqual({ pokemonId: 1, experience: 319.5, level: 3 });
        expect(saved.party.members[1].experience).toBe(800000); expect(saved.party.shadowExperience).toBe(372.75);
    });
    it.each([0, 100, 200, 300, 500, 3000])('replays identically from a party checkpoint at %i ms', time => {
        const first = prepared(); first.advanceTo(time); const saved = JSON.parse(JSON.stringify(first.checkpoint())), second = game(saved.scenario, saved);
        for (let t = time + 100; t <= time + 15000; t += 100) {
            expect(second.advanceTo(t)).toEqual(first.advanceTo(t)); expect(second.partyExperience).toEqual(first.partyExperience);
        }
        expect(second.checkpoint()).toEqual(first.checkpoint());
    });
    it('preserves per-defeat cap behavior when many steps are advanced in one call', () => {
        const batched = prepared(), incremental = prepared();
        batched.advanceTo(10000);
        for (let time = 100; time <= 10000; time += 100) incremental.advanceTo(time);
        expect(batched.partyExperience.grants).toBeGreaterThan(1);
        expect(batched.checkpoint()).toEqual(incremental.checkpoint());
    });
    it('rolls back party grants, rewards and RNG if a later spawn fails in the same advance', () => {
        const input = structuredClone(createScenario()); input.initialPokeballs = 0; input.clickAttackDamage = 100;
        let calls = 0; const g = game(input, undefined, state => ({ state: state + 1, value: ++calls === 6 ? NaN : 0.5 }));
        const before = g.partyExperience, progress = g.progress, state = g.randomState; g.submit(click(1, 50));
        expect(() => g.advanceTo(100)).toThrow('Simulation stopped');
        expect(g.partyExperience).toEqual(before); expect(g.progress).toEqual(progress); expect(g.randomState).toBe(state);
    });
    it('rolls back the full combat call on party overflow', () => {
        const input = structuredClone(createScenario()); input.party.members[0].multiplier = Number.MAX_SAFE_INTEGER;
        input.clickAttackDamage = 100; const g = game(input); const before = g.partyExperience, progress = g.progress;
        g.submit(click(1, 50)); expect(() => g.advanceTo(100)).toThrow('Simulation stopped');
        expect(g.partyExperience).toEqual(before); expect(g.progress).toEqual(progress);
    });
    it('leaves version 3 scenarios and checkpoint version 2 unchanged', () => {
        const { party, ...scenario } = createScenario(); scenario.formatVersion = 3;
        const g = game(scenario); expect(g.partyExperience).toBe(null); expect(g.checkpoint().formatVersion).toBe(2);
        expect(Object.hasOwn(g.checkpoint(), 'party')).toBe(false);
        expect(() => withPartyExperience(createScenario(), party)).toThrow();
    });
    it.each([
        ['missing party', c => { delete c.party; }], ['wrong version', c => { c.formatVersion = 2; }],
        ['grant mismatch', c => { c.party.grants++; }], ['missing member', c => { c.party.members.pop(); }],
        ['duplicate member', c => { c.party.members[1] = c.party.members[0]; }], ['negative experience', c => { c.party.members[0].experience = -1; }],
        ['regressed level', c => { c.party.members[1].level = 99; }], ['capped member changed', c => { c.party.members[1].experience++; }],
        ['unearned shadow experience', c => { c.party.shadowExperience = 1; }],
    ])('rejects checkpoint %s', (_label, mutate) => { const saved = JSON.parse(JSON.stringify(game().checkpoint())); mutate(saved); expect(() => parseCombatCheckpoint(saved)).toThrow(); });
    it('rejects a changed party or curve without migration', () => {
        const input = structuredClone(createScenario()), saved = game(input).checkpoint();
        input.party.members[0].multiplier = 2;
        expect(() => game(input, saved)).toThrow('scenario');
    });
});
