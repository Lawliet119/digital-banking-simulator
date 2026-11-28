/** What the browser needs to talk to the user pool. None of it is a secret. */
export interface CloudConfig {
  region: string;
  userPoolId: string;
  userPoolClientId: string;
}

const REGION = /^[a-z]{2}(-[a-z]+)+-\d$/;
const POOL_ID = /^([a-z]{2}(-[a-z]+)+-\d)_[0-9A-Za-z]+$/;
const CLIENT_ID = /^[0-9a-z]{20,128}$/;

/** The configuration, or `undefined` for anything else (a missing file served as the page). */
export function parseCloudConfig(raw: unknown): CloudConfig | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { region, userPoolId, userPoolClientId } = raw as Record<string, unknown>;
  if (typeof region !== 'string' || !REGION.test(region)) return undefined;
  if (typeof userPoolId !== 'string' || POOL_ID.exec(userPoolId)?.[1] !== region) return undefined;
  if (typeof userPoolClientId !== 'string' || !CLIENT_ID.test(userPoolClientId)) return undefined;
  return { region, userPoolId, userPoolClientId };
}

/**
 * `/config.json`, written next to the page when the web app is deployed, so one build serves
 * every environment. A server that has no such file answers with the page itself: that is "no
 * configuration", not an error.
 */
export async function loadCloudConfig(): Promise<CloudConfig | undefined> {
  try {
    const response = await fetch('/config.json', { cache: 'no-store' });
    if (!response.ok) return undefined;
    return parseCloudConfig(await response.json());
  } catch {
    return undefined;
  }
}
