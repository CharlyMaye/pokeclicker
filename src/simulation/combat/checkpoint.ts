import { CombatCommand, CombatSnapshot, RouteReference, parseCombatCommand, parseCombatSnapshot, validateSessionId } from '../../contracts/combat-protocol';
import { validateConfiguration } from '../../contracts/configuration';
import type { Configuration } from '../../contracts/configuration-types';
import { CombatScenario, CombatWorld, SimulationInputError } from './model';
import { dataArray, dataObject, safeInteger, validateLocation, validateRandomState, validateScenario, add } from './validation';
import { findRoute, routeKey, sameRoute } from './routes';

export interface CombatCheckpoint {
    readonly formatVersion: 1;
    readonly randomAlgorithm: 'xorshift32';
    readonly configuration: Configuration;
    readonly scenario: CombatScenario;
    readonly snapshot: CombatSnapshot;
    readonly sourceLocation: RouteReference;
    readonly randomState: number;
    readonly nextEntity: number;
    readonly autoElapsedMs: number;
    readonly lastClickAtMs: number;
    readonly commandSequence: number;
    readonly commandAtMs: number;
    readonly eventSequence: number;
    readonly pokeballs: number;
    readonly commands: readonly CombatCommand[];
    readonly progress: Readonly<{
        money: number; experience: number; dungeonTokens: number; defeats: number; clickAttacks: number;
        captured: readonly Readonly<{ pokemonId: number; count: number }>[];
        routes: readonly Readonly<{ location: RouteReference; defeats: number; captures: number }>[];
    }>;
}

function requireValid(condition: boolean, detail: string): void {
    if (!condition) {
        throw new SimulationInputError('invalid-checkpoint', detail);
    }
}

/** Canonical comparison of already validated JSON data; object property order is immaterial. */
export function sameData(left: unknown, right: unknown): boolean {
    const canonical = (value: unknown): string => {
        if (Array.isArray(value)) {
            return `[${value.map(canonical).join(',')}]`;
        }
        if (value && typeof value === 'object') {
            const data = value as Record<string, unknown>;
            return `{${Object.keys(data).sort().map(key => `${JSON.stringify(key)}:${canonical(data[key])}`).join(',')}}`;
        }
        return JSON.stringify(value);
    };
    return canonical(left) === canonical(right);
}

