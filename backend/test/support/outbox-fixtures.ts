/**
 * BL-180: PostgreSQL refuses to delete an unpublished outbox row (trigger
 * outbox_events_no_delete_unpublished), for the table owner too. A fixture that wants an empty
 * outbox between cases therefore marks the leftovers as published first, exactly as the relay
 * would, and only then deletes. Nothing here weakens or bypasses the guard.
 */
export async function clearOutbox(query: (sql: string) => Promise<unknown>): Promise<void> {
  await query('UPDATE outbox_events SET published_at = now() WHERE published_at IS NULL');
  await query('DELETE FROM outbox_events');
}
