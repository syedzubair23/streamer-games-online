/**
 * Process entry for `pnpm dev` / `pnpm build` / `pnpm start` (SPEC §9.2).
 *
 * Scaffold stub: it opens no sockets and exits 0. M1-01 replaces it with the real
 * transport bootstrap (config, room manager, HTTP + WebSocket listeners).
 */
import { SERVER_NAME } from "./index.ts";

process.stdout.write(`${SERVER_NAME}: scaffold entry, no transports yet (M1-01)\n`);
