import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import ts from 'typescript';
import * as ko from 'knockout';
import Battle from '../../src/modules/battles/Battle';
import BattlePokemon from '../../src/modules/battles/BattlePokemon';
import * as GameConstants from '../../src/modules/GameConstants';
import PokemonType from '../../src/modules/enums/PokemonType';
import Rand from '../../src/modules/utilities/Rand';
import combat from '../../public/config/combat.json';
import simulation from '../../public/config/simulation.json';
import { RouteCombatSimulation } from '../../src/simulation/combat/RouteCombatSimulation';
import routeScenario from '../fixtures/simulation/route-combat.json';
import transitionScenario from '../fixtures/simulation/route-transitions.json';

// Execute the real global-script MapHelper against controlled route availability.
const directory = path.dirname(fileURLToPath(import.meta.url));
const mapSource = readFileSync(path.resolve(directory, '../../src/scripts/worldmap/MapHelper.ts'), 'utf8');
const compiledMap = ts.transpileModule(mapSource, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None },
}).outputText;

function mapHelper() {
    const context = {
        Battle, GameConstants, player, App: { game },
        Routes: { getRoute: (region, route) => {
            const entry = transitionScenario.routes.find(value => value.location.region === region && value.location.route === route);
            return entry && { isUnlocked: () => entry.unlocked };
        } },
        Notifier: { notify: () => { throw new Error('Unexpected notification in route fixture'); } },
    };
    return new Function(...Object.keys(context), `${compiledMap}\nreturn MapHelper;`)(...Object.values(context));
}

// Synthetic route encounter. Use real damage/defeat methods without depending
// on translated display names or the full Pokemon catalog constructor.
function encounter(health = 30) {
    return Object.assign(Object.create(BattlePokemon.prototype), {
        id: 16,
        name: 'Pidgey',
        type1: PokemonType.Normal,
        type2: PokemonType.Flying,
        health: ko.observable(health),
        maxHealth: ko.observable(health),
        healthPercentage: ko.observable(100),
        level: 2,
        exp: 12,
        reward: { amount: 10, currency: GameConstants.Currency.money },
        gemReward: 1,
        catchRate: 50,
        shiny: false,
        shadow: GameConstants.ShadowStatus.None,
        incrementDefeatedStatistic: false,
    });
}

let game;
let enemy;
let order;

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(10000);
    order = [];
    game = {
        challenges: { list: { disableClickAttack: { active: () => false } } },
        statistics: { clickAttacks: ko.observable(0), routeKills: [[ko.observable(0), ko.observable(0)]] },
        party: {
            calculatePokemonAttack: vi.fn(() => 10),
            calculateClickAttack: vi.fn(() => 10),
            gainExp: vi.fn(() => order.push('experience')),
            alreadyCaughtPokemon: () => true,
        },
        wallet: { addAmount: vi.fn(() => order.push('money')) },
        gems: { gainGems: vi.fn() },
        breeding: { progressEggsBattle: vi.fn(() => order.push('eggs')) },
        pokeballs: {
            calculatePokeballToUse: () => GameConstants.Pokeball.None,
            calculateCatchTime: () => 200,
            getCatchBonus: () => 0,
            usePokeball: vi.fn(() => order.push('ball')),
        },
        oakItems: { calculateBonus: () => 0 },
    };
    vi.stubGlobal('App', { game });
    vi.stubGlobal('player', {
        route: 1,
        region: GameConstants.Region.kanto,
        regionStarters: [() => GameConstants.Starter.None],
        lowerItemMultipliers: vi.fn(() => order.push('multipliers')),
    });
    enemy = encounter();
    Battle.enemyPokemon(enemy);
    Battle.lastClickAttack = 10000;
    Battle.counter = 0;
    Battle.route = 1;
    Battle.catching(false);
    Battle.catchRateActual(null);
    Battle.pokeball(GameConstants.Pokeball.Pokeball);
    vi.spyOn(Battle, 'generateNewEnemy').mockImplementation(() => order.push('spawn'));
    vi.spyOn(Battle, 'gainItem').mockImplementation(() => order.push('item'));
});

afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    Battle.enemyPokemon(null);
});

