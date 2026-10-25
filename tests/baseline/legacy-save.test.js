import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import ts from 'typescript';
import * as ko from 'knockout';
import * as GameConstants from '../../src/modules/GameConstants';
import GameHelper from '../../src/modules/GameHelper';
import * as PokemonHelper from '../../src/modules/pokemons/PokemonHelper';
import { pokemonMap } from '../../src/modules/pokemons/PokemonList';
import { levelRequirements } from '../../src/modules/party/LevelType';
import Wallet from '../../src/modules/wallet/Wallet';
import SaveSelector from '../../src/modules/SaveSelector';

// Execute the actual legacy global-script classes, without booting App or
// running its timers. Only peripheral services are supplied by this harness.
const directory = path.dirname(fileURLToPath(import.meta.url));
const scripts = ['Save.ts', 'Player.ts', 'party/PartyPokemon.ts', 'party/Party.ts', 'pokeballs/Pokeball.ts', 'pokeballs/Pokeballs.ts'];
const source = scripts.map(file => readFileSync(path.resolve(directory, '../../src/scripts', file), 'utf8')).join('\n');
const compiled = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None },
}).outputText;

function hydrate(fixture) {
    const storage = new Map();
    const game = { challenges: { list: { slowEVs: { active: ko.observable(false) } } }, badgeCase: { maxLevel: () => 100 } };
    const pokemonFactory = {};
    const context = {
        ko, GameConstants, GameHelper, pokemonMap, levelRequirements,
        PokemonHelper: { ...PokemonHelper, displayName: name => name },
        App: { game },
        PokemonFactory: pokemonFactory,
        ItemList: {},
        TownList: { 'Pallet Town': { name: 'Pallet Town' }, 'New Bark Town': { name: 'New Bark Town' } },
        MapHelper: { validRoute: () => true },
        SubRegions: { getSubRegionById: () => ({}) },
        window: { location: { origin: 'https://example.invalid' } },
        Notifier: { notify: () => { throw new Error('Unexpected notification in save fixture'); } },
        AchievementHandler: { toJSON: () => [] },
        Settings: { toJSON: () => structuredClone(fixture.settings) },
        localStorage: { setItem: (key, value) => storage.set(key, value), getItem: key => storage.get(key) ?? null },
        MultiRequirement: class {},
        RouteKillRequirement: class {},
        TemporaryBattleRequirement: class {},
        AttackBonusHeldItem: class {},
        HybridAttackBonusHeldItem: class {},
        HeldItem: class {},
    };
    // Use the same realm as Knockout: its serializer recognizes arrays with instanceof.
    // Only repository source is compiled here; fixture JSON is never executed.
    const { Save, Player, PartyPokemon, Party, Pokeballs } = new Function(
        ...Object.keys(context), `${compiled}\nreturn { Save, Player, PartyPokemon, Party, Pokeballs };`,
    )(...Object.values(context));
    const pokemon = [];
    pokemonFactory.generatePartyPokemon = id => {
        const data = PokemonHelper.getPokemonById(id);
        const instance = new PartyPokemon(id, data.name, [], data.attack, data.eggCycles, false, 0, GameConstants.ShadowStatus.None);
        pokemon.push(instance);
        return instance;
    };
    // Only Party's persistence methods are exercised; avoid its UI/combat computations.
    const party = Object.assign(Object.create(Party.prototype), { saveKey: 'party', _caughtPokemon: ko.observableArray([]) });
    const wallet = new Wallet({ getBonus: () => 1 });
    const pokeballs = new Pokeballs();
    wallet.fromJSON(fixture.save.wallet);
    party.fromJSON(fixture.save.party);
    pokeballs.fromJSON(fixture.save.pokeballs);
    Object.assign(game, {
        wallet, party, pokeballs,
        update: { saveKey: 'update', toJSON: () => structuredClone(fixture.save.update) },
    });
    const player = new Player(fixture.player);
    const dispose = () => {
        for (const owner of [player, ...pokemon]) {
            Object.values(owner).forEach(value => value?.dispose?.());
        }
    };
    return { Save, player, party, wallet, pokeballs, storage, game, dispose };
}

for (const name of ['starter-route', 'progressed-route', 'empty-town']) {
    describe(`synthetic legacy save: ${name}`, () => {
        const fixtureText = readFileSync(path.resolve(directory, '../fixtures/legacy-saves', `${name}.json`), 'utf8');

        it('round-trips the selected modules and player fields through existing serializers', () => {
            const fixture = JSON.parse(fixtureText);
            const before = structuredClone(fixture);
            const loaded = hydrate(fixture);
            try {
                expect(JSON.parse(JSON.stringify(loaded.player))).toEqual(fixture.player);
                expect(JSON.parse(JSON.stringify(loaded.Save.getSaveObject()))).toEqual(fixture.save);
                expect(fixture).toEqual(before);
                expect(loaded.wallet.currencies.length).toBe(GameHelper.enumLength(GameConstants.Currency));
                expect(loaded.pokeballs.pokeballs.length).toBe(GameHelper.enumNumbers(GameConstants.Pokeball).filter(id => id >= 0).length);
            } finally {
                loaded.dispose();
            }
        });

        it('preserves the export envelope through the actual Unicode-aware save codec', () => {
            const encoded = SaveSelector.btoa(fixtureText);
            expect(SaveSelector.atob(encoded)).toBe(fixtureText);
            expect(JSON.parse(SaveSelector.atob(encoded))).toEqual(JSON.parse(fixtureText));
        });

        it('uses separate legacy storage keys and excludes state without a saveKey', () => {
            const fixture = JSON.parse(fixtureText);
            const loaded = hydrate(fixture);
            try {
                loaded.storage.set('original-backup', fixtureText);
                loaded.game.transientBattle = { remainingCaptureMs: 200, enemyHealth: 0 };
                loaded.Save.key = '-fixture';
                loaded.Save.store(loaded.player);
                expect(JSON.parse(loaded.storage.get('player-fixture'))).toEqual(fixture.player);
                expect(JSON.parse(loaded.storage.get('save-fixture'))).toEqual(fixture.save);
                expect(JSON.parse(loaded.storage.get('settings-fixture'))).toEqual(fixture.settings);
                expect(loaded.storage.get('original-backup')).toBe(fixtureText);
                expect([...loaded.storage.keys()]).toEqual(['original-backup', 'player-fixture', 'save-fixture', 'settings-fixture']);
            } finally {
                loaded.dispose();
            }
        });
    });
}

it('records legacy rounding of fractional attack bonuses without truncating form IDs', () => {
    const fixture = JSON.parse(readFileSync(path.resolve(directory, '../fixtures/legacy-saves/progressed-route.json'), 'utf8'));
    fixture.save.party.caughtPokemon[0]['0'] = 12.5;
    const loaded = hydrate(fixture);
    try {
        const saved = JSON.parse(JSON.stringify(loaded.Save.getSaveObject()));
        expect(saved.party.caughtPokemon[0]['0']).toBe(13);
        expect(saved.party.caughtPokemon[1].id).toBe(19.01);
        expect(fixture.save.party.caughtPokemon[0]['0']).toBe(12.5);
    } finally {
        loaded.dispose();
    }
});
