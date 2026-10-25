/* Generated. Run npm run generate:config; do not edit. */
import type { CombatConfiguration } from './combat';
import type { SimulationConfiguration } from './simulation';
interface Validator<T> {
    (value: unknown): value is T;
    errors?: null | readonly { instancePath: string; message?: string; params: Record<string, unknown> }[];
}
export const validateCombat: Validator<CombatConfiguration>;
export const validateSimulation: Validator<SimulationConfiguration>;
