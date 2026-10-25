import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import ts from 'typescript';
import { compileRouteScenario } from '../../src/simulation/content/compileRouteScenario';
import { calculateRouteHealth, parseRouteHealthPolicy } from '../../src/simulation/content/routeHealth';
import content from '../fixtures/simulation/route-content.json';
import policy from '../../public/config/route-health.json';

const source = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/scripts/pokemons/PokemonFactory.ts'), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None } }).outputText;
function factory(route, chosen) {
    const pokemon = { land: route.pools.land, water: route.pools.water, headbutt: route.pools.headbutt,
        special: route.pools.special.map(group => ({ pokemon: group.pokemonIds })) };
    const catalog = new Map(route.catalog.map(p => [p.pokemonId, p]));
    const context = {
        MapHelper: { validRoute: () => true, normalizeRoute: () => route.normalizedRoute },
        Routes: { regionRoutes: [{ region: route.location.region, number: route.location.route, routeHealth: route.healthOverride }], getRoute: () => ({ pokemon }) },
        PokemonHelper: { getPokemonByName: name => ({ id: name, hitpoints: catalog.get(name).baseHealth, gender: {} }) },
        pokemonMap: Object.fromEntries(route.catalog.map(p => [p.pokemonId, { base: { hitpoints: p.baseHealth } }])),
        RouteHelper: { getAvailablePokemonList: () => [chosen], getAvailablePokemonWeightList: () => [1] },
        Rand: { fromWeightedArray: () => chosen },
        GameConstants: { Currency: { money: 0 }, ShadowStatus: { None: 0 }, BASE_EP_YIELD: 1 },
        EncounterType: { route: 0 }, Amount: class {},
        BattlePokemon: class { constructor(_name, _id, _t1, _t2, health) { this.health = health; } },
    };
    const result = new Function(...Object.keys(context), `${compiled}\nreturn PokemonFactory;`)(...Object.values(context));
    result.generateRoamingEncounter = () => undefined;
    result.catchRateHelper = () => 0; result.routeMoney = () => 0;
    result.generateShiny = () => false; result.generateHeldItem = () => null; result.generateGender = () => 0;
    return result;
}

describe('legacy route health parity', () => {
    it.each([0, 1, 4, 8])('matches real routeHealth across normalized routes in region %i', region => {
        for (const normalizedRoute of [1, 2, 10, 50, 100, 250]) {
            const route = { ...content.routes[0], location: { region, route: 1 }, normalizedRoute, healthOverride: null };
            expect(calculateRouteHealth(normalizedRoute, region, null, parseRouteHealthPolicy(policy))).toBe(factory(route, 16).routeHealth(1, region));
        }
    });
    it.each([null, 30, 10000])('matches generated enemy health with override %s, duplicate and unavailable species', override => {
        const input = structuredClone(content); input.routes[0].healthOverride = override;
        input.routes[0].pools.water.push(16); input.routes[0].pools.headbutt.push(16.01);
        const scenario = compileRouteScenario(input, policy);
        for (const opponent of scenario.routes[0].opponents) {
            const legacy = factory(input.routes[0], opponent.pokemonId);
            expect(opponent.health).toBe(legacy.generateWildPokemon(1, 0, 0).health);
        }
    });
});
