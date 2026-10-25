# First migration slice: route combat baseline and configuration

This slice starts stage 1 of the [technical redesign](technical-redesign.md). It adds executable characterization tests and publishes the first configuration files. The existing game still uses its original constants; the new engine is not active. Save fixtures, simulation contracts and the rest of stage 1 remain future work. Runtime loading is now described in [Runtime configuration loading](runtime-configuration.md).

## Configuration boundary

| File | Baseline | Source |
| --- | --- | --- |
| `public/config/simulation.json` | `stepMs: 100` | `GameConstants.TICK_TIME` |
| `public/config/combat.json` | `autoAttackIntervalMs: 1000` | `GameConstants.BATTLE_TICK` |
| `public/config/combat.json` | `clickAttackCooldownMs: 50` | `Battle.clickAttack` |

The draft-07 JSON schemas in `schemas/` define the permitted shape, required fields, integer ranges and supported version. Ajv runs in strict mode without coercion, defaults or removal of unknown properties. Files are limited to 64 KiB. Only explicitly registered configuration files are accepted, so adding a JSON file requires a schema and validator registration.

For this legacy-compatible baseline, the automatic attack interval must be a multiple of the simulation step. The click cooldown may be shorter than the step. Do not turn it into one click per tick: timestamped commands are needed in the future engine.

`tools/configuration.cjs` is a build-time boundary, not a simulation dependency. It returns detached, frozen settings (the initial schemas contain only scalar properties). The schemas are the source of truth for configuration structure. The runtime configuration slice now generates types and validators from them and checks for drift in CI. Nested settings will also require recursive immutability.

`gulp public` validates before copying `public/**` into `build/`. Restart the development server after editing schemas or validation tooling. Normal builds run it first, and `gulp website` copies the result into `docs/`. The deployed files therefore live at `/pokeclicker/config/*.json`. The publication check compares emitted bytes with source and serves them at that project subpath. It does not claim to test a runtime loader that does not yet exist.

The runtime loader now checks a consistent code/data version before returning typed settings. Connecting it to startup and presenting errors in the browser remain work for the new host, before these settings control gameplay.

## Characterized behavior

The tests execute the existing `Battle` and `BattlePokemon` attack, damage, defeat and capture scheduling methods with synthetic encounters and controlled time/RNG. They replace external services and enemy generation, not the rules under characterization.

- Automatic attacks use both enemy types and reset the battle counter.
- Clicks at 49 ms are rejected; clicks at 50 ms and 100 ms are both accepted.
- A click without a living target still consumes the cooldown. This is existing behavior, not a new design decision.
- The no-click challenge permits the starter encounter and blocks later clicks.
- Overkill clamps health to zero. Repeated attacks against the same defeated target do not grant another reward.
- Defeat credits money, experience, gems, route kills and egg progress. With no ball, spawning precedes item-drop processing and multiplier decay.
- With a ball, rewards occur immediately, one ball is consumed, and capture resolves at the catch deadline before spawning. Success and failure both clear capture state.
- Clearing the route marker during a region change suppresses the old route's spawn; capture retains the original route and region.

These are focused method-level baselines. Full game-loop scheduling, catalog generation, held-item drops, capture inventory/effort-point effects, offline rewards, save import and cross-feature idempotency still need their own scenarios. A behavior found undesirable should be changed explicitly, with a separate balance/compatibility decision.

## Checks

- `npm run test:refactor`: schema/business validation tests and legacy combat characterization.
- `gulp public && gulp copyWebsite && node tools/check-published-config.cjs docs`: publication and Pages subpath check.
- Existing build, lint and legacy tests remain in CI.

No saved player data is read or modified by these tests.
