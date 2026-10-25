import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import ts from 'typescript';
import { calculateClickDamage, calculatePartyDamage } from '../../src/simulation/damage/resolveDamage';
import snapshot from '../fixtures/simulation/damage-snapshot.json';
const source = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/scripts/party/Party.ts'), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None } }).outputText;

function legacy(input, typeMultiplier, regionMultiplier) {
    const context = {
        player: { region: 1, subregion: 0 }, PokemonType: { None: -1 },
        GameConstants: { Region: { none: -1, alola: 7 }, AlolaSubRegions: { MagikarpJump: 1 }, FLUTE_TYPE_ATTACK_MULTIPLIER: 1.5 },
        PokemonHelper: { calcNativeRegion: () => 0, getPokemonByName: () => ({ type1: 1, type2: 2 }) },
        TypeHelper: { getAttackModifier: () => typeMultiplier },
        App: { game: { challenges: { list: { regionalAttackDebuff: { active: () => true } } }, zMoves: { getMultiplier: () => 1.2 } } },
        Weather: { currentWeather: () => 0, weatherConditions: [{ multipliers: [{ type: 1, multiplier: 1.1 }, { type: 2, multiplier: 1.3 }] }] },
        FluteEffectRunner: { activeGemTypes: () => [1, 2] },
    };
    const Party = new Function(...Object.keys(context), `${compiled}\nreturn Party;`)(...Object.values(context));
    const party = Object.create(Party.prototype);
    party.multiplier = { getBonus: () => input.multiplier };
    party.partyPokemonActiveInSubRegion = () => input.contributors.filter(p => p.active).map(p => ({ ...p, name: String(p.pokemonId) }));
    party.getRegionAttackMultiplier = () => regionMultiplier;
    return party;
}

describe('legacy resolved damage parity', () => {
    for (const typeMultiplier of [0, 0.25, 1, 2]) {
        for (const includeTempBonuses of [false, true]) {
            it(`matches real Party methods for type=${typeMultiplier}, temporary bonuses=${includeTempBonuses}`, () => {
                const input = structuredClone(snapshot.opponents[0].party);
                input.multiplier = 1.1; input.includeTempBonuses = includeTempBonuses;
                const template = input.contributors[0];
                input.contributors = [0.1, 1, 11, 25].map((attack, i) => ({ ...template, pokemonId: i + 1, attack, typeMultiplier, regionMultiplier: 0.2,
                    breeding: i === 2, active: i !== 3, weatherMultipliers: [1.1, 1.3], fluteMultipliers: [1.5, 1.5], zMoveMultiplier: 1.2 }));
                const party = legacy(input, typeMultiplier, 0.2);
                expect(calculatePartyDamage(input)).toBe(party.calculatePokemonAttack(1, 2, false, 1, false, false, undefined, false, includeTempBonuses, 0));
                input.contributors.forEach(p => { p.includeBreeding = true; });
                expect(calculatePartyDamage(input)).toBe(party.calculatePokemonAttack(1, 2, false, 1, true, false, undefined, false, includeTempBonuses, 0));
            });
        }
    }
    it('matches real click rounding for fractional base values and bonuses', () => {
        for (const baseAttack of [0, 1, 10.9, 123.456]) {
            for (const multiplier of [0, 0.25, 1, 1.5, 10]) {
                const party = legacy({ contributors: [], multiplier }, 1, 1);
                party.calculateBaseClickAttack = () => baseAttack;
                expect(calculateClickDamage({ baseAttack, multiplier })).toBe(party.calculateClickAttack(false));
            }
        }
    });
});
