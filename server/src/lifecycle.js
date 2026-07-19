/**
 * Delete one auto-managed peering without losing the database record when the
 * node agent cannot remove its WireGuard/BIRD configuration.
 */
export async function deletePeeringTransaction(peering, deps, action = 'peering.delete') {
  deps.setStatus('deleting', null, peering.id);
  try {
    await deps.remove(peering.node_id, peering.asn);
  } catch (error) {
    const detail = String(error?.message || error);
    deps.setStatus('delete_failed', detail, peering.id);
    deps.logEvent(peering.asn, `${action}.failed`, `${peering.node_id}: ${detail}`);
    throw new Error(`node cleanup failed; database record retained: ${detail}`, { cause: error });
  }

  deps.deleteRecord(peering.id);
  deps.logEvent(peering.asn, action, peering.node_id);
}
