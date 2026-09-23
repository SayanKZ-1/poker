export async function localStore(path) {
  const {PGlite} = await import('@electric-sql/pglite');
  const db = new PGlite(path);
  await db.waitReady;
  return {query:(q,p=[])=>db.query(q,p),exec:q=>db.exec(q),transaction:fn=>db.transaction(tx=>fn(tx)),close:()=>db.close()};
}
