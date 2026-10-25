import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import ts from 'typescript';
import SeededRand from '../../src/modules/utilities/SeededRand';
import { resolveRouteEncounterPools, selectOpponent } from '../../src/simulation/combat/encounters';
import { validateScenario } from '../../src/simulation/combat/validation';
import pools from '../fixtures/simulation/encounter-pools.json';
import scenario from '../fixtures/simulation/weighted-encounters.json';

const compiled = ts.transpileModule(readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/scripts/wildBattle/RouteHelper.ts'), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None },
}).outputText;

function legacyPools(input, waterUnlocked) {
    const pokemon = { ...input, special: input.special.map(group => ({ pokemon: group.pokemonIds, weight: group.weight, isAvailable: () => group.available })) };
    return new Function('Routes', 'App', 'KeyItemType', `${compiled}\nreturn RouteHelper;`)(
        { getRoute: () => ({ pokemon }) }, { game: { keyItems: { hasKeyItem: () => waterUnlocked } } }, { Super_rod: 1 },
    );
}

class ControlledRandom extends SeededRand {
    static value = 0;
    static next() { return this.value; }
}

describe('legacy weighted encounter parity', () => {
    for (const waterUnlocked of [false, true]) {
        for (const includeHeadbutt of [false, true]) {
            for (const noLand of [false, true]) {
                it(`matches RouteHelper with water=${waterUnlocked}, headbutt=${includeHeadbutt}, noLand=${noLand}`, () => {
                    const input = { ...pools, land: noLand ? [] : pools.land };
                    const legacy = legacyPools(input, waterUnlocked);
                    const resolved = resolveRouteEncounterPools(input, { waterUnlocked, includeHeadbutt });
                    expect(resolved.map(entry => entry.pokemonId)).toEqual(legacy.getAvailablePokemonList(1, 0, includeHeadbutt));
                    expect(resolved.map(entry => entry.weight)).toEqual(legacy.getAvailablePokemonWeightList(1, 0, includeHeadbutt));
                });
            }
        }
    }

    it('matches real weighted selection at exact boundaries and across a deterministic draw grid', () => {
        for (const weights of [[1, 2.5, 0.5], [0, 1, 0], [0.1, 0.2, 0.3]]) {
            const input = structuredClone(scenario);
            input.routes[0].encounters.forEach((entry, index) => { entry.weight = weights[index]; });
            const route = validateScenario(input).routes[0];
            const total = weights.reduce((a, b) => a + b, 0);
            const boundaries = weights.map((_w, i) => weights.slice(0, i + 1).reduce((a, b) => a + b, 0) / total);
            const draws = [0, ...boundaries.flatMap(b => [b - Number.EPSILON, b, b + Number.EPSILON]), ...Array.from({ length: 1001 }, (_, i) => i / 1001)];
            for (const draw of draws.filter(value => value >= 0 && value < 1)) {
                ControlledRandom.value = draw;
                const expected = ControlledRandom.fromWeightedArray(route.encounters.map(entry => entry.pokemonId), weights);
                expect(selectOpponent(route, draw).pokemonId).toBe(expected);
            }
        }
    });
});
