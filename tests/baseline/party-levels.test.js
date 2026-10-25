import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import LevelType, { levelRequirements } from '../../src/modules/party/LevelType';
import { advancePartyExperience, createPartyState, parsePartyDefinition } from '../../src/simulation/experience/partyExperience';
import { parseLevelCurves } from '../../src/simulation/experience/levelCurves';
import policy from '../../public/config/level-curves.json';
const compiled = ts.transpileModule(readFileSync(new URL('../../src/scripts/party/PartyPokemon.ts', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None } }).outputText;
class Bonus { constructor(value) { this.gainedBonus = value; } }
function legacy(member, type) {
    const evolutions = [];
    const context = { App: { game: { badgeCase: { maxLevel: () => member.maxLevel } } }, levelRequirements,
        PokemonHelper: { getPokemonByName: () => ({ levelType: type }) }, ExpGainedBonusHeldItem: Bonus };
    const Pokemon = new Function(...Object.keys(context), `${compiled}\nreturn PartyPokemon;`)(...Object.values(context));
    const pokemon = Object.defineProperty(Object.create(Pokemon.prototype), 'level', { value: member.level, writable: true });
    Object.assign(pokemon, { name: 'fixture', exp: member.experience, heldItem: () => new Bonus(member.multiplier), checkForLevelEvolution: () => evolutions.push(pokemon.level) });
    return { pokemon, evolutions };
}
describe('legacy party level and cap parity', () => {
    it('publishes exactly the six historical threshold tables, including their sentinel', () => {
        const parsed = parseLevelCurves(policy);
        expect(parsed.curves).toEqual(levelRequirements.map((thresholds, index) => ({ id: LevelType[index], thresholds })));
    });
    it.each(policy.curves.map((curve, index) => [curve.id, index]))('matches actual exact-threshold promotions for %s', (curveId, type) => {
        const curve = levelRequirements[type];
        for (let level = 1; level < curve.length - 1; level++) {
            const member = { pokemonId: 1, curveId, experience: curve[level] - 0.5, level, maxLevel: 100, multiplier: 0.5, shadow: false };
            const definition = parsePartyDefinition({ levelCurves: policy, members: [member] }), original = legacy(member, type);
            original.pokemon.gainExp(1);
            const next = advancePartyExperience(definition, createPartyState(definition), 1).members.get(1);
            expect(next.experience).toBe(original.pokemon.exp); expect(next.level).toBe(original.pokemon.level);
            expect(original.evolutions).toEqual([level + 1]);
        }
    });
    it.each(policy.curves.map((curve, index) => [curve.id, index]))('matches repeated fractional grants and caps for %s', (curveId, type) => {
        for (const maxLevel of [2, 3, 50, 100]) {
            const member = { pokemonId: 1, curveId, experience: 0, level: 1, maxLevel, multiplier: 1.25, shadow: true };
            const definition = parsePartyDefinition({ levelCurves: policy, members: [member] }), original = legacy(member, type);
            let state = createPartyState(definition), shadow = 0;
            for (const reward of [0, 1, 3, 10, 100, 10000, 1000000, 500, 1]) {
                shadow += original.pokemon.gainExp(reward); state = advancePartyExperience(definition, state, reward);
                expect(state.members.get(1)).toEqual({ pokemonId: 1, level: original.pokemon.level, experience: original.pokemon.exp });
                expect(state.shadowExperience).toBe(shadow);
            }
        }
    });
});
