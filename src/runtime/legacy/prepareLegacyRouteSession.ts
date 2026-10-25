import { dataArray, dataObject, catalogId, safeInteger, validateLocation } from '../../simulation/combat/input';
import { SimulationInputError } from '../../simulation/combat/model';
import { routeKey } from '../../simulation/combat/routes';
import { validateScenario } from '../../simulation/combat/validation';
import { compileRouteScenario } from '../../simulation/content/compileRouteScenario';
import { calculateEncounterRules, parseEncounterRulesPolicy } from '../../simulation/content/encounterPolicy';
import { captureRouteCatalog } from './captureRouteCatalog';

/** Snapshot mutable eligibility and resolved bonuses separately from the historical catalog. */
export function prepareLegacyRouteSession(value: unknown) {
    const data = dataObject(value, ['registry', 'pokemonList', 'session', 'healthPolicy', 'encounterPolicy'], 'legacy route preparation');
    const session = dataObject(data.session, ['formatVersion', 'initialLocation', 'routes', 'ordinaryWeight', 'clickAttackDamage', 'clickAttacksAllowed', 'initialPokeballs'], 'legacy session snapshot');
    if (session.formatVersion !== 1) {
        throw new SimulationInputError('invalid-input', 'Unsupported legacy session snapshot version');
    }
    const state = Array.from(dataArray(session.routes, 'legacy session routes'), value => dataObject(value,
        ['location', 'unlocked', 'access', 'specialAvailability', 'opponents'], 'legacy route state'));
    const captured = captureRouteCatalog(data.registry, data.pokemonList, state.map(route => route.location));
    const policy = parseEncounterRulesPolicy(data.encounterPolicy);
    const profiles = new Map<string, { location: ReturnType<typeof validateLocation>; pokemonId: number; inputs: Record<string, unknown> }>();
    const profileKey = (location: ReturnType<typeof validateLocation>, id: number) => `${routeKey(location)}:${id}`;
    const routes = captured.map((route, index) => {
        const settings = state[index];
        const availability = dataArray(settings.specialAvailability, 'special availability', route.pools.special.length);
        if (availability.length !== route.pools.special.length || availability.some(flag => typeof flag !== 'boolean')) {
            throw new SimulationInputError('invalid-input', 'Every special pool needs an explicit availability flag');
        }
        const required = new Map(route.catalog.map(entry => [entry.pokemonId, entry]));
        const catalog = Array.from(dataArray(settings.opponents, 'resolved legacy opponents', required.size), value => {
            const opponent = dataObject(value, ['pokemonId', 'autoAttackDamage', 'experienceReward', 'pokeballBonus', 'oakBonus', 'captureDurationMs', 'moneyMultiplier', 'tokenMultiplier'], 'resolved legacy opponent');
            const pokemonId = catalogId(opponent.pokemonId);
            const species = required.get(pokemonId);
            if (!species) {
                throw new SimulationInputError('invalid-input', 'Unknown or duplicate resolved legacy opponent');
            }
            required.delete(pokemonId);
            const inputs = { normalizedRoute: route.normalizedRoute, baseCatchRate: species.baseCatchRate,
                pokeballBonus: opponent.pokeballBonus, oakBonus: opponent.oakBonus, captureDurationMs: opponent.captureDurationMs,
                moneyMultiplier: opponent.moneyMultiplier, tokenMultiplier: opponent.tokenMultiplier };
            // Templates use the lower endpoint; active encounter values are sampled by version 3.
            const resolved = calculateEncounterRules({ ...inputs, catchVariation: policy.catchVariationMin, moneyDeviation: policy.moneyDeviationMin }, route.location.region, policy);
            calculateEncounterRules({ ...inputs, catchVariation: policy.catchVariationMax, moneyDeviation: policy.moneyDeviationMax }, route.location.region, policy);
            profiles.set(profileKey(route.location, pokemonId), { location: route.location, pokemonId, inputs });
            return { pokemonId, baseHealth: species.baseHealth, combat: { ...resolved,
                autoAttackDamage: safeInteger(opponent.autoAttackDamage, 'resolved automatic damage'),
                experienceReward: safeInteger(opponent.experienceReward, 'resolved experience reward') } };
        });
        if (required.size) {
            throw new SimulationInputError('invalid-input', 'Missing resolved legacy opponents');
        }
        return { location: route.location, normalizedRoute: route.normalizedRoute, healthOverride: route.healthOverride,
            unlocked: settings.unlocked, access: settings.access, catalog,
            pools: { ...route.pools, ordinaryWeight: session.ordinaryWeight,
                special: route.pools.special.map((group, i) => ({ ...group, available: availability[i] })) } };
    });
    const scenario = compileRouteScenario({ formatVersion: 1, initialLocation: session.initialLocation, routes,
        clickAttackDamage: session.clickAttackDamage, clickAttacksAllowed: session.clickAttacksAllowed, initialPokeballs: session.initialPokeballs }, data.healthPolicy);
    return validateScenario({ ...scenario, formatVersion: 3, spawnRules: { policy,
        opponents: scenario.routes.flatMap(route => route.opponents.map(opponent => profiles.get(profileKey(route.location, opponent.pokemonId)))) } });
}
