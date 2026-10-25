import { legacyProperty as own } from './legacyProperty';
import type { RouteReference } from '../../contracts/combat-protocol';
import { catalogId, dataArray, safeInteger, validateLocation } from '../../simulation/combat/input';
import { SimulationInputError } from '../../simulation/combat/model';
import { routeKey } from '../../simulation/combat/routes';
import { finiteRuleNumber } from '../../simulation/content/encounterPolicy';

export interface CapturedRoute {
    readonly location: RouteReference;
    readonly normalizedRoute: number;
    readonly healthOverride: number | null;
    readonly pools: Readonly<{
        land: readonly number[]; water: readonly number[]; headbutt: readonly number[];
        special: readonly Readonly<{ pokemonIds: readonly number[]; weight: number }>[];
    }>;
    readonly catalog: readonly Readonly<{ pokemonId: number; baseHealth: number; baseCatchRate: number }>[];
}

function name(value: unknown): string {
    if (typeof value !== 'string' || !value.trim()) {
        throw new SimulationInputError('invalid-input', 'Legacy species name must be nonempty');
    }
    return value;
}

/** Read the complete Routes.regionRoutes registry and raw pokemonList, never game methods. */
export function captureRouteCatalog(registryValue: unknown, pokemonListValue: unknown, locationsValue: unknown): readonly CapturedRoute[] {
    const registry = new Map<string, { source: unknown; location: RouteReference; normalizedRoute: number }>();
    let count = 0;
    for (const source of dataArray(registryValue, 'legacy route registry')) {
        const location = validateLocation({ region: own(source, 'region'), route: own(source, 'number') });
        const key = routeKey(location);
        const ignored = own(source, 'ignoreRouteInCalculations');
        if (typeof ignored !== 'boolean' || registry.has(key)) {
            throw new SimulationInputError('invalid-input', 'Legacy route identities must be unique and calculation flags boolean');
        }
        // Match Routes.normalizedNumber: test the route before incrementing the count.
        registry.set(key, { source, location, normalizedRoute: safeInteger(count + 1, 'normalized route', 1) });
        if (!ignored) {
            count++;
        }
    }
    const byName = new Map<string, unknown>();
    for (const source of dataArray(pokemonListValue, 'legacy Pokemon catalog')) {
        const species = name(own(source, 'name'));
        if (byName.has(species)) {
            throw new SimulationInputError('invalid-input', 'Duplicate legacy species name');
        }
        byName.set(species, source);
    }
    const selected = new Set<string>();
    const usedIds = new Map<number, string>();
    return Object.freeze(Array.from(dataArray(locationsValue, 'selected locations'), input => {
        const location = validateLocation(input);
        const key = routeKey(location);
        const entry = registry.get(key);
        if (!entry || selected.has(key)) {
            throw new SimulationInputError('invalid-input', 'Unknown or duplicate selected route');
        }
        selected.add(key);
        const catalog = new Map<number, CapturedRoute['catalog'][number]>();
        const ids = (value: unknown) => Object.freeze(Array.from(dataArray(value, 'legacy pool'), rawName => {
            const species = name(rawName);
            const source = byName.get(species);
            if (!source) {
                throw new SimulationInputError('invalid-input', `Unknown legacy species: ${species}`);
            }
            const pokemonId = catalogId(own(source, 'id'));
            if (usedIds.has(pokemonId) && usedIds.get(pokemonId) !== species) {
                throw new SimulationInputError('invalid-input', 'Distinct legacy species share a catalog ID');
            }
            usedIds.set(pokemonId, species);
            if (!catalog.has(pokemonId)) {
                catalog.set(pokemonId, Object.freeze({ pokemonId,
                    baseHealth: safeInteger(own(own(source, 'base'), 'hitpoints'), 'base health', 1),
                    baseCatchRate: finiteRuleNumber(own(source, 'catchRate'), 'base catch rate') }));
            }
            return pokemonId;
        }));
        const sourcePools = own(entry.source, 'pokemon');
        // Preserve historical pool order, including unavailable groups and duplicate intervals.
        const land = ids(own(sourcePools, 'land'));
        const water = ids(own(sourcePools, 'water'));
        const headbutt = ids(own(sourcePools, 'headbutt'));
        const special = Object.freeze(Array.from(dataArray(own(sourcePools, 'special'), 'legacy special pools'), group => Object.freeze({
            pokemonIds: ids(own(group, 'pokemon')), weight: finiteRuleNumber(own(group, 'weight'), 'special weight'),
        })));
        const override = own(entry.source, 'routeHealth', true);
        return Object.freeze({ location, normalizedRoute: entry.normalizedRoute,
            healthOverride: override === undefined ? null : safeInteger(override, 'route health override', 1),
            pools: Object.freeze({ land, water, headbutt, special }), catalog: Object.freeze([...catalog.values()]) });
    }));
}
