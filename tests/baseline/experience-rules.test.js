import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import * as GameConstants from '../../src/modules/GameConstants';
import Routes from '../../src/modules/routes/Routes';
import '../../src/modules/routes/RouteData';
import { pokemonList } from '../../src/modules/pokemons/PokemonList';
import { calculateExperienceReward, calculateRouteLevel, parseExperiencePolicy, planExperienceGrant } from '../../src/simulation/experience/experienceRules';
import { captureRouteCatalog } from '../../src/runtime/legacy/captureRouteCatalog';
import { prepareLegacyExperienceSession } from '../../src/runtime/legacy/prepareLegacyExperienceSession';
import experiencePolicy from '../../public/config/experience.json';
import healthPolicy from '../../public/config/route-health.json';
import encounterPolicy from '../../public/config/encounter-rules.json';
const policy = parseExperiencePolicy(experiencePolicy);
const compiledSources = new Map();
function legacy(relative, name, context) {
    if (!compiledSources.has(relative)) {
    const source = readFileSync(new URL(relative, import.meta.url), 'utf8');
    const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None } }).outputText;
    compiledSources.set(relative, compiled);
    }
    return new Function(...Object.keys(context), `${compiledSources.get(relative)}\nreturn ${name};`)(...Object.values(context));
}
const factory = legacy('../../src/scripts/pokemons/PokemonFactory.ts', 'PokemonFactory', { MapHelper: { normalizeRoute: (route, region) => Routes.normalizedNumber(region, route) } });
class Bonus { constructor(value) { this.gainedBonus = value; } }
function partyHarness(recipients, multiplier) {
    const flow = [], bonuses = [];
    const App = { game: { badgeCase: { maxLevel: () => 100 }, purifyChamber: { gainFlow: amount => flow.push(amount) } } };
    const Pokemon = legacy('../../src/scripts/party/PartyPokemon.ts', 'PartyPokemon', { App, ExpGainedBonusHeldItem: Bonus });
    const Party = legacy('../../src/scripts/party/Party.ts', 'Party', { App, GameConstants });
    const members = recipients.map(p => Object.assign(Object.defineProperties(Object.create(Pokemon.prototype), { level: { value: p.level, writable: true }, shadow: { value: 0, writable: true } }), {
        exp: 0, shadow: p.shadow ? GameConstants.ShadowStatus.Shadow : GameConstants.ShadowStatus.None,
        heldItem: () => new Bonus(p.multiplier), calculateLevelFromExp: () => p.level,
    }));
    const party = Object.create(Party.prototype);
    Object.defineProperty(party, 'caughtPokemon', { value: members });
    party.multiplier = { getBonus: (...args) => { bonuses.push(args); return multiplier; } };
    return { party, members, flow, bonuses };
}
describe('legacy experience calculation and distribution parity', () => {
    it('matches real routeLevel for the complete shipped registry', () => {
        Routes.regionRoutes.forEach(route => expect(calculateRouteLevel(Routes.normalizedNumber(route.region, route.number), policy)).toBe(factory.routeLevel(route.number, route.region)));
    });
    it.each([false, true])('matches Party.gainExp and PartyPokemon.gainExp with trainer=%s', trainer => {
        const recipients = [
            { pokemonId: 1, level: 10, maxLevel: 100, multiplier: 1.5, shadow: false },
            { pokemonId: 2, level: 100, maxLevel: 100, multiplier: 1.25, shadow: true },
            { pokemonId: 3, level: 10, maxLevel: 100, multiplier: 2, shadow: true },
        ];
        for (const baseExperience of [0, 1, 64, 255, 608]) for (const level of [1, 20, 73, 100]) for (const multiplier of [0, 1, 1.1, 2.5]) {
            const harness = partyHarness(recipients, multiplier);
            harness.party.gainExp(baseExperience, level, trainer);
            const shared = calculateExperienceReward({ baseExperience, level, trainer, multiplier }, policy);
            const plan = planExperienceGrant(shared, recipients);
            expect(plan.members.map(p => p.stored)).toEqual(harness.members.map(p => p.exp));
            expect(harness.flow).toEqual([plan.shadowExperience]);
            expect(harness.bonuses).toEqual([['exp', true]]);
        }
    });
    it('prepares every shipped route yield using the actual catalog, factory levels and party formula', () => {
        const locations = Routes.regionRoutes.map(route => ({ region: route.region, route: route.number }));
        const catalog = captureRouteCatalog(Routes.regionRoutes, pokemonList, locations);
        const session = { formatVersion: 2, initialLocation: locations[0], ordinaryWeight: 1, clickAttackDamage: 10, clickAttacksAllowed: true, initialPokeballs: 2,
            routes: catalog.map(route => ({ location: route.location, unlocked: true, access: { waterUnlocked: true, includeHeadbutt: true },
                specialAvailability: route.pools.special.map(() => true),
                opponents: route.catalog.map(p => ({ pokemonId: p.pokemonId, autoAttackDamage: 10, experienceMultiplier: 1.5,
                    pokeballBonus: 5, oakBonus: 2, captureDurationMs: 200, moneyMultiplier: 1.5, tokenMultiplier: 1.25 })),
            })),
        };
        const scenario = prepareLegacyExperienceSession({ registry: Routes.regionRoutes, pokemonList, session, healthPolicy, encounterPolicy, experiencePolicy });
        const byId = new Map(pokemonList.map(p => [p.id, p]));
        // Run the real party method once per unique (yield, level) pair; bonuses are controlled inputs.
        const cache = new Map();
        for (const route of scenario.routes) for (const opponent of route.opponents) {
            const level = factory.routeLevel(route.location.route, route.location.region), base = byId.get(opponent.pokemonId).exp;
            const key = `${base}:${level}`;
            if (!cache.has(key)) {
                const harness = partyHarness([{ level: 1, multiplier: 1, shadow: false }], 1.5);
                harness.party.gainExp(base, level, false); cache.set(key, harness.members[0].exp);
            }
            expect(opponent.experienceReward).toBe(cache.get(key));
        }
    });
});
