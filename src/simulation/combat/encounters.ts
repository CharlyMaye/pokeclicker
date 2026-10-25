import { CombatRoute, OpponentDefinition, SimulationInputError, WeightedEncounter } from './model';
import { catalogId, dataArray, dataObject } from './input';

function weight(value: unknown): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        throw new SimulationInputError('invalid-input', 'Encounter weight must be finite and nonnegative');
    }
    return value;
}

export function validateEncounterTable(value: unknown, catalog?: ReadonlySet<number>): readonly WeightedEncounter[] {
    const entries = Array.from(dataArray(value, 'encounters'), entry => {
        const data = dataObject(entry, ['pokemonId', 'weight'], 'weighted encounter');
        const pokemonId = catalogId(data.pokemonId);
        if (catalog && !catalog.has(pokemonId)) {
            throw new SimulationInputError('invalid-input', 'Encounter references an unknown opponent');
        }
        return Object.freeze({ pokemonId, weight: weight(data.weight) });
    });
    let total = 0;
    for (const entry of entries) {
        const next = total + entry.weight;
        if (!Number.isFinite(next) || (entry.weight > 0 && next === total)) {
            throw new SimulationInputError('invalid-input', 'Encounter weight total overflows or loses a positive interval');
        }
        total = next;
    }
    if (total <= 0) {
        throw new SimulationInputError('invalid-input', 'Encounter table must have positive total weight');
    }
    return Object.freeze(entries);
}

/** Input is an already validated route and a finite random draw in [0, 1). */
export function selectOpponent(route: CombatRoute, draw: number): OpponentDefinition {
    if (!route.encounters) {
        return route.opponents[Math.floor(draw * route.opponents.length)];
    }
    const entries = route.encounters;
    let remaining = draw * entries.reduce((total, entry) => total + entry.weight, 0);
    // Match Rand.fromWeightedArray: ordered subtraction, inclusive boundary and first-entry fallback.
    const selected = entries.find(entry => (remaining -= entry.weight) <= 0) ?? entries[0];
    const definition = route.opponents.find(entry => entry.pokemonId === selected.pokemonId);
    if (!definition) {
        throw new Error('Validated encounter is missing its opponent definition');
    }
    return definition;
}

/** Resolve one eligibility snapshot; no globals, requirements, clock or renderer are consulted. */
export function resolveRouteEncounterPools(value: unknown, access: unknown): readonly WeightedEncounter[] {
    const pools = dataObject(value, ['land', 'water', 'headbutt', 'special', 'ordinaryWeight'], 'encounter pools');
    const eligibility = dataObject(access, ['waterUnlocked', 'includeHeadbutt'], 'encounter access');
    if (typeof eligibility.waterUnlocked !== 'boolean' || typeof eligibility.includeHeadbutt !== 'boolean') {
        throw new SimulationInputError('invalid-input', 'Encounter access flags must be booleans');
    }
    const ordinaryWeight = weight(pools.ordinaryWeight);
    const ordinary = (input: unknown) => Array.from(dataArray(input, 'ordinary pool'), pokemonId => ({ pokemonId: catalogId(pokemonId), weight: ordinaryWeight }));
    const land = ordinary(pools.land);
    const water = ordinary(pools.water);
    const headbutt = ordinary(pools.headbutt);
    const special = Array.from(dataArray(pools.special, 'special pools'), input => {
        const group = dataObject(input, ['pokemonIds', 'weight', 'available'], 'special pool');
        if (typeof group.available !== 'boolean') {
            throw new SimulationInputError('invalid-input', 'Special pool availability must be boolean');
        }
        const groupWeight = weight(group.weight);
        const entries = Array.from(dataArray(group.pokemonIds, 'special pool IDs'), pokemonId => ({ pokemonId: catalogId(pokemonId), weight: groupWeight }));
        return group.available ? entries : [];
    });
    return validateEncounterTable([
        ...land,
        ...(eligibility.waterUnlocked || land.length === 0 ? water : []),
        ...(eligibility.includeHeadbutt ? headbutt : []),
        ...special.flat(),
    ]);
}
