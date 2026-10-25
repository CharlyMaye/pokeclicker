import { COMBAT_PROTOCOL_VERSION, RouteReference } from '../../contracts/combat-protocol';
import { CombatWorld, CommandOutcome, RandomStep, StepOutput } from './model';
import { selectOpponent } from './encounters';
import { findRoute, routeKey, sameRoute } from './routes';
import { add, validateRandomState } from './validation';

function draw(world: CombatWorld, random: RandomStep): number {
    const result = random(world.randomState);
    const state = validateRandomState(result.state);
    if (!Number.isFinite(result.value) || result.value < 0 || result.value >= 1) {
        throw new Error('Random source must return a finite value in [0, 1)');
    }
    world.randomState = state;
    return result.value;
}

export function spawnEnemy(world: CombatWorld, random: RandomStep): void {
    if (world.encounters.size !== 0) {
        throw new Error('Cannot spawn over an existing encounter');
    }
    const definition = selectOpponent(world.selectedRoute, draw(world, random));
    const entity = world.nextEntity;
    world.nextEntity = add(entity, 1, 'next entity');
    world.health.set(entity, { current: definition.health, maximum: definition.health });
    world.encounters.set(entity, { definition, location: world.selectedRoute.location });
    world.autoElapsedMs = 0;
}

function removeEnemy(world: CombatWorld, entity: number): void {
    world.health.delete(entity);
    world.encounters.delete(entity);
    world.captures.delete(entity);
}

function eventHeader(world: CombatWorld) {
    world.eventSequence = add(world.eventSequence, 1, 'event sequence');
    return { protocolVersion: COMBAT_PROTOCOL_VERSION, sessionId: world.sessionId, sequence: world.eventSequence, atMs: world.atMs } as const;
}

function encounterFor(world: CombatWorld, entity: number) {
    const encounter = world.encounters.get(entity);
    if (!encounter) {
        throw new Error('Missing encounter component');
    }
    return encounter;
}

function progressFor(world: CombatWorld, location: RouteReference) {
    const key = routeKey(location);
    let progress = world.progress.routes.get(key);
    if (!progress) {
        progress = { location, defeats: 0, captures: 0 };
        world.progress.routes.set(key, progress);
    }
    return progress;
}

export function settleDefeats(world: CombatWorld, random: RandomStep, output: StepOutput): void {
    // Query first; structural changes happen after that selection is complete.
    const defeated = [...world.health].filter(([entity, health]) => health.current === 0 && !world.captures.has(entity));
    for (const [entity] of defeated) {
        const { definition, location } = encounterFor(world, entity);
        world.progress.money = add(world.progress.money, definition.moneyReward, 'money');
        world.progress.experience = add(world.progress.experience, definition.experienceReward, 'experience');
        world.progress.defeats = add(world.progress.defeats, 1, 'defeats');
        const routeProgress = progressFor(world, location);
        routeProgress.defeats = add(routeProgress.defeats, 1, 'route defeats');
        output.events.push(Object.freeze({ ...eventHeader(world), type: 'EnemyDefeated', encounterId: entity, pokemonId: definition.pokemonId }));
        if (world.pokeballs > 0) {
            world.pokeballs--;
            world.captures.set(entity, { resolvesAtMs: add(world.atMs, definition.captureDurationMs, 'capture deadline') });
        } else {
            removeEnemy(world, entity);
            spawnEnemy(world, random);
        }
    }
}

export function resolveCaptures(world: CombatWorld, random: RandomStep, output: StepOutput): void {
    const due = [...world.captures].filter(([, capture]) => capture.resolvesAtMs === world.atMs);
    for (const [entity] of due) {
        const { definition, location } = encounterFor(world, entity);
        // Preserve Rand.chance's inclusive comparison, including an exact zero draw.
        const caught = draw(world, random) <= definition.captureProbability;
        if (caught) {
            const count = world.progress.captured.get(definition.pokemonId) ?? 0;
            world.progress.captured.set(definition.pokemonId, add(count, 1, 'capture count'));
            world.progress.dungeonTokens = add(world.progress.dungeonTokens, definition.dungeonTokenReward, 'dungeon tokens');
            const routeProgress = progressFor(world, location);
            routeProgress.captures = add(routeProgress.captures, 1, 'route captures');
        }
        output.events.push(Object.freeze({ ...eventHeader(world), type: 'CaptureResolved', encounterId: entity, pokemonId: definition.pokemonId, caught }));
        removeEnemy(world, entity);
        spawnEnemy(world, random);
    }
}