/** Validate a detached save before constructing or replacing any world. */
export function parseCombatCheckpoint(value: unknown, expectedConfiguration?: Configuration, expectedScenario?: unknown): CombatCheckpoint {
    const data = dataObject(value, [
        'formatVersion', 'randomAlgorithm', 'configuration', 'scenario', 'snapshot', 'sourceLocation',
        'randomState', 'nextEntity', 'autoElapsedMs', 'lastClickAtMs', 'commandSequence', 'commandAtMs', 'eventSequence', 'pokeballs', 'commands', 'progress',
    ], 'checkpoint');
    requireValid(data.formatVersion === 1 && data.randomAlgorithm === 'xorshift32', 'Unsupported checkpoint version or random algorithm');
    const config = dataObject(data.configuration, ['combat', 'simulation'], 'configuration');
    const plainConfig = (value: unknown, label: string) => {
        requireValid(!!value && typeof value === 'object', `${label} must be plain data`);
        return dataObject(value, Object.getOwnPropertyNames(value), label);
    };
    const configuration = validateConfiguration({ combat: plainConfig(config.combat, 'combat configuration'), simulation: plainConfig(config.simulation, 'simulation configuration') });
    const scenario = validateScenario(data.scenario);
    requireValid(!expectedConfiguration || sameData(configuration, validateConfiguration(expectedConfiguration)), 'Checkpoint configuration is incompatible');
    requireValid(expectedScenario === undefined || sameData(scenario, validateScenario(expectedScenario)), 'Checkpoint scenario is incompatible');
    const snapshot = parseCombatSnapshot(data.snapshot);
    const { atMs, sequence, encounter } = snapshot;
    requireValid(atMs / configuration.simulation.stepMs === sequence && encounter.phase !== 'idle', 'Checkpoint must contain a committed route encounter');
    if (encounter.phase === 'idle') {
        throw new SimulationInputError('invalid-checkpoint', 'Missing opponent');
    }
    const selected = findRoute(scenario.routes, snapshot.location);
    const sourceLocation = validateLocation(data.sourceLocation);
    const source = findRoute(scenario.routes, sourceLocation);
    const definition = source?.opponents.find(opponent => opponent.pokemonId === encounter.enemy.pokemonId);
    requireValid(!!selected?.unlocked && !!source?.unlocked && !!definition
        && sourceLocation.region === scenario.initialLocation.region && snapshot.location.region === scenario.initialLocation.region,
    'Checkpoint route or opponent is unavailable');
    requireValid(encounter.enemy.maxHealth === definition?.health, 'Checkpoint health does not match the catalog');
    if (encounter.phase === 'fighting') {
        requireValid(sameRoute(sourceLocation, snapshot.location), 'A fighting opponent must belong to the selected route');
    } else {
        requireValid(encounter.resolvesAtMs > atMs && encounter.resolvesAtMs - atMs <= (definition?.captureDurationMs ?? 0), 'Invalid pending capture deadline');
    }
    const randomState = validateRandomState(data.randomState);
    const nextEntity = safeInteger(data.nextEntity, 'nextEntity', 1);
    requireValid(nextEntity === encounter.enemy.encounterId + 1, 'Invalid encounter identity sequence');
    const autoElapsedMs = safeInteger(data.autoElapsedMs, 'autoElapsedMs');
    const lastClickAtMs = safeInteger(data.lastClickAtMs, 'lastClickAtMs');
    requireValid(autoElapsedMs < configuration.combat.autoAttackIntervalMs && autoElapsedMs % configuration.simulation.stepMs === 0
        && autoElapsedMs <= atMs && lastClickAtMs <= atMs, 'Invalid attack timing');
    const commandSequence = safeInteger(data.commandSequence, 'commandSequence');
    const commandAtMs = safeInteger(data.commandAtMs, 'commandAtMs');
    requireValid(lastClickAtMs <= commandAtMs && (commandSequence > 0 || commandAtMs === 0), 'An empty input stream must start at zero');
    const eventSequence = safeInteger(data.eventSequence, 'eventSequence');
    const pokeballs = safeInteger(data.pokeballs, 'pokeballs');
    const commands = Object.freeze(Array.from(dataArray(data.commands, 'commands', configuration.simulation.maxQueuedCommands), parseCombatCommand));
    let preceding = commandSequence - commands.length;
    let precedingTime = atMs;
    requireValid(preceding >= 0, 'Queued input exceeds the accepted stream');
    for (const command of commands) {
        requireValid(command.sessionId === snapshot.sessionId && command.sequence === ++preceding && command.atMs >= precedingTime
            && (sequence === 0 || command.atMs > atMs) && command.atMs - atMs <= configuration.simulation.maxCommandLeadMs,
        'Invalid queued command order, session or horizon');
        precedingTime = command.atMs;
    }
    requireValid(commands.length ? commandAtMs === precedingTime : commandAtMs <= atMs, 'Accepted input time disagrees with the queue');
    const totals = dataObject(data.progress, ['money', 'experience', 'dungeonTokens', 'defeats', 'clickAttacks', 'captured', 'routes'], 'progress');
    const money = safeInteger(totals.money, 'money'), experience = safeInteger(totals.experience, 'experience');
    const dungeonTokens = safeInteger(totals.dungeonTokens, 'dungeonTokens'), defeats = safeInteger(totals.defeats, 'defeats');
    const clickAttacks = safeInteger(totals.clickAttacks, 'clickAttacks');
    const catalog = new Set(scenario.routes.flatMap(route => route.opponents.map(opponent => opponent.pokemonId)));
    const captured = Object.freeze(Array.from(dataArray(totals.captured, 'captured', catalog.size), entry => {
        const record = dataObject(entry, ['pokemonId', 'count'], 'captured entry');
        requireValid(typeof record.pokemonId === 'number' && catalog.has(record.pokemonId), 'Unknown captured Pokemon');
        return Object.freeze({ pokemonId: record.pokemonId as number, count: safeInteger(record.count, 'capture count', 1) });
    }));
    requireValid(new Set(captured.map(entry => entry.pokemonId)).size === captured.length, 'Duplicate captured Pokemon');
    const routes = Object.freeze(Array.from(dataArray(totals.routes, 'route progress', scenario.routes.length), entry => {
        const record = dataObject(entry, ['location', 'defeats', 'captures'], 'route progress');
        const location = validateLocation(record.location);
        requireValid(!!findRoute(scenario.routes, location)?.unlocked && location.region === scenario.initialLocation.region, 'Unknown progress route');
        const routeDefeats = safeInteger(record.defeats, 'route defeats', 1), captures = safeInteger(record.captures, 'route captures');
        requireValid(captures <= routeDefeats, 'Route captures exceed defeats');
        return Object.freeze({ location, defeats: routeDefeats, captures });
    }));
    const sum = (values: readonly number[]) => values.reduce((total, count) => add(total, count, 'progress total'), 0);
    const captures = sum(captured.map(entry => entry.count));
    requireValid(new Set(routes.map(entry => routeKey(entry.location))).size === routes.length
        && sum(routes.map(entry => entry.defeats)) === defeats && sum(routes.map(entry => entry.captures)) === captures,
    'Progress totals are inconsistent');
    const attempts = Math.min(defeats, scenario.initialPokeballs);
    const pendingCapture = encounter.phase === 'capturing' ? 1 : 0;
    requireValid(pokeballs === scenario.initialPokeballs - attempts && captures <= attempts - pendingCapture
        && eventSequence === defeats + attempts - pendingCapture && clickAttacks <= commandSequence - commands.length,
    'Capture inventory, events or click totals are inconsistent');
    return Object.freeze({ formatVersion: 1, randomAlgorithm: 'xorshift32', configuration, scenario, snapshot, sourceLocation,
        randomState, nextEntity, autoElapsedMs, lastClickAtMs, commandSequence, commandAtMs, eventSequence, pokeballs, commands,
        progress: Object.freeze({ money, experience, dungeonTokens, defeats, clickAttacks, captured, routes }) });
}

