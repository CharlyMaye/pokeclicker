import type { RouteReference } from '../../contracts/combat-protocol';
import type { CombatRoute } from './model';

export function sameRoute(left: RouteReference, right: RouteReference): boolean {
    return left.region === right.region && left.route === right.route;
}

/** Internal map key; region and route are validated nonnegative integer identifiers. */
export function routeKey(location: RouteReference): string {
    return `${location.region}:${location.route}`;
}

export function findRoute(routes: readonly CombatRoute[], location: RouteReference): CombatRoute | undefined {
    return routes.find(route => sameRoute(route.location, location));
}
