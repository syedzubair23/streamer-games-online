/**
 * Process entry for `pnpm dev` / `pnpm build` / `pnpm start` (SPEC §9.2, §9.5).
 *
 * Loads `server.config.json` + env (see `config.ts`), starts the configured transport on one
 * port (HTTP + `/ws`), and shuts down cleanly on SIGINT/SIGTERM. Exit code 1 on a startup error.
 */
import { createServer, loadServerConfig, SERVER_NAME } from "./index.ts";

async function main(): Promise<void> {
  const config = loadServerConfig();
  const server = await createServer({ config });
  process.stdout.write(
    `${SERVER_NAME}: listening on ${config.host}:${server.port} (transport ${config.transport}, store ${server.store.kind}` +
      `${config.staticDir !== undefined ? ", serving the client build" : ""})\n`,
  );
  let stopping = false;
  const stop = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    process.stdout.write(`${SERVER_NAME}: ${signal}, shutting down\n`);
    void server.close().then(() => process.exit(0));
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
}

main().catch((err: unknown) => {
  process.stderr.write(
    `${SERVER_NAME}: failed to start: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
