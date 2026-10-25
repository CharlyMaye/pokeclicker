# Headless route combat

`RouteCombatSimulation` handles route combat's automatic and click attacks, defeat rewards, timed capture and the next opponent without a browser, display or wall clock. [Route transitions](route-transitions.md) extend the original fixed-route slice with same-region movement and source-route progression. It is not activated in the legacy game.

## Ownership and ECS structure

Numeric entity IDs identify encounters, independently of Pokémon catalog IDs. `Health`, `Encounter` and `Capture` are plain data components in separate maps. Attack, defeat, capture and spawn functions operate on those components. Defeat and capture systems select affected entities before adding or removing components. Exactly one active opponent must remain after a successful advance; its entity ID changes on respawn.

Validated configuration, the resolved route scenario, time, command queue, random state and accumulated progress are world resources. The simulation class owns their lifecycle and exposes detached, frozen projections. Systems do not import legacy modules or runtime adapters. Strict TypeScript excludes DOM and Node globals; lint also rejects browser timers, ambient randomness and runtime/legacy imports.

This specialized map implementation is a provisional choice for the one-opponent slice. It keeps ordering and state copying explicit without a generic ECS framework. It does not establish a performance advantage over an ECS library. Reassess storage, queries and copying when representative entity counts and performance budgets exist.

## Resolved inputs

The caller supplies a session identifier, configuration, scenario and nonzero unsigned 32-bit seed. The scenario contains an initial location, unique route definitions, click damage/availability and initial ball count. Each route supplies a location, resolved unlock flag and a nonempty list of unique opponents. Each opponent supplies health, resolved automatic damage, money/experience/token rewards, capture probability and duration. The synthetic scenarios live in `tests/fixtures/simulation/`; they are not the production Pokémon catalog format.

Opponent selection is uniform over the selected route's list. The engine enforces supplied unlock flags but does not yet calculate eligibility from progression, type effectiveness, party attack, multipliers or ball selection. Values are validated and copied at entry. Missing or invalid data fails startup without hidden defaults.

The default RNG is xorshift32. Each spawn consumes one draw, even for a single opponent; each completed capture consumes another. An injected RNG must be a pure function of the supplied state, returning a valid next state and a finite value in `[0, 1)`. Reproducibility requires identical engine/configuration/scenario versions, seed and timestamped commands. Host-side effects inside an injected function cannot be rolled back.

## Time and ordering

`advanceTo(targetMs)` accepts absolute monotonic session time and processes complete configured steps. Within a step, it preserves exact input timestamps and capture deadlines rather than rounding them to a tick. At the same timestamp, processing is:

1. Resolve a pending capture and spawn the next opponent.
2. Process commands in sequence order.
3. Run the automatic tick if this is a step boundary.

This is an explicit deterministic rule, tested against the legacy methods under the same ordering. It does not claim to reproduce every possible browser callback race.

The selected compatibility rules include two valid clicks 50 ms apart within a 100 ms step, consuming click cooldown even without a living target, and resetting the automatic attack counter on spawn. Capture time is independent of display reads. Capture success preserves the legacy `draw <= probability` comparison, including its exact-zero edge case. A new session starts with a last-click time of zero, so its first click must satisfy the configured cooldown.

Defeat grants money and experience immediately and increments defeats. An available ball is consumed when capture begins; successful capture grants tokens and increments the captured count. These are prototype-owned totals, not writes to the legacy wallet or party. Events report outcomes and do not independently award rewards.

Commands must be contiguous, nondecreasing in time and within the configured future horizon. Once a step commits, a new command at or before that committed time is late. A rejected submission does not consume its sequence. `ChangeRoute` applies to known, unlocked routes in the current region, reports `route-unchanged` for the current selection, and reports `route-unavailable` for unknown, locked or cross-region destinations. A pending capture retains its source encounter until its deadline; the next opponent uses the latest selection.

## Bounds and failures

`public/config/simulation.json` supplies the processing limits. Schema version 2 introduced the engine limits; version 3 adds the [direct host's output capacity](independent-loops.md). Older versions are rejected. Generated types, validators and the hashed asset release are updated together. Combat configuration and the message protocol remain at version 1.

| Setting | Initial value | Behavior |
| --- | --- | --- |
| `maxStepsPerAdvance` | 100 | Stop this call after this many fixed steps. |
| `maxQueuedCommands` | 256 | Reject excess submissions; retry after draining with a valid timestamp. |
| `maxTransitionsPerStep` | 512 | Fault if command/deadline/tick processing exceeds this budget. |
| `maxCommandLeadMs` | 10000 | Reject commands scheduled too far beyond committed time. |

These are explicit initial safety limits, not measured performance targets. `remainingMs` reports all unprocessed time, including a partial step. The host must retain that debt and explicitly advance again. This mechanism does not implement offline progression or decide how to account for long absences.

Each advance works on a copy and commits the entire call only after processing and snapshot validation succeed. A processing failure preserves the previous components, rewards, pending commands and RNG state, records a `SimulationFault`, and stops further mutation. Existing projections remain readable. This prevents a partial reward update or an undelivered earlier event from being committed during a failed call. Expected input errors reject only that operation. Reentrant mutation is rejected.

## Evidence and remaining work

Engine tests cover timing, seeded replay, batching versus incremental advances, independent display sampling, immutable outputs, queue saturation, arithmetic overflow, invalid random output and fault rollback. Differential tests execute the real legacy battle methods for a controlled opponent with no balls, successful capture and failed capture. They compare health, capture phase, inventory consumption, click/defeat counts, money, experience and captured IDs at each fixed step.

The full migration acceptance criterion remains open: gems, quests, breeding, items, multipliers and other indirect effects still need ownership and parity coverage. Cross-region travel, production data resolution, persistence, offline rewards, the worker, renderer adapters and live-game activation are separate work. New save import remains inactive. The [route-transition comparison](route-transitions.md#compatibility-evidence) records a known difference in the legacy spawn marker that requires a compatibility decision before live activation.
