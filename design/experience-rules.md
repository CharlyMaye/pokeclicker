# Route experience preparation and party grant planning

The experience milestone derives the existing combat experience reward from production catalog yields and route levels. It also provides a pure plan for one party grant, preserving individual held-item multipliers, level-cap behavior and shadow purification accounting. It does not yet transfer ownership of party levels, evolution or purification state to ECS.

## Public policy and formulas

`public/config/experience.json`, schema version 1, requires `routeLevelScale`, `routeLevelExponentDivisor`, `experienceDivisor` and `trainerMultiplier`. Every coefficient is finite and positive. Runtime and build tools share the parser; missing/unknown fields and unsupported versions fail. There are no hidden gameplay defaults.

Route level preserves `PokemonFactory.routeLevel` operation order:

```text
floor(routeLevelScale * normalizedRoute^(1 / routeLevelExponentDivisor))
```

The shared experience amount preserves `Party.gainExp` order:

```text
floor(baseExperience * level * trainerBonus * multiplier / experienceDivisor)
```

`trainerBonus` is the configured trainer multiplier for trainer battles, otherwise the multiplicative identity. The route adapter explicitly uses non-trainer encounters. Intermediate overflow and unsafe final integer rewards fail preparation. Individual held-item bonuses are applied after this floor, not folded into the global multiplier.

The policy participates in the generated release manifest and canonical/versioned publication. `loadExperiencePolicy` retrieves its pinned bytes beneath the deployment subpath using the existing integrity, size, cancellation and timeout safeguards. The existing two-policy route loader and three-document lab loader keep their request sets. All policies come from the same bundled release manifest.

## Production preparation

`prepareLegacyExperienceSession` accepts `registry`, `pokemonList`, `session`, `healthPolicy`, `encounterPolicy` and `experiencePolicy`. Its session input is version 2. It has the same route, eligibility and inventory shape as the [historical route adapter](legacy-route-adapter.md), but opponent profiles require `experienceMultiplier` instead of `experienceReward`.

The adapter obtains normalized route positions from the complete historical registry and base experience from each selected species' raw catalog `exp` property. That base yield is not itself a reward. It computes route level and shared reward, then uses the existing sampled preparation pipeline. Every selected route's catalog species needs a profile, including unavailable species; their yields and multipliers are validated too. Unrelated catalog species such as MissingNo. are not treated as encounter opponents. Relevant accessor properties and ambiguous referenced IDs fail without invoking game methods.

Existing version 1 manual-reward preparation stays available and unchanged. The new input contract has its own explicit function and rejects mixing manual rewards with derived multipliers. Its output remains combat scenario version 3 and combat checkpoint version 2. No simulation protocol or save format changes are needed.

The simulation credits each defeat's shared amount once to its existing aggregate `experience` field. For these prepared scenarios, that aggregate is the cumulative amount *before individual party bonuses and caps*. It is not the sum of stored experience across the party. Save/restore retains the prepared amounts, and requires no catalog access. Re-preparation that changes effective amounts fails normal scenario compatibility checks until an explicit migration is provided.

## Grant planning and ownership

`planExperienceGrant(sharedExperience, members)` accepts explicit recipient snapshots containing `pokemonId`, `level`, `maxLevel`, `multiplier` and boolean `shadow`. It returns immutable `members` records (`pokemonId`, `calculated`, `stored`) plus `shadowExperience`:

- `calculated` is the shared amount multiplied by the recipient bonus, retaining fractional values.
- `stored` equals that amount only when the recipient starts below its level cap; otherwise it is zero. A member already above a reduced cap is also capped.
- `shadowExperience` sums calculated amounts for shadow recipients, including capped members. This reproduces the legacy return-value behavior of `PartyPokemon.gainExp` and `Party.gainExp`. This is the experience input to `PurifyChamber.gainFlow`, not the final chamber flow: its requirement checks, flute bonus, conversion, rounding and cap are outside the planner.

The planner neither changes balances nor advances levels, evolves Pokémon, consumes bonuses or calls purification services. In particular, it does not clip a grant to the experience needed to reach the cap: the historical method checks the cap before adding the full grant. A future owner must apply each defeat in order, update levels/evolution, and obtain a new recipient snapshot before the next grant. Aggregating several defeats into one grant can change cap behavior and is not supported as an equivalent shortcut.

The caller must supply all intended recipients and resolve the historical shadow-status predicate. This planner does not filter by active party or breeding status; the legacy party method visits all caught Pokémon. Duplicate IDs, invalid fields, negative bonuses and overflow (including shadow-flow summation) reject the entire plan without mutating inputs. Returned plans are calculations, not events to apply repeatedly; idempotent effect delivery belongs to the future ownership bridge.

The new adapter uses session-snapshot global experience bonuses. Dynamic bonus changes, actual party components/level curves, purification ownership, evolution, breeding and the other indirect defeat effects remain migration work. The live game and default lab configuration are not activated or rebalanced by this milestone.

## Validation

Tests compare every shipped route's level against the real factory and every eligible production species reward against the real party method with controlled bonuses. Grant tests execute actual `Party.gainExp`, `PartyPokemon.gainExp` and held-item multiplier logic across trainer flags, yields, levels and multipliers, including capped shadow recipients. Level calculation and evolution are stubbed in those grant tests because their ownership is outside this change.

Boundary tests cover policies, profiles, inactive inputs, accessors, fractional grants, overflow, checkpoint compatibility and repeated-defeat replay. The emitted-worker suite saves, terminates and restores a session with derived experience, then compares output against direct combat. Configuration tests cover pinned loading, release identity and build rejection.

Review rounding order, the aggregate's meaning, capped shadow flow, strict version 2 preparation inputs and the remaining ownership boundary. Passing CI does not replace maintainer review.
