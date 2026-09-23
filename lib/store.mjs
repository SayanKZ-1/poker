// Both adapters execute the same SQL. PGlite is the durable single-process local runner.
export function postgresStore(sql) {
  const wrap = tx => ({query: async (q,p=[]) => ({rows:await tx.unsafe(q,p)})});
  return {...wrap(sql), transaction:fn=>sql.begin(tx=>fn(wrap(tx))),close:()=>sql.end()};
}