export function restoreCombatWorld(checkpoint: CombatCheckpoint, sessionId: string): CombatWorld {
    validateSessionId(sessionId);
    const { snapshot, scenario } = checkpoint;
    if (snapshot.encounter.phase === 'idle') {
        throw new SimulationInputError('invalid-checkpoint', 'Missing opponent');
    }
    const { enemy } = snapshot.encounter;
    const selectedRoute = findRoute(scenario.routes, snapshot.location);
    const definition = findRoute(scenario.routes, checkpoint.sourceLocation)?.opponents.find(opponent => opponent.pokemonId === enemy.pokemonId);
    if (!selectedRoute || !definition) {
        throw new SimulationInputError('invalid-checkpoint', 'Missing route or opponent');
    }
    return {
        configuration: checkpoint.configuration, scenario, sessionId, selectedRoute,
        health: new Map([[enemy.encounterId, { current: enemy.health, maximum: enemy.maxHealth }]]),
        encounters: new Map([[enemy.encounterId, { definition, location: checkpoint.sourceLocation }]]),
        captures: snapshot.encounter.phase === 'capturing' ? new Map([[enemy.encounterId, { resolvesAtMs: snapshot.encounter.resolvesAtMs }]]) : new Map(),
        atMs: snapshot.atMs, steps: snapshot.sequence, nextEntity: checkpoint.nextEntity,
        randomState: checkpoint.randomState, autoElapsedMs: checkpoint.autoElapsedMs, lastClickAtMs: checkpoint.lastClickAtMs,
        commandSequence: checkpoint.commandSequence, commandAtMs: checkpoint.commandAtMs, eventSequence: checkpoint.eventSequence,
        pokeballs: checkpoint.pokeballs, commands: checkpoint.commands.map(command => parseCombatCommand({ ...command, sessionId })),
        progress: { ...checkpoint.progress, captured: new Map(checkpoint.progress.captured.map(entry => [entry.pokemonId, entry.count])),
            routes: new Map(checkpoint.progress.routes.map(entry => [routeKey(entry.location), { ...entry }])) },
    };
}