describe('legacy route combat baseline', () => {
    it('keeps JSON defaults aligned with the legacy tick and automatic attack interval', () => {
        expect(simulation.stepMs).toBe(GameConstants.TICK_TIME);
        expect(combat.autoAttackIntervalMs).toBe(GameConstants.BATTLE_TICK);
        Battle.counter = GameConstants.BATTLE_TICK;
        Battle.tick();
        expect(Battle.counter).toBe(0);
        expect(enemy.health()).toBe(20);
        expect(game.party.calculatePokemonAttack).toHaveBeenCalledWith(PokemonType.Normal, PokemonType.Flying);
    });

    it('accepts two clicks 50 ms apart within one 100 ms step, rejecting earlier clicks', () => {
        vi.advanceTimersByTime(combat.clickAttackCooldownMs - 1);
        Battle.clickAttack();
        expect(enemy.health()).toBe(30);
        vi.advanceTimersByTime(1);
        Battle.clickAttack();
        expect(enemy.health()).toBe(20);
        vi.advanceTimersByTime(combat.clickAttackCooldownMs);
        Battle.clickAttack();
        expect(enemy.health()).toBe(10);
        expect(game.statistics.clickAttacks()).toBe(2);
    });

    it('consumes the cooldown even when a click has no living target', () => {
        Battle.enemyPokemon(null);
        vi.advanceTimersByTime(combat.clickAttackCooldownMs);
        Battle.clickAttack();
        Battle.enemyPokemon(enemy);
        Battle.clickAttack();
        expect(enemy.health()).toBe(30);
        vi.advanceTimersByTime(combat.clickAttackCooldownMs);
        Battle.clickAttack();
        expect(enemy.health()).toBe(20);
    });

    it('honors the click challenge after the starter encounter', () => {
        game.challenges.list.disableClickAttack.active = () => true;
        player.regionStarters = [() => GameConstants.Starter.Grass];
        vi.advanceTimersByTime(combat.clickAttackCooldownMs);
        Battle.clickAttack();
        expect(enemy.health()).toBe(30);
        expect(game.statistics.clickAttacks()).toBe(0);
        player.regionStarters = [() => GameConstants.Starter.None];
        Battle.clickAttack();
        expect(enemy.health()).toBe(20);
    });

    it('clamps overkill and grants defeat effects once through the attack entry point', () => {
        game.party.calculatePokemonAttack.mockReturnValue(100);
        Battle.pokemonAttack();
        Battle.pokemonAttack();
        expect(enemy.health()).toBe(0);
        expect(enemy.healthPercentage()).toBe(0);
        expect(game.wallet.addAmount).toHaveBeenCalledExactlyOnceWith(enemy.reward);
        expect(game.party.gainExp).toHaveBeenCalledExactlyOnceWith(12, 2, false);
        expect(game.statistics.routeKills[0][1]()).toBe(1);
        expect(game.gems.gainGems.mock.calls).toEqual([[1, PokemonType.Normal], [1, PokemonType.Flying]]);
        expect(order).toEqual(['money', 'experience', 'eggs', 'spawn', 'item', 'multipliers']);
    });

    it.each([[0.25, true], [0.75, false]])('resolves capture at its deadline (random draw %s)', (draw, caught) => {
        game.pokeballs.calculatePokeballToUse = () => GameConstants.Pokeball.Pokeball;
        game.party.calculatePokemonAttack.mockReturnValue(100);
        vi.spyOn(Rand, 'next').mockReturnValue(draw);
        const capture = vi.spyOn(Battle, 'catchPokemon').mockImplementation(() => order.push('capture'));
        Battle.pokemonAttack();
        expect(Battle.catching()).toBe(true);
        expect(Battle.catchRateActual()).toBe(50);
        expect(order).toEqual(['money', 'experience', 'eggs', 'ball', 'item', 'multipliers']);
        vi.advanceTimersByTime(199);
        expect(Battle.generateNewEnemy).not.toHaveBeenCalled();
        expect(capture).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(capture).toHaveBeenCalledTimes(caught ? 1 : 0);
        if (caught) {
            expect(capture).toHaveBeenCalledWith(enemy, 1, GameConstants.Region.kanto);
        }
        expect(order.at(-1)).toBe('spawn');
        expect(Battle.catching()).toBe(false);
        expect(Battle.catchRateActual()).toBe(null);
        expect(game.wallet.addAmount).toHaveBeenCalledTimes(1);
    });

    it('does not spawn on the old route after the region-change marker is cleared', () => {
        game.pokeballs.calculatePokeballToUse = () => GameConstants.Pokeball.Pokeball;
        vi.spyOn(Rand, 'next').mockReturnValue(0.25);
        const capture = vi.spyOn(Battle, 'catchPokemon').mockImplementation(() => {});
        Battle.defeatPokemon();
        player.region = GameConstants.Region.johto;
        player.route = 29;
        Battle.route = 0;
        vi.advanceTimersByTime(200);
        expect(capture).toHaveBeenCalledWith(enemy, 1, GameConstants.Region.kanto);
        expect(Battle.generateNewEnemy).not.toHaveBeenCalled();
    });
});

