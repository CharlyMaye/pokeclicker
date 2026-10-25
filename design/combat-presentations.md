# Interchangeable combat presentations

Two concrete renderers now implement the existing `CombatRenderer` contract:

- `DomCombatRenderer` creates a diagnostic definition list using native DOM operations.
- `KnockoutCombatRenderer` creates an isolated card-style panel with Knockout text bindings and a native health progress element.

Both take a host element, a session identifier and required display labels. They consume snapshots only. Neither can access the simulation, host, legacy modules, timers or storage through its dependencies. The Knockout view model contains presentation values, not `App.game`, ECS components or legacy observables.

## Presentation data

`CombatViewModel` validates snapshots through the existing session/sequence receiver and creates a detached, frozen view. It formats the selected numeric region/route, opponent catalog ID, health and capture time. Fractional Pokémon form IDs are preserved. Repeated or older snapshots do not trigger DOM writes. Invalid payloads and foreign sessions reject before changing the view or consuming the next valid sequence.

Labels are required constructor data with an exact set of nonempty string properties. They are copied and frozen. There is no embedded English fallback in the renderers. `tests/fixtures/presentation/combat-labels.json` provides English labels for tests; it is not a published theme or a new localization system. Production assembly should supply these labels from localization or validated presentation JSON. A loader, asset-name mapping and user-facing configuration integration are not introduced here. No gameplay values, colors, animation durations or polling rates are added to the renderers.

Labels and projected values become text nodes or Knockout `text` bindings. They never become HTML, binding expressions or executable configuration. The view model remains usable without DOM or Knockout types. Only the concrete renderers compile with the DOM library; lint prevents every client module from importing simulation/runtime/legacy code.

## Authoritative capture state

The snapshot location is the current route selection. During capture, the opponent can still come from a previous route; the view does not infer reward attribution from its location label. Capture time is `resolvesAtMs - snapshot.atMs`. A displayed zero does not end capture: the view remains capturing until a subsequent authoritative snapshot changes its phase. Reading or rendering never advances time, decides success, consumes a ball or awards a reward.

The diagnostic panel and Knockout panel display the same presentation values in different structures. The Knockout panel's health ratio is a display projection of current/max health. It is not another mutable health authority.

## Ownership and replacement

Each renderer appends a private subtree and removes only that subtree on disposal. The container and any neighboring nodes/bindings are left intact. Knockout binds programmatically to owned nodes, disposes its computed projections, and cleans the private subtree; it never calls `applyBindings` or `cleanNode` on the global application or the supplied container. Mount failure also cleans its constructed private bindings.

Replacing a view means disposing its `PresentationLoop`, creating the other renderer against the same snapshot source, and starting a new presentation loop. The simulation host, command sequence, RNG, output acknowledgment and active time continue unchanged. A renderer belongs to one session; a new session needs a new receiver/renderer. Disposal is idempotent, and rendering after disposal rejects explicitly.

These are standalone components, not an automatic replacement inside the existing globally bound Knockout page. Production assembly must give them an isolated mounting region and prevent the legacy binding traversal from rebinding that subtree. The Knockout card reuses semantic class names compatible with the existing stylesheet, while the DOM diagnostic view has no framework styling dependency. No visual theme or live Pages deployment is changed by this slice.

## Validation and remaining integration

DOM integration tests cover waiting, fighting, capture and idle displays; zero-time capture; changed route selection; fractional IDs; malformed/stale/foreign snapshots; injected markup as plain text; repeated-frame DOM stability; neighboring binding preservation; and cleanup on disposal or mount failure.

Tests also run the real ECS host and replace DOM with Knockout, and Knockout with DOM, during an active capture. They compare the final snapshots, progression, event stream and command outcomes against a run without rendering, at different frame rates. Delayed frames from the disposed presentation cannot update its replacement.

This establishes concrete renderer substitution against the current prototype engine. Production catalogs and translations, input controls, complete progression compatibility, persistence, offline accounting and live activation remain separate integration work. The tests exercise DOM behavior; they are not a browser screenshot or visual-design approval.

The [worker proxy](worker-combat.md) also implements the snapshot-source interface. Replacing a renderer does not recreate its worker, acknowledge its event delivery or reset its combat clock.
