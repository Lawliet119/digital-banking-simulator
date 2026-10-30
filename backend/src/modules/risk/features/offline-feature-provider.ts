import type { FeatureProvider, Features, TransferEvent } from './feature-provider';

/** Placeholder only. Dataset ingestion belongs to the offline evaluation task. */
export class OfflineFeatureProvider implements FeatureProvider {
  extract(_event: TransferEvent): Promise<Features> {
    return Promise.reject(new Error('Offline feature provider is not configured'));
  }
}
