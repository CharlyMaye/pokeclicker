import type { RouteReference } from '../../contracts/combat-protocol';
import { SimulationInputError } from './model';

export function safeInteger(value: unknown, label: string, minimum = 0): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
        throw new SimulationInputError('invalid-input', `${label} must be a safe integer >= ${minimum}`);
    }
    return value;
}

export function dataObject(value: unknown, fields: readonly string[], label: string): Record<string, unknown> {
    if (value === null || typeof value !== 'object' || Array.isArray(value)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
        throw new SimulationInputError('invalid-input', `${label} must be a plain data object`);
    }
    const keys = Reflect.ownKeys(value);
    if (keys.length !== fields.length || !fields.every(field => {
        const descriptor = Object.getOwnPropertyDescriptor(value, field);
        return descriptor && 'value' in descriptor;
    })) {
        throw new SimulationInputError('invalid-input', `${label} must contain exactly ${fields.join(', ')}`);
    }
    return value as Record<string, unknown>;
}

export function dataArray(value: unknown, label: string, maximum = Number.MAX_SAFE_INTEGER): unknown[] {
    if (!Array.isArray(value) || value.length > maximum || Reflect.ownKeys(value).length !== value.length + 1) {
        throw new SimulationInputError('invalid-input', `${label} must be a bounded dense array`);
    }
    for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !('value' in descriptor)) {
            throw new SimulationInputError('invalid-input', `${label} must contain data properties only`);
        }
    }
    return value;
}

export function catalogId(value: unknown): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > Number.MAX_SAFE_INTEGER) {
        throw new SimulationInputError('invalid-input', 'pokemonId must be a positive finite catalog ID');
    }
    return value;
}

export function validateLocation(value: unknown): RouteReference {
    const data = dataObject(value, ['region', 'route'], 'location');
    return Object.freeze({ region: safeInteger(data.region, 'region'), route: safeInteger(data.route, 'route', 1) });
}
