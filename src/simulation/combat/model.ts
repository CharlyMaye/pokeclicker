import type { PartyDefinition, PartyState } from '../experience/partyExperience';
import type { SpawnRules, SpawnSample } from './spawnRules';
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

interface RouteDefinition {
    readonly location: RouteReference;
    readonly opponents: readonly OpponentDefinition[];
    readonly unlocked: boolean;
}

export interface WeightedEncounter {
    readonly pokemonId: number;
    readonly weight: number;
}

export interface UniformCombatRoute extends RouteDefinition { readonly encounters?: never }
export interface WeightedCombatRoute extends RouteDefinition { readonly encounters: readonly WeightedEncounter[] }
export type CombatRoute = UniformCombatRoute | WeightedCombatRoute;

interface ScenarioDefinition {
    readonly initialLocation: RouteReference;
    readonly clickAttackDamage: number;
    readonly clickAttacksAllowed: boolean;
    readonly initialPokeballs: number;
}

/** Resolved session inputs. Unversioned scenarios retain their original uniform selection. */
export type CombatScenario = ScenarioDefinition & (
    { readonly formatVersion?: never; readonly routes: readonly UniformCombatRoute[] }
    | { readonly formatVersion: 2; readonly routes: readonly WeightedCombatRoute[] }
    | { readonly formatVersion: 3; readonly routes: readonly WeightedCombatRoute[]; readonly spawnRules: SpawnRules }
    | { readonly formatVersion: 4; readonly routes: readonly WeightedCombatRoute[]; readonly spawnRules: SpawnRules; readonly party: PartyDefinition }
);

export type RandomStep = (state: number) => Readonly<{ state: number; value: number }>;
export type Entity = number;
export interface Health { current: number; maximum: number }
export interface Encounter { definition: OpponentDefinition; location: RouteReference; sample?: SpawnSample }
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
    party?: PartyState;
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
    commandSequence: number;
    commandAtMs: number;
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
