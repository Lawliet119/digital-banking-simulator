import type { FeatureProvider, Features, TransferEvent } from './feature-provider';

/** Placeholder only. Redis/SQL sourcing and fallback belong to the provider implementation task. */
export class OnlineFeatureProvider implements FeatureProvider {
  extract(_event: TransferEvent): Promise<Features> {
    return Promise.reject(new Error('Online feature provider is not configured'));
  }
}
