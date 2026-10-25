# Historical route catalog adapter

`src/runtime/legacy/captureRouteCatalog.ts` and `prepareLegacyRouteSession.ts` connect the shipped route registry and Pokémon catalog to sampled ECS combat. They are read-only preparation functions: neither starts a host nor changes the historical game's state. They belong to the runtime boundary; simulation and presentations still have no dependency on historical modules.

## Sources and normalization

Call `captureRouteCatalog(Routes.regionRoutes, pokemonList, locations)` with the **complete registry in its original order**, the raw exported `pokemonList` array and explicit selected locations. Do not pass a region-filtered registry: normalized route positions count preceding routes across regions. The adapter follows `Routes.normalizedNumber` exactly: the current entry gets `count + 1`, and an entry marked `ignoreRouteInCalculations` does not increment the count for subsequent entries. An ignored route can therefore share a normalized position with the next route. It does not sort by route number, region or difficulty.

Historical class instances are accepted. Only required own data properties are inspected; relevant accessors and inherited fields are rejected. Unrelated fields, prototypes and methods are omitted. In particular, the adapter never calls `isUnlocked`, `isAvailable`, requirements, party services, random generators or catalog proxies. These source objects are trusted application records, not arbitrary hostile JavaScript proxies; JSON snapshots remain the untrusted data boundary.

Pool names are mapped through the raw catalog to stable numeric IDs, including fractional form IDs. Order and duplicate selection intervals are preserved. The captured catalog contains one record per distinct referenced species, in first occurrence order across land, water, headbutt and special pools. Unavailable groups remain present for health averaging. Explicit route health overrides are retained; an absent override becomes `null`.

Duplicate route identities/names, ambiguous IDs among referenced species, unknown names, sparse arrays, invalid selected locations, nonfinite stats and invalid overrides fail explicitly. Metadata across the complete registry and catalog names are checked; detailed pool/stat validation covers selected routes and all their species, including unavailable species. No fallback to another route or species is introduced. Returned objects are detached, deeply frozen and JSON-serializable. A partial registry cannot be detected from its shape alone: passing the complete authoritative registry is a caller obligation.

## Session preparation

`prepareLegacyRouteSession` accepts exactly:

```ts
prepareLegacyRouteSession({
    registry: Routes.regionRoutes,
    pokemonList,
    session,          // Version 1 JSON snapshot described below.
    healthPolicy,    // Validated using the public route-health policy parser.
    encounterPolicy, // Validated using the public encounter-rules policy parser.
});
```

No direct legacy imports are required by the adapter. A composition root supplies the source records; fixture tests can supply the same shapes. The policies can come from the existing pinned configuration loader. The returned immutable scenario is version 3 and can be supplied to the existing direct or worker host.

The session snapshot requires `formatVersion: 1`, `initialLocation`, `routes`, `ordinaryWeight`, `clickAttackDamage`, `clickAttacksAllowed` and `initialPokeballs`. Each route requires:

- `location`, an explicit boolean `unlocked`, and `access` with `waterUnlocked` / `includeHeadbutt`;
- `specialAvailability`, exactly one boolean per special group in source order;
- `opponents`, exactly one profile per distinct source species, including unavailable species.

Each opponent profile requires `pokemonId`, `autoAttackDamage`, `experienceReward`, `pokeballBonus`, `oakBonus`, `captureDurationMs`, `moneyMultiplier` and `tokenMultiplier`. Damage and experience reward are already resolved values; source base experience is not a party-wide reward and is deliberately not substituted for it. Profiles do not supply normalized routes, base health or base catch rates: the adapter obtains those from the authoritative catalog/registry. All fields and policy coefficients are explicit; no gameplay default is added in TypeScript.

The adapter compiles route health using every unique source species, resolves eligibility and builds spawn profiles for eligible species only. Both endpoint calculations and all profile fields are validated even for unavailable species and locked routes. Templates use the lower variation endpoints to provide valid concrete values; the version 3 simulation samples and resolves each actual spawn normally. This consumes no RNG during preparation.

Water-only routes still allow their water pool without a rod. Special groups retain their source weights; ordinary weight comes from session JSON. A route with no eligible opponents fails preparation, even if locked. Omit such a route from the selected session until it has a valid pool, while continuing to pass the complete source registry for normalization.

## Ownership and lifecycle

Eligibility must be captured at a deliberate session boundary. Callers own the consistency of that snapshot and should assemble it synchronously with the source records. The adapter does not evaluate requirements or call legacy damage helpers that could consume items or update statistics. Requirement evaluation, time/weather changes, party bonuses, ball choice and effect ownership still need a dedicated bridge before live activation.

After preparation, changing or removing the source objects has no effect on the session. Checkpoints persist the resolved scenario and per-encounter sample, so restoration needs no legacy registry, catalog, requirements or current game services. Existing compatibility checks reject a re-prepared scenario whose effective values differ; source changes that compile to identical values do not invalidate a save. There is no new save format, automatic migration or overwrite. Choose the selected route set to fit the host/storage size limits; the whole production registry is not automatically embedded in each session.

This milestone extracts real content and normalization. It does not take ownership of the historical wallet/party, implement experience distribution or indirect defeat effects, reproduce the full legacy generation RNG timeline, or activate ECS in the historical game. The default lab scenario remains unchanged.

## Validation and review

Differential tests load the actual shipped `RouteData`, `Routes` and `PokemonList`. They compare every route's normalized position and catalog values, all four water/headbutt combinations against real `RouteHelper` methods with controlled availability, and health/overrides against real `PokemonFactory.routeHealth`. These tests use explicit synthetic combat bonuses and never load a user's save or evaluate live requirements.

Boundary tests cover class records, accessors, ambiguous and missing references, inactive input validation, immutable snapshots, ignored routes, eligibility, source-route pending captures and compatibility rejection. An emitted-worker persistence test runs an adapted scenario, saves, terminates, restores and compares subsequent output against uninterrupted direct combat.

Review the full-registry normalization requirement, special-group availability ordering, complete profiles for unavailable species, and the separation between catalog data and mutable session inputs. CI does not replace maintainer review.
