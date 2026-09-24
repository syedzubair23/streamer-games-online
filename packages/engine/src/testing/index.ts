/**
 * @packageDocumentation
 * `@sg/engine/testing`: the kit every game's tests use.
 *
 * - `runScript` / `makeSeats`: scripted rule tests on a real runner with a virtual clock.
 * - `runContractSuite` / `checkContract`: the module contract (DOD G4).
 * - `simulateGame` / `pacingReport` / `checkPacing`: the timed bot model, the simulated
 *   audience and the pacing report (DOD G5, G14).
 * - `fakeContent`: content-pack fixtures as a `ContentAccess`.
 */
export * from "./run-script.ts";
export * from "./contract.ts";
export * from "./sim.ts";
export * from "./fake-content.ts";
