import { stopPostgresContainer } from './postgres.container';

export default async function globalTeardown(): Promise<void> {
  await stopPostgresContainer();
}
