import { loadEnv } from './load-env';

/**
 * Side-effect module: import it FIRST in every entrypoint (main.ts, data-source.ts).
 *
 * `APP_ROLE` decides which modules AppModule imports, and that decision is made when the module
 * file is evaluated — before Nest's ConfigModule exists. The env file must therefore already be
 * in `process.env`. ES imports run in order, so importing this file first guarantees it.
 */
loadEnv();
