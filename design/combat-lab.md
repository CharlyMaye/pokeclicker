# Playable ECS combat lab

The standalone `ecs/` page assembles the route simulation, real dedicated worker, two interchangeable renderers, command controls and versioned checkpoints. It is a synthetic combat scenario for exercising the redesign, not a replacement for the legacy game or its balance. No legacy globals, save keys or reward adapters are used.

## Run and review

Run `npm ci`, then `npm run build:ecs` and `npx gulp public`. Serve `build/` over localhost HTTP or HTTPS and open `/ecs/`. The normal development server (`npm start`) and website build also include this page. A deployment under `/pokeclicker/` uses `/pokeclicker/ecs/`; all configuration and worker URLs resolve beneath that project directory.

The current Pages workflow publishes only `develop`. Merging a topic PR into `refactor/ecs` does not publish the lab to the live site.

Review these interactions:

1. Start combat, click attacks and select another unlocked route. During capture, the original encounter completes before the destination spawns.
2. Switch between Combat panel and Diagnostic view. The worker, command stream and progress remain the same. Neither view advances combat or acknowledges worker output.
3. Save and pause, resume, then save again. Reload requires confirmation and replaces the worker with a new stopped session. Cancel preserves the session and returns focus to the initiating control.
4. Restore the previous save after confirmation. Recovery retains the displaced bytes and generates a new revision. Existing malformed or incompatible data is reported and is never silently reset.
5. Hide and return to the page. Presentation stops immediately and a pause request follows any current worker operation. Returning restarts display only; combat requires Start. Leaving disposes the worker and owned DOM. Back/forward-cache suspension pauses the session.

Secure-context Web Crypto, dedicated workers, localStorage and Web Locks are required. No unsafe storage fallback is provided. Saving is manual: closing the page does not save unsaved progress. There is no offline catch-up in this prototype.

## State and operations

`CombatLabController` owns session lifetime and serializes user actions, output acknowledgment and checkpoint barriers through the worker's single pending RPC. Busy controls are disabled; there is no unbounded input task queue. Visibility and output callbacks coalesce into flags. Background acknowledgment runs independently of animation frames, including when no frame is rendered.

Saving stops the worker, drains the configured bounded output queue and requests a checkpoint. A checkpoint request acts as a message-order barrier because the worker posts an acknowledgment reply before its next batch. Saving remains paused on failure and revision conflicts require an explicit reload. A failed replacement retains the original paused session; a successfully initialized replacement takes ownership before the old session is disposed. A candidate that finishes after teardown is immediately disposed.

Worker faults surface through `onFault`; the callback cannot replace the original failure. Transport failure and acknowledgment failure stop the affected session. Presentation faults remain local to the display, so a replacement renderer can recover without changing simulation state.

The controller does not apply historical rewards. Prototype progression is already part of the worker checkpoint. Connecting historical features remains separate work requiring a single state owner and exactly-once reward handling.

## Required JSON

`public/config/lab.json` provides the scenario, seed, renderer choice, timeouts, save slot and byte limit, English text, combat labels and theme colors/layout. Core combat and scheduling settings remain in their existing JSON files. The scenario deliberately uses test balance and numeric Pokemon/route identifiers; it is not a production content catalog.

`parseLabConfiguration` is the canonical strict parser for this assembly document. Build tooling uses it through ts-node and runtime uses the same TypeScript implementation. It rejects missing/unknown fields, unsafe timers, invalid scenario references, blank labels, nonportable save slots, invalid colors and nonpositive layout values, then returns detached frozen data. Core combat/simulation schemas still generate their own validators and types; there is no second lab schema to drift.

Run `npm run generate:config` after changing JSON. All three files participate in the release identity and are published at hashed paths. Startup verifies all three documents before constructing storage or a worker. The bootstrap bundle includes the same lab JSON only to supply its startup deadline and loading/error text; it never substitutes that copy for failed runtime configuration. Changing lab text or colors changes the deployment identity but does not invalidate checkpoints; checkpoint compatibility still compares simulation rules and scenario.

## Validation and limits

`npm run test:lab` requires `npm run build:ecs`. It covers controller races and failures plus the emitted page bundle in jsdom connected to the emitted worker in an actual Node worker thread. The integration path exercises subpath loading, controls, capture, route changes, both renderers, save/reload/recovery confirmations, visibility and teardown. It also rejects a corrupt pinned configuration before worker creation and preserves a corrupt save.

These are browser API integration tests, not visual or cross-browser testing. Manual review should include keyboard navigation, narrow screens, storage restrictions and actual tab/background behavior. Browser scheduling can delay delivery of a pause request; the lab does not claim instantaneous suspension or device-sleep guarantees.

Remaining production work includes real content and party inputs, indirect progression compatibility, legacy-save migration, offline rules, other battle modes and production activation. No feature flag enables ECS inside the legacy loop yet.
