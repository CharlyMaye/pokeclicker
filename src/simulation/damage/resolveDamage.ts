import { CombatScenario, SimulationInputError } from '../combat/model';
import { catalogId, dataArray, dataObject, safeInteger } from '../combat/input';
import { validateLocation, validateScenario } from '../combat/validation';
import { routeKey } from '../combat/routes';

function amount(value: unknown, label: string): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
        throw new SimulationInputError('invalid-input', `${label} must be finite, nonnegative and within the safe numeric range`);
    }
    return value;
}

function flag(value: unknown, label: string): boolean {
    if (typeof value !== 'boolean') {
        throw new SimulationInputError('invalid-input', `${label} must be boolean`);
    }
    return value;
}

function factors(value: unknown, label: string): number[] {
    return Array.from(dataArray(value, label), entry => amount(entry, label));
}

/** Inputs are resolved bonuses, not game objects. No item is consumed by this calculation. */
export function calculateClickDamage(value: unknown): number {
    const data = dataObject(value, ['baseAttack', 'multiplier'], 'click damage');
    return safeInteger(Math.floor(amount(amount(data.baseAttack, 'base click attack') * amount(data.multiplier, 'click multiplier'), 'click damage')), 'click damage');
}

/** Preserve Party's ordered multiplications, sum of unrounded contributions and final round. */
export function calculatePartyDamage(value: unknown): number {
    const data = dataObject(value, ['contributors', 'multiplier', 'includeTempBonuses'], 'party damage');
    const multiplier = amount(data.multiplier, 'party multiplier');
    const includeTempBonuses = flag(data.includeTempBonuses, 'includeTempBonuses');
    const ids = new Set<number>();
    let total = 0;
    for (const input of dataArray(data.contributors, 'damage contributors')) {
        const member = dataObject(input, [
            'pokemonId', 'attack', 'active', 'breeding', 'includeBreeding', 'typeMultiplier', 'regionMultiplier',
            'weatherMultipliers', 'fluteMultipliers', 'zMoveMultiplier',
        ], 'damage contributor');
        const id = catalogId(member.pokemonId);
        if (ids.has(id)) {
            throw new SimulationInputError('invalid-input', 'Damage contributor IDs must be unique');
        }
        ids.add(id);
        const attack = amount(member.attack, 'member attack');
        const active = flag(member.active, 'active');
        const breeding = flag(member.breeding, 'breeding');
        const includeBreeding = flag(member.includeBreeding, 'includeBreeding');
        const type = amount(member.typeMultiplier, 'type multiplier');
        const region = amount(member.regionMultiplier, 'region multiplier');
        const weather = factors(member.weatherMultipliers, 'weather multipliers');
        const flute = factors(member.fluteMultipliers, 'flute multipliers');
        const zMove = amount(member.zMoveMultiplier, 'Z-move multiplier');
        // Validate every supplied field, including inactive members and disabled temporary bonuses.
        let contribution = active && (!breeding || includeBreeding) ? attack : 0;
        for (const factor of [type, region, ...weather, ...(includeTempBonuses ? [...flute, zMove] : [])]) {
            contribution = amount(contribution * factor, 'member damage');
        }
        total = amount(total + contribution, 'party damage sum');
    }
    return safeInteger(Math.round(amount(total * multiplier, 'party damage')), 'party damage');
}

/** Compile a complete damage snapshot into an existing scenario before starting a session. */
export function applyDamageSnapshot(scenarioValue: unknown, snapshotValue: unknown): CombatScenario {
    const scenario = validateScenario(scenarioValue);
    const data = dataObject(snapshotValue, ['formatVersion', 'click', 'opponents'], 'damage snapshot');
    if (data.formatVersion !== 1) {
        throw new SimulationInputError('invalid-input', 'Unsupported damage snapshot version');
    }
    const clickAttackDamage = calculateClickDamage(data.click);
    const profiles = new Map<string, number>();
    const key = (location: { region: number; route: number }, pokemonId: number) => `${routeKey(location)}:${pokemonId}`;
    for (const value of dataArray(data.opponents, 'opponent damage profiles')) {
        const profile = dataObject(value, ['location', 'pokemonId', 'party'], 'opponent damage profile');
        const id = key(validateLocation(profile.location), catalogId(profile.pokemonId));
        if (profiles.has(id)) {
            throw new SimulationInputError('invalid-input', 'Duplicate opponent damage profile');
        }
        profiles.set(id, calculatePartyDamage(profile.party));
    }
    const routes = scenario.routes.map(route => ({ ...route, opponents: route.opponents.map(opponent => {
        const id = key(route.location, opponent.pokemonId);
        const autoAttackDamage = profiles.get(id);
        if (autoAttackDamage === undefined) {
            throw new SimulationInputError('invalid-input', 'Missing opponent damage profile');
        }
        profiles.delete(id);
        return { ...opponent, autoAttackDamage };
    }) }));
    if (profiles.size) {
        throw new SimulationInputError('invalid-input', 'Damage snapshot references unknown opponents or routes');
    }
    return validateScenario({ ...scenario, clickAttackDamage, routes });
}
