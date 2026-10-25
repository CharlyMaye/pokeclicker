import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import ts from 'typescript';
import * as ko from 'knockout';
import * as GameConstants from '../../src/modules/GameConstants';
import Battle from '../../src/modules/battles/Battle';
import Wallet from '../../src/modules/wallet/Wallet';
import { calculateEncounterRules, parseEncounterRulesPolicy } from '../../src/simulation/content/encounterRules';
import policyInput from '../../public/config/encounter-rules.json';
import snapshot from '../fixtures/simulation/encounter-snapshot.json';
vi.mock('../../src/modules/utilities/UI', () => ({ animateCurrency: () => {} }));
const source = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/scripts/pokemons/PokemonFactory.ts'), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None } }).outputText;
const policy = parseEncounterRulesPolicy(policyInput);
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function legacy(input) {
    const factory = new Function('MapHelper', 'Rand', 'GameConstants', `${compiled}\nreturn PokemonFactory;`)(
        { normalizeRoute: () => input.normalizedRoute }, { intBetween: min => min === -3 ? input.catchVariation : input.moneyDeviation }, GameConstants,
    );
    const wallet = new Wallet({ getBonus: kind => kind === 'money' ? input.moneyMultiplier : input.tokenMultiplier });
    vi.stubGlobal('PokemonFactory', factory);
    vi.stubGlobal('App', { game: { wallet, statistics: { totalMoney: ko.observable(0), totalDungeonTokens: ko.observable(0) },
        pokeballs: { getCatchBonus: () => input.pokeballBonus }, oakItems: { calculateBonus: () => input.oakBonus } } });
    return { factory, wallet };
}

describe('legacy encounter reward and capture parity', () => {
    it.each([0, 1, 4, 8])('matches actual factory, wallet and normal token award in region %i', region => {
        for (const normalizedRoute of [1, 2, 10, 50, 100]) {
            for (const moneyDeviation of [-25, 0, 25]) {
                const input = { ...snapshot.opponents[0].inputs, normalizedRoute, moneyDeviation };
                const { factory, wallet } = legacy(input);
                const result = calculateEncounterRules(input, region, policy);
                expect(result.moneyReward).toBe(wallet.gainMoney(factory.routeMoney(1, region)).amount);
                expect(result.dungeonTokenReward).toBe(Battle.gainTokens(1, region, GameConstants.Pokeball.Pokeball).amount);
            }
        }
    });
    it.each([0, 1, 100, 255, 10000])('matches both catch-rate clamp stages for base rate %i', baseCatchRate => {
        for (const catchVariation of [-3, 0, 3]) {
            for (const pokeballBonus of [-5, 0, 5.5, 100]) {
                const input = { ...snapshot.opponents[0].inputs, baseCatchRate, catchVariation, pokeballBonus };
                const { factory } = legacy(input);
                const expected = Battle.calculateActualCatchRate({ catchRate: factory.catchRateHelper(baseCatchRate) }, GameConstants.Pokeball.Pokeball) / 100;
                expect(calculateEncounterRules(input, 0, policy).captureProbability).toBe(expected);
            }
        }
    });
});
