import type { CombatProgress } from '../../contracts/combat-progress';
import type { CombatSnapshot } from '../../contracts/combat-protocol';
import type { CombatScenario } from '../../simulation/combat/model';
import type { AdvanceResult } from '../../simulation/combat/RouteCombatSimulation';

/** Validate membership and consistency against the initialized session, without granting rewards. */
export function verifySessionProgress(progress: CombatProgress, snapshot: CombatSnapshot, scenario: CombatScenario, eventSequence: number, outcomeSequence: number): void {
    const catalog = new Set(scenario.routes.flatMap(route => route.opponents.map(opponent => opponent.pokemonId)));
    const routes = new Set([...scenario.routes].filter(route => route.unlocked && route.location.region === scenario.initialLocation.region)
        .map(route => `${route.location.region}:${route.location.route}`));
    const attempts = Math.min(progress.defeats, scenario.initialPokeballs);
    const pending = snapshot.encounter.phase === 'capturing' ? 1 : 0;
    const captures = progress.captured.reduce((total, entry) => total + entry.count, 0);
    if (progress.captured.some(entry => !catalog.has(entry.pokemonId))
        || progress.routes.some(entry => !routes.has(`${entry.location.region}:${entry.location.route}`))
        || progress.pokeballs !== scenario.initialPokeballs - attempts || captures > attempts - pending
        || eventSequence !== progress.defeats + attempts - pending || progress.clickAttacks > outcomeSequence) {
        throw new Error('Worker progress disagrees with the session catalog, inventory or stream cursors');
    }
}

/** A complete batch must account for every newly reported defeat and successful capture. */
export function verifyProgressAdvance(previous: CombatProgress, batch: AdvanceResult): void {
    const next = batch.progress;
    const increasing = ['money', 'experience', 'dungeonTokens', 'defeats', 'clickAttacks'] as const;
    if (increasing.some(key => next[key] < previous[key])
        || next.defeats - previous.defeats !== batch.events.filter(event => event.type === 'EnemyDefeated').length) {
        throw new Error('Worker progress regressed or disagrees with defeat events');
    }
    const expected = new Map(previous.captured.map(entry => [entry.pokemonId, entry.count]));
    for (const event of batch.events) {
        if (event.type === 'CaptureResolved' && event.caught) {
            expected.set(event.pokemonId, (expected.get(event.pokemonId) ?? 0) + 1);
        }
    }
    if (expected.size !== next.captured.length || next.captured.some(entry => expected.get(entry.pokemonId) !== entry.count)) {
        throw new Error('Worker capture progress disagrees with capture events');
    }
    const routes = new Map(next.routes.map(entry => [`${entry.location.region}:${entry.location.route}`, entry]));
    if (previous.routes.some(entry => {
        const current = routes.get(`${entry.location.region}:${entry.location.route}`);
        return !current || current.defeats < entry.defeats || current.captures < entry.captures;
    })) {
        throw new Error('Worker route progress regressed');
    }
}
