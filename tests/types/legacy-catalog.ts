import type { CapturedRoute } from '../../src/runtime/legacy/captureRouteCatalog';
function immutableCapturedCatalog(route: CapturedRoute): void {
    // @ts-expect-error Catalog snapshots are detached read-only data.
    route.catalog[0].baseHealth = 10;
    // @ts-expect-error Pool order is part of the immutable encounter contract.
    route.pools.special[0].pokemonIds.push(1);
    // @ts-expect-error Normalization cannot change during a session.
    route.normalizedRoute = 2;
}
void immutableCapturedCatalog;
