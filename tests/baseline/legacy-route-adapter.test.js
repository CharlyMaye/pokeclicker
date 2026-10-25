import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import Routes from '../../src/modules/routes/Routes';
import '../../src/modules/routes/RouteData';
import { pokemonList } from '../../src/modules/pokemons/PokemonList';
import { captureRouteCatalog } from '../../src/runtime/legacy/captureRouteCatalog';
import { prepareLegacyRouteSession } from '../../src/runtime/legacy/prepareLegacyRouteSession';
import healthPolicy from '../../public/config/route-health.json';
import encounterPolicy from '../../public/config/encounter-rules.json';
const locations = Routes.regionRoutes.map(r => ({ region: r.region, route: r.number }));
const captured = () => captureRouteCatalog(Routes.regionRoutes, pokemonList, locations);
function legacyClass(relative, className, context) {
    const source = readFileSync(new URL(relative, import.meta.url), 'utf8');
    const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None } }).outputText;
    return new Function(...Object.keys(context), `${compiled}\nreturn ${className};`)(...Object.values(context));
}
function session(routes, waterUnlocked, includeHeadbutt) {
    return { formatVersion: 1, initialLocation: routes[0].location, ordinaryWeight: 1, clickAttackDamage: 10, clickAttacksAllowed: true, initialPokeballs: 2,
        routes: routes.map(route => ({ location: route.location, unlocked: true, access: { waterUnlocked, includeHeadbutt },
            specialAvailability: route.pools.special.map((_g, i) => i % 2 === 0),
            opponents: route.catalog.map(p => ({ pokemonId: p.pokemonId, autoAttackDamage: 10, experienceReward: 12,
                pokeballBonus: 5, oakBonus: 2, captureDurationMs: 200, moneyMultiplier: 1.5, tokenMultiplier: 1.25 })),
        })),
    };
}
describe('production route registry and catalog adapter', () => {
    it('matches Routes.normalizedNumber for the entire shipped registry, including ignored routes', () => {
        const routes = captured(); expect(routes.length).toBeGreaterThan(100);
        expect(Routes.regionRoutes.some(r => r.ignoreRouteInCalculations)).toBe(true);
        routes.forEach(route => expect(route.normalizedRoute).toBe(Routes.normalizedNumber(route.location.region, route.location.route)));
    });
    it('maps all shipped pool names and regional forms to actual catalog IDs, HP and catch rates', () => {
        const catalog = new Map(pokemonList.map(p => [p.name, p]));
        const routes = captured(); let fractional = false;
        routes.forEach((route, i) => {
            const pools = Routes.regionRoutes[i].pokemon;
            const names = [...new Set([...pools.land, ...pools.water, ...pools.headbutt, ...pools.special.flatMap(p => p.pokemon)])];
            expect(route.catalog).toEqual(names.map(name => {
                const p = catalog.get(name); fractional ||= !Number.isInteger(p.id);
                return { pokemonId: p.id, baseHealth: p.base.hitpoints, baseCatchRate: p.catchRate };
            }));
            expect(route.healthOverride).toBe(Routes.regionRoutes[i].routeHealth ?? null);
        });
        expect(fractional).toBe(true);
    });
    it.each([[false, false], [false, true], [true, false], [true, true]])('matches actual RouteHelper selection with water=%s, headbutt=%s', (waterUnlocked, includeHeadbutt) => {
        const routes = captured();
        const input = session(routes, waterUnlocked, includeHeadbutt);
        // Capture explicit requirement results without executing live requirements.
        const native = Routes.regionRoutes.map((route, i) => ({ ...route, pokemon: { ...route.pokemon,
            special: route.pokemon.special.map((group, j) => ({ ...group, isAvailable: () => input.routes[i].specialAvailability[j] })),
        } }));
        const helper = legacyClass('../../src/scripts/wildBattle/RouteHelper.ts', 'RouteHelper', {
            Routes: { getRoute: (region, number) => native.find(r => r.region === region && r.number === number) },
            App: { game: { keyItems: { hasKeyItem: () => waterUnlocked } } }, KeyItemType: { Super_rod: 1 },
        });
        const names = new Map(pokemonList.map(p => [p.name, p.id]));
        // A route containing only unavailable special groups is intentionally invalid for combat.
        const eligible = input.routes.filter(route => helper.getAvailablePokemonList(route.location.route, route.location.region, includeHeadbutt).length > 0);
        const scenario = prepareLegacyRouteSession({ registry: Routes.regionRoutes, pokemonList, healthPolicy, encounterPolicy, session: { ...input, initialLocation: eligible[0].location, routes: eligible } });
        scenario.routes.forEach(route => {
            expect(route.encounters.map(e => e.pokemonId)).toEqual(helper.getAvailablePokemonList(route.location.route, route.location.region, includeHeadbutt).map(name => names.get(name)));
            expect(route.encounters.map(e => e.weight)).toEqual(helper.getAvailablePokemonWeightList(route.location.route, route.location.region, includeHeadbutt));
        });
    });
    it('matches actual factory routeHealth for every shipped route and override', () => {
        const factory = legacyClass('../../src/scripts/pokemons/PokemonFactory.ts', 'PokemonFactory', {
            Routes, MapHelper: { normalizeRoute: (route, region) => Routes.normalizedNumber(region, route) },
        });
        const routes = captured(), input = session(routes, true, true);
        input.routes.forEach(route => { route.specialAvailability.fill(true); });
        const scenario = prepareLegacyRouteSession({ registry: Routes.regionRoutes, pokemonList, healthPolicy, encounterPolicy, session: input });
        scenario.routes.forEach((route, i) => {
            const catalog = routes[i].catalog;
            const average = catalog.reduce((sum, p) => sum + p.baseHealth, 0) / catalog.length;
            const health = factory.routeHealth(route.location.route, route.location.region);
            route.opponents.forEach(p => expect(p.health).toBe(Math.round(health * (0.9 + catalog.find(c => c.pokemonId === p.pokemonId).baseHealth / average / 10))));
        });
    });
});
