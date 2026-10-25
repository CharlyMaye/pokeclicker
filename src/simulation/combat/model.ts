import type { CombatCommand, CombatEvent, RouteReference } from '../../contracts/combat-protocol';
import type { Configuration } from '../../contracts/configuration-types';

export interface OpponentDefinition {
    readonly pokemonId: number;
    readonly health: number;
    readonly autoAttackDamage: number;
    readonly moneyReward: number;
    readonly experienceReward: number;
    readonly dungeonTokenReward: number;
    readonly captureProbability: number;
    readonly captureDurationMs: number;
}

export interface CombatRoute {
    readonly location: RouteReference;
    readonly opponents: readonly OpponentDefinition[];
    readonly unlocked: boolean;
}

/** Resolved session inputs, not the legacy save or full Pokemon catalog format. */
export interface CombatScenario {
    readonly initialLocation: RouteReference;
    readonly routes: readonly CombatRoute[];
    readonly clickAttackDamage: number;
    readonly clickAttacksAllowed: boolean;
    readonly initialPokeballs: number;
}

export type RandomStep = (state: number) => Readonly<{ state: number; value: number }>;
export type Entity = number;
export interface Health { current: number; maximum: number }
export interface Encounter { definition: OpponentDefinition; location: RouteReference }
export interface Capture { resolvesAtMs: number }

export interface RouteProgress {
    location: RouteReference;
    defeats: number;
    captures: number;
}

export interface Progress {
    money: number;
    experience: number;
    dungeonTokens: number;
    defeats: number;
    clickAttacks: number;
    captured: Map<number, number>;
    routes: Map<string, RouteProgress>;
}

export interface CombatWorld {
    health: Map<Entity, Health>;
    encounters: Map<Entity, Encounter>;
    captures: Map<Entity, Capture>;
    configuration: Configuration;
    scenario: CombatScenario;
    selectedRoute: CombatRoute;
    sessionId: string;
    atMs: number;
    steps: number;
    nextEntity: number;
    eventSequence: number;
    randomState: number;
    autoElapsedMs: number;
    lastClickAtMs: number;
    pokeballs: number;
    commands: CombatCommand[];
    progress: Progress;
}

export type CommandOutcome = Readonly<{
    sequence: number;
    atMs: number;
    result: 'applied' | 'cooldown' | 'disabled' | 'no-target' | 'route-unchanged' | 'route-unavailable';
}>;

export interface StepOutput {
    events: CombatEvent[];
    commands: CommandOutcome[];
}

export class SimulationInputError extends Error {
    constructor(public readonly code: string, detail: string) {
        super(detail);
        this.name = 'SimulationInputError';
    }
}

export class SimulationFault extends Error {
    constructor(public readonly committedAtMs: number, detail: string) {
        super(`Simulation stopped at committed time ${committedAtMs}: ${detail}`);
        this.name = 'SimulationFault';
    }
}
