/* Generated from schemas/. Run npm run generate:config; do not edit. */

export interface SimulationConfiguration {
    schemaVersion: 3;
    stepMs: number;
    maxStepsPerAdvance: number;
    maxQueuedCommands: number;
    maxTransitionsPerStep: number;
    maxCommandLeadMs: number;
    maxPendingOutputs: number;
}
