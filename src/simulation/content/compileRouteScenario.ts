import { parseRouteEncounterPools, resolveRouteEncounterPools } from '../combat/encounters';
import { catalogId, dataArray, dataObject, safeInteger } from '../combat/input';
import { CombatScenario, SimulationInputError, WeightedCombatRoute } from '../combat/model';
import { validateLocation, validateOpponent, validateScenario } from '../combat/validation';
import { calculateOpponentHealth, calculateRouteHealth, parseRouteHealthPolicy, RouteHealthPolicy } from './routeHealth';

function compileRoute(value: unknown, policy: RouteHealthPolicy): WeightedCombatRoute {
    const data = dataObject(value, ['location', 'normalizedRoute', 'healthOverride', 'unlocked', 'pools', 'access', 'catalog'], 'route content');
    const location = validateLocation(data.location);
    const pools = parseRouteEncounterPools(data.pools);
    const encounters = resolveRouteEncounterPools(pools, data.access);
    const catalog = Array.from(dataArray(data.catalog, 'route catalog'), input => {
        const entry = dataObject(input, ['pokemonId', 'baseHealth', 'combat'], 'catalog entry');
        const combat = dataObject(entry.combat, ['autoAttackDamage', 'moneyReward', 'experienceReward', 'dungeonTokenReward', 'captureProbability', 'captureDurationMs'], 'resolved combat stats');
        return { pokemonId: catalogId(entry.pokemonId), baseHealth: safeInteger(entry.baseHealth, 'baseHealth', 1),
            definition: validateOpponent({ ...combat, pokemonId: entry.pokemonId, health: 1 }) };
    });
    const byId = new Map(catalog.map(entry => [entry.pokemonId, entry]));
    const allIds = new Set([...pools.land, ...pools.water, ...pools.headbutt, ...pools.special.flatMap(group => group.pokemonIds)]);
    if (byId.size !== catalog.length || byId.size !== allIds.size || [...allIds].some(id => !byId.has(id))) {
        throw new SimulationInputError('invalid-input', 'Route catalog must contain exactly one definition for every pool species');
    }
    // Use all unique route species in legacy pool order, even when currently unavailable.
    const healthSum = [...allIds].reduce((total, id) => {
        const entry = byId.get(id);
        if (!entry) {
            throw new SimulationInputError('invalid-input', 'Missing route species');
        }
        return safeInteger(total + entry.baseHealth, 'route base health sum', 1);
    }, 0);
    const average = healthSum / allIds.size;
    const override = data.healthOverride === null ? null : safeInteger(data.healthOverride, 'healthOverride', 1);
    const routeHealth = calculateRouteHealth(safeInteger(data.normalizedRoute, 'normalizedRoute', 1), location.region, override, policy);
    const eligible = new Set(encounters.map(entry => entry.pokemonId));
    const opponents = catalog.filter(entry => eligible.has(entry.pokemonId)).map(entry => Object.freeze({ ...entry.definition,
        health: calculateOpponentHealth(routeHealth, entry.baseHealth, average, policy) }));
    if (typeof data.unlocked !== 'boolean') {
        throw new SimulationInputError('invalid-input', 'Route unlocked must be boolean');
    }
    return Object.freeze({ location, unlocked: data.unlocked, opponents: Object.freeze(opponents), encounters });
}

/** Compile a resolved content snapshot; this does not inspect or mutate the legacy game. */
export function compileRouteScenario(value: unknown, healthPolicy: unknown): CombatScenario {
    const data = dataObject(value, ['formatVersion', 'initialLocation', 'routes', 'clickAttackDamage', 'clickAttacksAllowed', 'initialPokeballs'], 'route content snapshot');
    if (data.formatVersion !== 1) {
        throw new SimulationInputError('invalid-input', 'Unsupported route content snapshot version');
    }
    const policy = parseRouteHealthPolicy(healthPolicy);
    const routes = Array.from(dataArray(data.routes, 'route content list'), route => compileRoute(route, policy));
    return validateScenario({ formatVersion: 2, initialLocation: data.initialLocation, routes,
        clickAttackDamage: data.clickAttackDamage, clickAttacksAllowed: data.clickAttacksAllowed, initialPokeballs: data.initialPokeballs });
}
