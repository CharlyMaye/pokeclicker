# Route transitions and progression origin

The headless engine now accepts `ChangeRoute` for an unlocked route in the current region. Location is selected through a command; neither a display nor a mutable player global controls spawning. This remains an isolated simulation with synthetic inputs, not live-game integration.

## Resolved route inputs

The internal scenario format now contains `initialLocation` and `routes` instead of one `location` and `opponents` list. Each route has an exact `{ location, unlocked, opponents }` shape. Locations are unique by region and route; opponent IDs must be unique within each route and may occur on different routes. The initial location must resolve to an unlocked entry. All entries, including unavailable destinations, are validated and copied before startup.

`tests/fixtures/simulation/route-transitions.json` supplies distinct opponent stats, rewards, capture probabilities and durations for the transition scenarios. These are synthetic resolved inputs. A future runtime adapter must derive production eligibility and damage from authoritative game data. The display cannot grant access by submitting opponent definitions or changing an unlock flag; commands contain only the destination identifier. Unlock flags are immutable for this session; dynamic progression unlocks are not implemented yet.

No public configuration, save or message version changes in this slice. The constructor's internal scenario shape changes, and all current consumers are updated. No published content loader or save importer consumes this shape yet.

## Transition rules

| Situation | Outcome |
| --- | --- |
| Destination equals the current selection | `route-unchanged`; keep the opponent, timers and RNG state. |
| Unknown, locked or cross-region destination | `route-unavailable`; keep combat state. |
| Valid move while fighting | Select the destination, remove the living opponent without rewards, and spawn there. |
| Valid move during capture | Select the destination while retaining the defeated source opponent and capture deadline. |
| Capture completes after one or more moves | Resolve the original capture once, then spawn at the latest selected route. |

Movement does not reset click cooldown, refund a consumed ball or duplicate defeat rewards. Spawning resets the automatic attack counter, as in the fixed-route slice. Command order matters: a killing click followed by movement at the same timestamp retains that capture; movement followed by the click attacks the new opponent.

The established tie order remains capture deadlines, commands in sequence, then the automatic tick. At a capture deadline that also contains a move, the completed capture first spawns on the then-current route; movement replaces that living opponent. Both spawns consume a draw. This explicit ordering is reproducible and covered by tests.

## State and progress

The world holds the selected route independently from each encounter's source location. An encounter retains its immutable opponent definition and location through capture. Money, experience, capture probability, duration and token rewards therefore remain attached to that encounter rather than being recalculated from a later destination.

`progress.routes` returns sorted, detached, frozen entries containing a location, defeats and successful captures. Counters accrue to the source route; an abandoned living opponent gives no credit. These remain simulation-owned totals. They do not mutate legacy statistics, quests, party state or wallet storage.

Snapshot `location` means the current selection. During capture, the displayed opponent may originate on a previously selected route. Existing event payloads remain outcome notifications; a consumer must not infer reward attribution from the latest snapshot or independently award rewards. A future external progression bridge needs an explicit durable attribution/idempotency contract.

Route selection, component replacement and nested route counters participate in the same whole-call transaction as rewards, pending commands and RNG state. Tests force failures after destination selection and after capture credit but before spawning to verify rollback. Queue limits, transition budgets and fail-stop behavior remain enforced.

## Compatibility evidence

Differential tests execute the real legacy `MapHelper.moveToRoute`, battle attacks and capture scheduling with controlled route availability and enemy generation. They compare selected location, enemy health, phase, consumed balls, money, experience, tokens, click counts and per-route defeat/capture counts. Cases include movement before capture completes, a failed capture and movement exactly at its deadline.

One legacy difference is deliberately visible: `MapHelper` compares a destination with `Battle.route`, the last defeated route, when deciding whether to spawn. After moving from route 1 to route 2 and back before another defeat, the legacy game can retain route 2's opponent while selecting route 1. A characterization test records this behavior. The new engine compares with its current selection and spawns a route 1 opponent on return; repeated selection of the current route is a no-op. This is a proposed normalization, not a claim of complete behavioral parity. Review this decision before live activation.

Cross-region travel remains unavailable because it also owns town/ship state and legacy pending-capture cancellation behavior. Other indirect progression effects, production input resolution, persistent saves, offline rewards, hosts and replaceable renderers remain subsequent work.
