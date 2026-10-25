import { dataArray, dataObject, safeInteger } from '../combat/input';
import { SimulationInputError } from '../combat/model';

export interface LevelCurve { readonly id: string; readonly thresholds: readonly number[] }
export interface LevelCurves { readonly schemaVersion: 1; readonly curves: readonly LevelCurve[] }
export function parseLevelCurves(value: unknown): LevelCurves {
    const data = dataObject(value, ['schemaVersion', 'curves'], 'level curves');
    if (data.schemaVersion !== 1) {
        throw new SimulationInputError('invalid-input', 'Unsupported level curve version');
    }
    const ids = new Set<string>();
    const curves = Array.from(dataArray(data.curves, 'level curves'), input => {
        const curve = dataObject(input, ['id', 'thresholds'], 'level curve');
        if (typeof curve.id !== 'string' || !curve.id.trim() || ids.has(curve.id)) {
            throw new SimulationInputError('invalid-input', 'Level curve IDs must be nonempty and unique');
        }
        ids.add(curve.id);
        const thresholds = Array.from(dataArray(curve.thresholds, 'level thresholds'), value => safeInteger(value, 'experience threshold'));
        if (thresholds.length < 2 || thresholds[0] !== 0 || thresholds[thresholds.length - 1] !== Number.MAX_SAFE_INTEGER
            || thresholds.some((threshold, index) => index > 0 && threshold <= thresholds[index - 1])) {
            throw new SimulationInputError('invalid-input', 'Level thresholds must increase from zero to the safe-integer sentinel');
        }
        return Object.freeze({ id: curve.id, thresholds: Object.freeze(thresholds) });
    });
    if (!curves.length) {
        throw new SimulationInputError('invalid-input', 'At least one level curve is required');
    }
    return Object.freeze({ schemaVersion: 1, curves: Object.freeze(curves) });
}
