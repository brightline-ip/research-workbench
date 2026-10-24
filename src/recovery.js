export async function acquireWorker(pool) {
  const client=await pool.connect();
  const {rows:[lock]}=await client.query('SELECT pg_try_advisory_lock(727401, 2) AS acquired');
  if(!lock.acquired){client.release();throw new Error('Another workbench worker is already running.');}
  return client;
}

export async function recoverInterrupted(client) {
  const tables=['assertion_extraction_runs','discovery_runs','verification_runs','adversarial_runs','red_team_runs','reconciliation_runs','revision_runs','analysis_runs'];
  await client.query('BEGIN');
  try {
    for(const table of tables)await client.query(`UPDATE ${table} SET status='FAILED',error_message='Interrupted by an application restart. Partial work may exist; inspect the run before starting a new operation.',completed_at=now() WHERE status='RUNNING'`);
    await client.query("UPDATE projects SET status='FAILED',updated_at=now() WHERE status='RESEARCHING'");
    await client.query("UPDATE sources SET retrieval_status='FAILED',updated_at=now() WHERE retrieval_status='ACQUIRING'");
    await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK');throw error;}
}
