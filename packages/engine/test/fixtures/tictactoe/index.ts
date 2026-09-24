/**
 * The tictactoe reference game (`@sg/engine/fixtures/tictactoe`): logic and scenarios. The
 * engine's own tests, the server (M1-02), the client shell (M1-09) and the harness (M0-05) use
 * it before any real game exists. Its minimal Stage/controller client is a separate entry
 * (`@sg/engine/fixtures/tictactoe/client`) so logic consumers never load DOM code.
 */
export * from "./logic.ts";
export * from "./scenarios.ts";
