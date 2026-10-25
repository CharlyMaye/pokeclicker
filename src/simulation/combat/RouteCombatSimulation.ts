import {
    COMBAT_PROTOCOL_VERSION, CombatEvent, CombatSnapshot, parseCombatCommand, parseCombatSnapshot, validateSessionId,
} from '../../contracts/combat-protocol';
import { CombatCommandReceiver } from '../../contracts/combat-streams';
import { validateConfiguration } from '../../contracts/configuration';
import type { Configuration } from '../../contracts/configuration-types';
import { CombatWorld, CommandOutcome, RandomStep, SimulationFault, SimulationInputError, StepOutput } from './model';
import { spawnEnemy, stepCombat } from './systems';
import { findRoute } from './routes';
import { safeInteger, validateRandomState, validateScenario, xorshift32 } from './validation';

export interface AdvanceResult {
    readonly snapshot: CombatSnapshot;
    readonly events: readonly CombatEvent[];
    readonly commands: readonly CommandOutcome[];
    readonly remainingMs: number;
}

function copyWorld(world: CombatWorld): CombatWorld {
    return {
        ...world,
        health: new Map([...world.health].map(([id, value]) => [id, { ...value }])),
        encounters: new Map([...world.encounters].map(([id, value]) => [id, { ...value }])),
        captures: new Map([...world.captures].map(([id, value]) => [id, { ...value }])),
        commands: [...world.commands],
        progress: {
            ...world.progress,
            captured: new Map(world.progress.captured),
            routes: new Map([...world.progress.routes].map(([key, value]) => [key, { ...value }])),
        },
    };
}

function project(world: CombatWorld): CombatSnapshot {
    if (world.encounters.size !== 1 || world.health.size !== 1 || world.captures.size > 1) {
        throw new Error('The route world must contain exactly one opponent');
    }
    const [entity, encounter] = [...world.encounters][0];
    const health = world.health.get(entity);
    if (!health) {
        throw new Error('Encounter is missing its health component');
    }
    const capture = world.captures.get(entity);
    const enemy = { encounterId: entity, pokemonId: encounter.definition.pokemonId, health: health.current, maxHealth: health.maximum };
    return parseCombatSnapshot({
        protocolVersion: COMBAT_PROTOCOL_VERSION,
        sessionId: world.sessionId,
        sequence: world.steps,
        atMs: world.atMs,
        type: 'CombatSnapshot',
        location: world.selectedRoute.location,
        encounter: capture ? { phase: 'capturing', enemy, resolvesAtMs: capture.resolvesAtMs } : { phase: 'fighting', enemy },
    });
}

/** Owns an ECS world; time is advanced explicitly and no browser services are used. */
export class RouteCombatSimulation {
    private world: CombatWorld;
    private readonly receiver: CombatCommandReceiver;
    private failure: SimulationFault | null = null;
    private advancing = false;

    constructor(
        sessionId: string,
        configuration: Configuration,
        scenario: unknown,
        seed: number,
        private readonly random: RandomStep = xorshift32
    ) {
        if (typeof random !== 'function') {
            throw new SimulationInputError('invalid-input', 'Expected a pure random step function');
        }
        const definition = validateScenario(scenario);
        const selectedRoute = findRoute(definition.routes, definition.initialLocation);
        if (!selectedRoute) {
            throw new SimulationInputError('invalid-input', 'Missing initial route');
        }
        this.world = {
            health: new Map(), encounters: new Map(), captures: new Map(),
            configuration: validateConfiguration(configuration), scenario: definition,
            selectedRoute,
            sessionId: validateSessionId(sessionId), randomState: validateRandomState(seed),
            atMs: 0, steps: 0, nextEntity: 1, eventSequence: 0, autoElapsedMs: 0, lastClickAtMs: 0,
            pokeballs: definition.initialPokeballs, commands: [],
            progress: { money: 0, experience: 0, dungeonTokens: 0, defeats: 0, clickAttacks: 0, captured: new Map(), routes: new Map() },
        };
        this.receiver = new CombatCommandReceiver(sessionId);
        spawnEnemy(this.world, random);
        project(this.world);
    }

    get snapshot(): CombatSnapshot {
        return project(this.world);
    }

    get progress() {
        const progress = this.world.progress;
        return Object.freeze({
            money: progress.money, experience: progress.experience, dungeonTokens: progress.dungeonTokens,
            defeats: progress.defeats, clickAttacks: progress.clickAttacks, pokeballs: this.world.pokeballs,
            captured: Object.freeze([...progress.captured].sort(([a], [b]) => a - b)
                .map(([pokemonId, count]) => Object.freeze({ pokemonId, count }))),
            routes: Object.freeze([...progress.routes.values()]
                .sort((a, b) => a.location.region - b.location.region || a.location.route - b.location.route)
                .map(value => Object.freeze({ ...value, location: Object.freeze({ ...value.location }) }))),
        });
    }

    get randomState(): number {
        return this.world.randomState;
    }

    get fault(): SimulationFault | null {
        return this.failure;
    }

    private requireUsable(): void {
        if (this.failure) {
            throw this.failure;
        }
        if (this.advancing) {
            throw new SimulationInputError('busy', 'Simulation calls cannot be reentered');
        }
    }

    submit(value: unknown): void {
        this.requireUsable();
        const command = parseCombatCommand(value);
        const world = this.world;
        if (command.atMs < world.atMs || (world.steps > 0 && command.atMs === world.atMs)) {
            throw new SimulationInputError('late-command', 'Command targets already committed time');
        }
        if (command.atMs - world.atMs > world.configuration.simulation.maxCommandLeadMs) {
            throw new SimulationInputError('future-command', 'Command exceeds the configured scheduling horizon');
        }
        if (world.commands.length >= world.configuration.simulation.maxQueuedCommands) {
            throw new SimulationInputError('queue-full', 'Command queue is full');
        }
        // Only consume the sequence after all ingress checks pass.
        world.commands.push(this.receiver.receive(command));
    }

    advanceTo(targetMs: number): AdvanceResult {
        this.requireUsable();
        safeInteger(targetMs, 'targetMs');
        if (targetMs < this.world.atMs) {
            throw new SimulationInputError('invalid-input', 'Cannot advance backwards');
        }
        this.advancing = true;
        try {
            const next = copyWorld(this.world);
            const output: StepOutput = { events: [], commands: [] };
            const { stepMs, maxStepsPerAdvance } = next.configuration.simulation;
            let steps = 0;
            while (targetMs - next.atMs >= stepMs && steps < maxStepsPerAdvance) {
                stepCombat(next, this.random, output);
                steps++;
            }
            const result = Object.freeze({
                snapshot: project(next),
                events: Object.freeze(output.events),
                commands: Object.freeze(output.commands),
                remainingMs: targetMs - next.atMs,
            });
            // Commit the entire call, including RNG, commands and reward totals, together.
            this.world = next;
            return result;
        } catch (error) {
            this.failure = new SimulationFault(this.world.atMs, error instanceof Error ? error.message : 'Unknown processing failure');
            throw this.failure;
        } finally {
            this.advancing = false;
        }
    }
}
