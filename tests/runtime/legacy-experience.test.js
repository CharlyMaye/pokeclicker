import { describe, expect, it, vi } from 'vitest';
import createInput from '../fixtures/runtime/experience-route-source.cjs';
import { prepareLegacyExperienceSession } from '../../src/runtime/legacy/prepareLegacyExperienceSession';
import { prepareLegacyRouteSession } from '../../src/runtime/legacy/prepareLegacyRouteSession';
import { RouteCombatSimulation } from '../../src/simulation/combat/RouteCombatSimulation';
import combat from '../../public/config/combat.json';
import simulation from '../../public/config/simulation.json';
const game = (scenario, checkpoint) => new RouteCombatSimulation('exp', { combat, simulation }, scenario, 123, undefined, checkpoint);
describe('derived legacy route experience', () => {
    it('replaces manual rewards with catalog yield, global normalized route level and explicit bonus', () => {
        const input = createInput(), scenario = prepareLegacyExperienceSession(input);
        expect(scenario.routes[0].opponents[0].experienceReward).toBe(213);
        expect(scenario.routes.at(-1).opponents[0].experienceReward).toBe(426); // Normalized route 5 gives level 40.
        expect(scenario.formatVersion).toBe(3);
        expect(() => prepareLegacyRouteSession(input)).toThrow();
    });
    it('credits each defeat once and restores its prepared rewards without catalog access', () => {
        const input = createInput(); input.session.initialPokeballs = 0;
        const scenario = prepareLegacyExperienceSession(input), first = game(scenario);
        [50, 100, 150].forEach((atMs, i) => first.submit({ protocolVersion: 1, sessionId: 'exp', sequence: i + 1, atMs, type: 'ClickAttack' }));
        first.advanceTo(200); expect(first.progress.experience).toBe(213); expect(first.progress.defeats).toBe(1);
        const saved = JSON.parse(JSON.stringify(first.checkpoint())); input.pokemonList.length = 0;
        const restored = game(saved.scenario, saved);
        for (let time = 300; time <= 15000; time += 100) expect(restored.advanceTo(time)).toEqual(first.advanceTo(time));
        expect(restored.checkpoint()).toEqual(first.checkpoint());
    });
    it('requires migration when effective prepared rewards change', () => {
        const input = createInput(), first = game(prepareLegacyExperienceSession(input));
        input.session.routes[0].opponents[0].experienceMultiplier = 2;
        expect(() => game(prepareLegacyExperienceSession(input), first.checkpoint())).toThrow('scenario');
    });
    it.each([
        ['old input version', p => { p.session.formatVersion = 1; }],
        ['manual experience reward', p => { p.session.routes[0].opponents[0].experienceReward = 5; }],
        ['missing bonus', p => { delete p.session.routes[0].opponents[0].experienceMultiplier; }],
        ['missing yield', p => { delete p.pokemonList[0].exp; }],
        ['invalid unavailable yield', p => { p.pokemonList[2].exp = NaN; }],
        ['invalid locked bonus', p => { p.session.routes[3].opponents[2].experienceMultiplier = -1; }],
        ['missing unavailable profile', p => { p.session.routes[0].opponents.pop(); }],
    ])('rejects %s', (_name, mutate) => { const input = createInput(); mutate(input); expect(() => prepareLegacyExperienceSession(input)).toThrow(); });
    it('rejects catalog yield accessors without evaluating them', () => {
        const input = createInput(), get = vi.fn(() => 64); Object.defineProperty(input.pokemonList[0], 'exp', { get });
        expect(() => prepareLegacyExperienceSession(input)).toThrow(); expect(get).not.toHaveBeenCalled();
    });
});
