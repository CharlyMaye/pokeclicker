import { ProgressLabels, parseProgressLabels } from '../../client/combat/ProgressViewModel';
import { CombatViewModel, CombatLabels } from '../../client/combat/CombatViewModel';
import { CombatScenario } from '../../simulation/combat/model';
import { dataObject, safeInteger, validateRandomState, validateScenario } from '../../simulation/combat/validation';

export type RendererKind = 'dom' | 'knockout';
export const LAB_TEXT_FIELDS = [
    'title', 'intro', 'start', 'pause', 'attack', 'save', 'load', 'recover', 'renderer', 'route', 'dom', 'knockout',
    'loading', 'busy', 'running', 'stopped', 'saved', 'ready', 'failed', 'noSave', 'confirmLoad', 'confirmRecover', 'confirm', 'cancel', 'back',
    'fileHeading', 'export', 'download', 'chooseFile', 'importHelp', 'confirmImport', 'exportReady', 'imported', 'selectedFile',
    'status', 'hidden', 'storageNotice', 'failedStartup', 'rendererNotice', 'unsupported',
] as const;
export type LabText = Readonly<Record<typeof LAB_TEXT_FIELDS[number], string>>;
const COLOR_FIELDS = ['background', 'surface', 'text', 'muted', 'accent', 'outline'] as const;
const SIZE_FIELDS = ['gapRem', 'paddingRem', 'radiusRem', 'panelMinRem', 'maxWidthRem', 'fontSizeRem', 'lineHeight'] as const;
export type LabTheme = Readonly<Record<typeof COLOR_FIELDS[number], string> & Record<typeof SIZE_FIELDS[number], number>>;
export interface LabConfiguration {
    readonly schemaVersion: 4;
    readonly startupTimeoutMs: number;
    readonly requestTimeoutMs: number;
    readonly maxCheckpointBytes: number;
    readonly saveSlot: string;
    readonly checkpointFilename: string;
    readonly seed: number;
    readonly initialRenderer: RendererKind;
    readonly scenario: CombatScenario;
    readonly combatLabels: CombatLabels;
    readonly progressLabels: ProgressLabels;
    readonly text: LabText;
    readonly theme: LabTheme;
}

/** Canonical lab schema and business validation, shared by build and runtime. */
export function parseLabConfiguration(value: unknown): LabConfiguration {
    const data = dataObject(value, [
        'schemaVersion', 'startupTimeoutMs', 'requestTimeoutMs', 'maxCheckpointBytes', 'saveSlot', 'seed',
        'checkpointFilename', 'initialRenderer', 'scenario', 'combatLabels', 'progressLabels', 'text', 'theme',
    ], 'lab configuration');
    if (data.schemaVersion !== 4 || !['dom', 'knockout'].includes(data.initialRenderer as string)
        || typeof data.saveSlot !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(data.saveSlot)) {
        throw new Error('Unsupported lab version, renderer or save slot');
    }
    if (typeof data.checkpointFilename !== 'string' || !/^[A-Za-z0-9_-]+\.json$/.test(data.checkpointFilename)) {
        throw new Error('Checkpoint filename must be a portable JSON filename');
    }
    const startupTimeoutMs = safeInteger(data.startupTimeoutMs, 'startupTimeoutMs', 1);
    const requestTimeoutMs = safeInteger(data.requestTimeoutMs, 'requestTimeoutMs', 1);
    // Browser timer representation limit, not a product default.
    if (startupTimeoutMs > 2 ** 31 - 1 || requestTimeoutMs > 2 ** 31 - 1) {
        throw new Error('Lab timeout exceeds the browser timer range');
    }
    const textData = dataObject(data.text, LAB_TEXT_FIELDS, 'lab text');
    const text = Object.freeze(Object.fromEntries(LAB_TEXT_FIELDS.map(key => {
        const content = textData[key];
        if (typeof content !== 'string' || !content.trim()) {
            throw new Error(`Lab text ${key} must be nonempty`);
        }
        return [key, content];
    }))) as LabText;
    const themeData = dataObject(data.theme, [...COLOR_FIELDS, ...SIZE_FIELDS], 'lab theme');
    for (const key of COLOR_FIELDS) {
        if (typeof themeData[key] !== 'string' || !/^#[0-9a-f]{6}$/i.test(themeData[key] as string)) {
            throw new Error(`Lab color ${key} must be a six-digit hex color`);
        }
    }
    for (const key of SIZE_FIELDS) {
        if (typeof themeData[key] !== 'number' || !Number.isFinite(themeData[key]) || (themeData[key] as number) <= 0) {
            throw new Error(`Lab layout ${key} must be finite and positive`);
        }
    }
    return Object.freeze({ schemaVersion: 4, startupTimeoutMs, requestTimeoutMs,
        maxCheckpointBytes: safeInteger(data.maxCheckpointBytes, 'maxCheckpointBytes', 1), saveSlot: data.saveSlot, checkpointFilename: data.checkpointFilename,
        seed: validateRandomState(data.seed), initialRenderer: data.initialRenderer as RendererKind,
        scenario: validateScenario(data.scenario), combatLabels: new CombatViewModel('lab-label-validation', data.combatLabels).labels,
        progressLabels: parseProgressLabels(data.progressLabels), text, theme: Object.freeze({ ...themeData }) as LabTheme });
}
