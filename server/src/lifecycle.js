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

/**
 * Rename one provisioned session on the node first, then commit the names in
 * the database. If the database write fails, redeploy the old names so the
 * control plane and node cannot silently diverge.
 */
export async function migratePeeringNames(peering, target, deps) {
  const previous = { iface: peering.iface, bgp_proto: peering.bgp_proto };
  if (previous.iface === target.iface && previous.bgp_proto === target.bgp_proto) {
    return { changed: false };
  }

  await deps.deploy({ ...peering, ...target });
  try {
    deps.setNames(target.iface, target.bgp_proto, peering.id);
  } catch (error) {
    try {
      await deps.deploy({ ...peering, ...previous });
    } catch (rollbackError) {
      throw new Error(
        `database update failed and node rollback failed: ${error.message}; rollback: ${rollbackError.message}`,
        { cause: error },
      );
    }
    throw new Error(`database update failed; node restored to legacy names: ${error.message}`, { cause: error });
  }

  deps.clearOperationalState(peering.id);
  deps.logEvent(peering.asn, 'admin.migrate-names', `${peering.node_id}: ${previous.iface} -> ${target.iface}`);
  return { changed: true };
}
