# Synthetic legacy save extracts

These JSON files are authored test data for the fork at legacy version `0.10.26`. They are not user exports or complete playable saves. Omitted modules must not be interpreted as proof that their migration is covered.

| Fixture | Purpose |
| --- | --- |
| `starter-route.json` | Initial region/route, starter Pokémon, default numeric progress fields and Poké Balls. |
| `progressed-route.json` | Region/route change, nonzero currencies and ball quantities, numeric Pokémon progress keys, a fractional form ID, Unicode nickname and percent sign. |
| `empty-town.json` | Town location (`route: 0`), empty party/inventory and an older last-seen timestamp. |

`tests/baseline/legacy-save.test.js` checks these extracts through the existing serializers and export codec. Peripheral services are controlled, and storage is an in-memory map. The test never writes to a player's browser storage.

Relevant legacy sources:

- `src/scripts/Save.ts`: export envelope, feature collection and storage keys.
- `src/scripts/Player.ts`: player fields and pruning of default/empty entries.
- `src/scripts/party/Party.ts` and `PartyPokemon.ts`: caught Pokémon and numbered progress fields.
- `src/modules/wallet/Wallet.ts`: currency array order.
- `src/scripts/pokeballs/Pokeballs.ts`: quantities indexed by ball type.
- `src/modules/SaveSelector.ts`: Unicode-aware Base64 encoding.

Do not add synthetic active enemies, capture deadlines or RNG fields to these legacy fixtures: the current exporter does not save them. A new-engine save format will need its own versioned fixtures.
