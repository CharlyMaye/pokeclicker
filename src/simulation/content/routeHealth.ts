import { SimulationInputError } from '../combat/model';
import { dataObject, safeInteger } from '../combat/input';

export interface RouteHealthPolicy {
    readonly schemaVersion: 1;
    readonly minimumHealth: number;
    readonly routeScale: number;
    readonly routeExponent: number;
    readonly routeDivisor: number;
    readonly growthExponent: number;
    readonly regionDivisor: number;
    readonly speciesOffset: number;
    readonly speciesDivisor: number;
}

function positive(value: unknown, label: string): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        throw new SimulationInputError('invalid-input', `${label} must be finite and positive`);
    }
    return value;
}

export function parseRouteHealthPolicy(value: unknown): RouteHealthPolicy {
    const data = dataObject(value, [
        'schemaVersion', 'minimumHealth', 'routeScale', 'routeExponent', 'routeDivisor',
        'growthExponent', 'regionDivisor', 'speciesOffset', 'speciesDivisor',
    ], 'route health policy');
    if (data.schemaVersion !== 1) {
        throw new SimulationInputError('invalid-input', 'Unsupported route health policy version');
    }
    return Object.freeze({
        schemaVersion: 1,
        minimumHealth: safeInteger(data.minimumHealth, 'minimumHealth', 1),
        routeScale: positive(data.routeScale, 'routeScale'),
        routeExponent: positive(data.routeExponent, 'routeExponent'),
        routeDivisor: positive(data.routeDivisor, 'routeDivisor'),
        growthExponent: positive(data.growthExponent, 'growthExponent'),
        regionDivisor: positive(data.regionDivisor, 'regionDivisor'),
        speciesOffset: positive(data.speciesOffset, 'speciesOffset'),
        speciesDivisor: positive(data.speciesDivisor, 'speciesDivisor'),
    });
}

/** Validated policy and resolved route position; no route globals or random draws. */
export function calculateRouteHealth(normalizedRoute: number, region: number, override: number | null, policy: RouteHealthPolicy): number {
    safeInteger(normalizedRoute, 'normalizedRoute', 1);
    safeInteger(region, 'region');
    if (override !== null) {
        return safeInteger(override, 'healthOverride', 1);
    }
    const growth = Math.pow(policy.routeScale * Math.pow(normalizedRoute, policy.routeExponent) / policy.routeDivisor, policy.growthExponent);
    return safeInteger(Math.max(policy.minimumHealth, Math.floor(growth * (1 + region / policy.regionDivisor))), 'route health', 1);
}

/** Average includes every unique species on the route, including unavailable pools. */
export function calculateOpponentHealth(routeHealth: number, baseHealth: number, averageHealth: number, policy: RouteHealthPolicy): number {
    safeInteger(routeHealth, 'route health', 1);
    safeInteger(baseHealth, 'baseHealth', 1);
    positive(averageHealth, 'average health');
    return safeInteger(Math.round(routeHealth * (policy.speciesOffset + (baseHealth / averageHealth) / policy.speciesDivisor)), 'opponent health', 1);
}
