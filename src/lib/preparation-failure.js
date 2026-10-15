/** Frozen prestart termination, shared by automatic failure and operator abandon. */
export async function abandonPreparation(state, worktrees, taskId, generation, reason) {
  let record = await state.abandonPreparation(taskId, generation, reason);
  // Replay must finish local release even after the report was confirmed.
  await worktrees.releasePreparation(taskId, generation);
  if (record.report) return state.reconcile(taskId, { generation, replay: true });
  record = await state.startAbandonedPreparation(taskId, generation);
  return state.report(taskId, generation, 'fail', {
    error: record.preparation_failure.reason,
    failure_reason: 'environment_prepare_failed',
  });
}

export function preparationFailure(error) {
  if (['WORKTREE_BUSY', 'PROCESS_STOP_UNCONFIRMED', 'PREPARATION_ABORTED'].includes(error.code)) return null;
  const reason = error.code === 'PREPARATION_PERMANENT' || error.code === 'PREPARATION_TRANSIENT'
    ? error.preparationReason : error.message === 'invalid repository ref' ? 'invalid repository ref' : 'preparation error; inspect retained task directory';
  return { permanent: error.code === 'PREPARATION_PERMANENT' || error.message === 'invalid repository ref',
    reason: `${reason}${error.preparationResource ? ` (resource ${error.preparationResource})` : ''}` };
}