describe('headless engine parity with legacy battle methods', () => {
    it.each([[0, 0.25], [2, 0.25], [2, 0.75]])('matches selected effects with %s balls and random draw %s', (balls, draw) => {
        const definition = routeScenario.routes[0].opponents[0];
        let remainingBalls = balls;
        const captured = [];
        game.party.calculatePokemonAttack.mockReturnValue(definition.autoAttackDamage);
        game.party.calculateClickAttack.mockReturnValue(routeScenario.clickAttackDamage);
        game.pokeballs.calculatePokeballToUse = () => remainingBalls > 0 ? GameConstants.Pokeball.Pokeball : GameConstants.Pokeball.None;
        game.pokeballs.calculateCatchTime = () => definition.captureDurationMs;
        game.pokeballs.usePokeball.mockImplementation(() => remainingBalls--);
        vi.spyOn(Rand, 'next').mockReturnValue(draw);
        vi.spyOn(Battle, 'catchPokemon').mockImplementation(target => captured.push(target.id));
        const spawn = () => {
            enemy = encounter(definition.health);
            enemy.catchRate = definition.captureProbability * 100;
            enemy.reward.amount = definition.moneyReward;
            enemy.exp = definition.experienceReward;
            Battle.enemyPokemon(enemy);
            Battle.counter = 0;
        };
        Battle.generateNewEnemy.mockImplementation(spawn);
        spawn();
        const engine = new RouteCombatSimulation('parity', { combat, simulation }, {
            ...routeScenario, initialPokeballs: balls,
        }, 1, state => ({ state: state + 1, value: draw }));
        const inputs = [49, 50, 100, 150, 200, 349, 350, 399];
        inputs.forEach((atMs, index) => engine.submit({ protocolVersion: 1, sessionId: 'parity', sequence: index + 1, atMs, type: 'ClickAttack' }));
        const ticks = Array.from({ length: 40 }, (_, index) => (index + 1) * GameConstants.TICK_TIME);
        const timeline = [...new Set([...inputs, ...ticks])].sort((a, b) => a - b);
        let last = 0;
        for (const atMs of timeline) {
            // Explicit tie order: capture timers, input, then Game.gameTick's battle counter.
            vi.advanceTimersByTime(atMs - last);
            last = atMs;
            if (inputs.includes(atMs)) Battle.clickAttack();
            if (atMs % GameConstants.TICK_TIME === 0) {
                Battle.counter += GameConstants.TICK_TIME;
                if (Battle.counter >= GameConstants.BATTLE_TICK) Battle.tick();
                const result = engine.advanceTo(atMs);
                expect(result.snapshot.encounter.enemy.health).toBe(Battle.enemyPokemon().health());
                expect(result.snapshot.encounter.phase === 'capturing').toBe(Battle.catching());
                expect(engine.progress.pokeballs).toBe(remainingBalls);
                expect(engine.progress.clickAttacks).toBe(game.statistics.clickAttacks());
                expect(engine.progress.defeats).toBe(game.statistics.routeKills[0][1]());
                expect(engine.progress.money).toBe(game.wallet.addAmount.mock.calls.reduce((sum, [reward]) => sum + reward.amount, 0));
                expect(engine.progress.experience).toBe(game.party.gainExp.mock.calls.reduce((sum, [exp]) => sum + exp, 0));
                expect(engine.progress.captured.reduce((sum, entry) => sum + entry.count, 0)).toBe(captured.length);
            }
        }
    });
});

