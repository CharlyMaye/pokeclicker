import { catalogId, dataArray, dataObject } from '../../simulation/combat/input';
import { SimulationInputError } from '../../simulation/combat/model';
import { calculateExperienceReward, calculateRouteLevel, parseExperiencePolicy } from '../../simulation/experience/experienceRules';
import { legacyProperty } from './legacyProperty';
import { captureRouteCatalog } from './captureRouteCatalog';
import { prepareLegacyRouteSession } from './prepareLegacyRouteSession';

/** Version 2 inputs derive shared experience from catalog yields and route levels. */
export function prepareLegacyExperienceSession(value: unknown) {
    const data = dataObject(value, ['registry', 'pokemonList', 'session', 'healthPolicy', 'encounterPolicy', 'experiencePolicy'], 'legacy experience preparation');
    const session = dataObject(data.session, ['formatVersion', 'initialLocation', 'routes', 'ordinaryWeight', 'clickAttackDamage', 'clickAttacksAllowed', 'initialPokeballs'], 'legacy experience session');
    if (session.formatVersion !== 2) {
        throw new SimulationInputError('invalid-input', 'Derived experience requires session input version 2');
    }
    const policy = parseExperiencePolicy(data.experiencePolicy);
    const states = Array.from(dataArray(session.routes, 'legacy experience routes'), input => dataObject(input,
        ['location', 'unlocked', 'access', 'specialAvailability', 'opponents'], 'legacy experience route'));
    const catalog = captureRouteCatalog(data.registry, data.pokemonList, states.map(route => route.location));
    const required = new Set(catalog.flatMap(route => route.catalog.map(p => p.pokemonId)));
    const yields = new Map<number, unknown>();
    for (const pokemon of dataArray(data.pokemonList, 'legacy Pokemon catalog')) {
        const id = legacyProperty(pokemon, 'id');
        if (typeof id === 'number' && required.has(id)) {
            if (yields.has(id)) {
                throw new SimulationInputError('invalid-input', 'Ambiguous legacy experience catalog ID');
            }
            yields.set(id, legacyProperty(pokemon, 'exp'));
        }
    }
    const routes = states.map((route, index) => {
        const level = calculateRouteLevel(catalog[index].normalizedRoute, policy);
        const opponents = Array.from(dataArray(route.opponents, 'legacy experience opponents'), input => {
            const opponent = dataObject(input, ['pokemonId', 'autoAttackDamage', 'experienceMultiplier', 'pokeballBonus', 'oakBonus', 'captureDurationMs', 'moneyMultiplier', 'tokenMultiplier'], 'legacy experience opponent');
            const { experienceMultiplier, ...resolved } = opponent;
            return { ...resolved, experienceReward: calculateExperienceReward({ baseExperience: yields.get(catalogId(opponent.pokemonId)),
                level, trainer: false, multiplier: experienceMultiplier }, policy) };
        });
        return { ...route, opponents };
    });
    return prepareLegacyRouteSession({ registry: data.registry, pokemonList: data.pokemonList, healthPolicy: data.healthPolicy,
        encounterPolicy: data.encounterPolicy, session: { ...session, formatVersion: 1, routes } });
}
