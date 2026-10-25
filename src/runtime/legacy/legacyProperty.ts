import { SimulationInputError } from '../../simulation/combat/model';

/** Historical class instances are allowed; inherited properties and getters are never read. */
export function legacyProperty(value: unknown, field: string, optional = false): unknown {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new SimulationInputError('invalid-input', `Legacy ${field} requires a record`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor && optional) {
        return undefined;
    }
    if (!descriptor || !('value' in descriptor)) {
        throw new SimulationInputError('invalid-input', `Legacy ${field} must be an own data property`);
    }
    return descriptor.value;
}