describe('route movement through real legacy MapHelper and Battle methods', () => {
    it.each([[200, 0.25], [200, 0.75], [350, 0.25]])('preserves capture origin when moving at %s ms with draw %s', (moveAt, draw) => {
        const helper = mapHelper();
        const engine = new RouteCombatSimulation('routes-parity', { combat, simulation }, transitionScenario, 1, state => ({ state: state + 1, value: draw }));
        let definition;
        let balls = transitionScenario.initialPokeballs;
        let tokens = 0;
        const captures = [];
        game.statistics.routeKills = [Array.from({ length: 4 }, () => ko.observable(0))];
        game.party.calculatePokemonAttack.mockImplementation(() => definition.autoAttackDamage);
        game.pokeballs.calculatePokeballToUse = () => balls > 0 ? GameConstants.Pokeball.Pokeball : GameConstants.Pokeball.None;
        game.pokeballs.usePokeball.mockImplementation(() => balls--);
        game.pokeballs.calculateCatchTime = () => definition.captureDurationMs;
        vi.spyOn(Rand, 'next').mockReturnValue(draw);
        vi.spyOn(Battle, 'catchPokemon').mockImplementation((target, route, region) => {
            captures.push({ pokemonId: target.id, route, region });
            const source = transitionScenario.routes.find(entry => entry.location.region === region && entry.location.route === route);
            tokens += source.opponents.find(entry => entry.pokemonId === target.id).dungeonTokenReward;
        });
        const spawn = () => {
            definition = transitionScenario.routes.find(entry => entry.location.region === player.region && entry.location.route === player.route).opponents[0];
            enemy = encounter(definition.health);
            enemy.id = definition.pokemonId;
            enemy.catchRate = definition.captureProbability * 100;
            enemy.reward.amount = definition.moneyReward;
            enemy.exp = definition.experienceReward;
            Battle.enemyPokemon(enemy);
            Battle.counter = 0;
        };
        Battle.generateNewEnemy.mockImplementation(spawn);
        spawn();
        const commands = [
            { type: 'ClickAttack', atMs: 50 }, { type: 'ClickAttack', atMs: 100 }, { type: 'ClickAttack', atMs: 150 },
            { type: 'ChangeRoute', atMs: moveAt, destination: { region: 0, route: 2 } },
            { type: 'ChangeRoute', atMs: 450, destination: { region: 0, route: 3 } },
        ];
        commands.forEach((command, index) => engine.submit({ protocolVersion: 1, sessionId: 'routes-parity', sequence: index + 1, ...command }));
        const ticks = Array.from({ length: 120 }, (_, index) => (index + 1) * GameConstants.TICK_TIME);
        const timeline = [...new Set([...commands.map(command => command.atMs), ...ticks])].sort((a, b) => a - b);
        let last = 0;
        for (const atMs of timeline) {
            vi.advanceTimersByTime(atMs - last);
            last = atMs;
            for (const command of commands.filter(value => value.atMs === atMs)) {
                if (command.type === 'ClickAttack') Battle.clickAttack();
                else helper.moveToRoute(command.destination.route, command.destination.region);
            }
            if (atMs % GameConstants.TICK_TIME !== 0) continue;
            Battle.counter += GameConstants.TICK_TIME;
            if (Battle.counter >= GameConstants.BATTLE_TICK) Battle.tick();
            const result = engine.advanceTo(atMs);
            expect(result.snapshot.location).toEqual({ region: player.region, route: player.route });
            expect(result.snapshot.encounter.enemy).toMatchObject({ pokemonId: enemy.id, health: enemy.health() });
            expect(result.snapshot.encounter.phase === 'capturing').toBe(Battle.catching());
            expect(engine.progress).toMatchObject({ pokeballs: balls, dungeonTokens: tokens, clickAttacks: game.statistics.clickAttacks() });
            expect(engine.progress.money).toBe(game.wallet.addAmount.mock.calls.reduce((sum, [reward]) => sum + reward.amount, 0));
            expect(engine.progress.experience).toBe(game.party.gainExp.mock.calls.reduce((sum, [exp]) => sum + exp, 0));
            for (const route of [1, 2, 3]) {
                const progress = engine.progress.routes.find(entry => entry.location.route === route);
                expect(progress?.defeats ?? 0).toBe(game.statistics.routeKills[0][route]());
                expect(progress?.captures ?? 0).toBe(captures.filter(entry => entry.region === 0 && entry.route === route).length);
            }
        }
        if (draw < 0.5) expect(captures[0]).toEqual({ pokemonId: 16, route: 1, region: 0 });
    });

    it('records the legacy last-defeated-route spawn quirk as an explicit compatibility difference', () => {
        const helper = mapHelper();
        Battle.route = 1;
        Battle.generateNewEnemy.mockImplementation(() => {
            enemy = encounter();
            enemy.id = player.route === 2 ? 19 : 16;
            Battle.enemyPokemon(enemy);
        });
        helper.moveToRoute(2, 0);
        helper.moveToRoute(1, 0);
        expect(player.route).toBe(1);
        expect(enemy.id).toBe(19);
        expect(Battle.generateNewEnemy).toHaveBeenCalledTimes(1);
        const engine = new RouteCombatSimulation('routes-difference', { combat, simulation }, transitionScenario, 1);
        [2, 1].forEach((route, index) => engine.submit({ protocolVersion: 1, sessionId: 'routes-difference', sequence: index + 1,
            atMs: (index + 1) * 50, type: 'ChangeRoute', destination: { region: 0, route } }));
        expect(engine.advanceTo(100).snapshot.encounter.enemy.pokemonId).toBe(16);
    });
});
