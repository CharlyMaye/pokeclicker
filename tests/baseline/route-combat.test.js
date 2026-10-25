import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as ko from 'knockout';
import Battle from '../../src/modules/battles/Battle';
import BattlePokemon from '../../src/modules/battles/BattlePokemon';
import * as GameConstants from '../../src/modules/GameConstants';
import PokemonType from '../../src/modules/enums/PokemonType';
import Rand from '../../src/modules/utilities/Rand';
import combat from '../../public/config/combat.json';
import simulation from '../../public/config/simulation.json';

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