export function processCommand(world: CombatWorld, random: RandomStep, output: StepOutput): void {
    const command = world.commands.shift();
    if (!command) {
        throw new Error('Missing command at a scheduled command boundary');
    }
    let result: CommandOutcome['result'];
    if (command.type === 'ChangeRoute') {
        result = changeRoute(world, command.destination, random);
    } else if (!world.scenario.clickAttacksAllowed) {
        result = 'disabled';
    } else if (world.atMs - world.lastClickAtMs < world.configuration.combat.clickAttackCooldownMs) {
        result = 'cooldown';
    } else {
        world.lastClickAtMs = world.atMs;
        result = 'no-target';
        for (const [entity, health] of world.health) {
            if (health.current > 0 && world.encounters.has(entity)) {
                health.current = Math.max(0, health.current - world.scenario.clickAttackDamage);
                world.progress.clickAttacks = add(world.progress.clickAttacks, 1, 'click attacks');
                result = 'applied';
            }
        }
        settleDefeats(world, random, output);
    }
    output.commands.push(Object.freeze({ sequence: command.sequence, atMs: command.atMs, result }));
}

function changeRoute(world: CombatWorld, destination: RouteReference, random: RandomStep): CommandOutcome['result'] {
    if (sameRoute(world.selectedRoute.location, destination)) {
        return 'route-unchanged';
    }
    const route = findRoute(world.scenario.routes, destination);
    // Region travel also owns town/ship state and pending captures; it is a separate feature.
    if (!route?.unlocked || destination.region !== world.selectedRoute.location.region) {
        return 'route-unavailable';
    }
    world.selectedRoute = route;
    if (world.captures.size === 0) {
        for (const entity of [...world.encounters.keys()]) {
            removeEnemy(world, entity);
        }
        spawnEnemy(world, random);
    }
    return 'applied';
}

export function automaticAttack(world: CombatWorld, random: RandomStep, output: StepOutput): void {
    world.autoElapsedMs = add(world.autoElapsedMs, world.configuration.simulation.stepMs, 'automatic attack counter');
    if (world.autoElapsedMs < world.configuration.combat.autoAttackIntervalMs) {
        return;
    }
    world.autoElapsedMs = 0;
    for (const [entity, health] of world.health) {
        const encounter = world.encounters.get(entity);
        if (encounter && health.current > 0) {
            health.current = Math.max(0, health.current - encounter.definition.autoAttackDamage);
        }
    }
    settleDefeats(world, random, output);
}

/** Resolve deadlines, then ordered inputs, then the fixed-step automatic tick. */
export function stepCombat(world: CombatWorld, random: RandomStep, output: StepOutput): void {
    const endMs = add(world.atMs, world.configuration.simulation.stepMs, 'step deadline');
    let transitions = 0;
    const spend = () => {
        if (++transitions > world.configuration.simulation.maxTransitionsPerStep) {
            throw new Error('Per-step transition budget exceeded');
        }
    };
    while (true) {
        const captureAt = Math.min(...[...world.captures.values()].map(capture => capture.resolvesAtMs));
        const commandAt = world.commands[0]?.atMs ?? Infinity;
        const nextAt = Math.min(endMs, captureAt, commandAt);
        if (nextAt < world.atMs) {
            throw new Error('Encountered a deadline in committed time');
        }
        world.atMs = nextAt;
        if (captureAt === nextAt) {
            spend();
            resolveCaptures(world, random, output);
        }
        while (world.commands[0]?.atMs === nextAt) {
            spend();
            processCommand(world, random, output);
        }
        if (nextAt === endMs) {
            spend();
            automaticAttack(world, random, output);
            world.steps = add(world.steps, 1, 'step count');
            return;
        }
    }
}
