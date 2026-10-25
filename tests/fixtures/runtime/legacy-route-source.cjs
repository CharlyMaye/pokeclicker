const content = require('../simulation/route-content.json');
const healthPolicy = require('../../../public/config/route-health.json');
const encounterPolicy = require('../../../public/config/encounter-rules.json');
// Synthetic named source records exercise the historical class shapes without a live save.
class Route {
    constructor(fields) { Object.assign(this, fields); }
    isUnlocked() { throw new Error('Requirement evaluation is forbidden during catalog capture'); }
}
class Special {
    constructor(fields) { Object.assign(this, fields); }
    isAvailable() { throw new Error('Requirement evaluation is forbidden during catalog capture'); }
}
module.exports = function createInput() {
    const pokemon = new Map();
    const speciesName = id => `Fixture species ${id}`;
    const registry = content.routes.map(route => {
        route.catalog.forEach(p => pokemon.set(p.pokemonId, { id: p.pokemonId, name: speciesName(p.pokemonId), base: { hitpoints: p.baseHealth }, catchRate: 100 }));
        return new Route({ region: route.location.region, number: route.location.route, ignoreRouteInCalculations: false,
            routeHealth: route.healthOverride, pokemon: {
                land: route.pools.land.map(speciesName), water: route.pools.water.map(speciesName), headbutt: route.pools.headbutt.map(speciesName),
                special: route.pools.special.map(p => new Special({ pokemon: p.pokemonIds.map(speciesName), weight: p.weight })),
            } });
    });
    return { registry, pokemonList: [...pokemon.values()], healthPolicy: structuredClone(healthPolicy), encounterPolicy: structuredClone(encounterPolicy),
        session: { formatVersion: 1, initialLocation: { ...content.initialLocation }, ordinaryWeight: 1,
            clickAttackDamage: content.clickAttackDamage, clickAttacksAllowed: content.clickAttacksAllowed, initialPokeballs: content.initialPokeballs,
            routes: content.routes.map(route => ({ location: { ...route.location }, unlocked: route.unlocked, access: { ...route.access },
                specialAvailability: route.pools.special.map(p => p.available),
                opponents: route.catalog.map(p => ({ pokemonId: p.pokemonId, autoAttackDamage: p.combat.autoAttackDamage, experienceReward: p.combat.experienceReward,
                    pokeballBonus: 5, oakBonus: 2, captureDurationMs: p.combat.captureDurationMs, moneyMultiplier: 1.5, tokenMultiplier: 1.25 })),
            })),
        } };
};
