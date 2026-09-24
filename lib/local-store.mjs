export async function localStore(path) {
  const {PGlite} = await import('@electric-sql/pglite');
  const db = new PGlite(path);
  await db.waitReady;
  const wrap=tx=>({query:(q,p=[])=>tx.query(q,p),json:value=>JSON.stringify(value)});
  return {...wrap(db),exec:q=>db.exec(q),transaction:fn=>db.transaction(tx=>fn(wrap(tx))),close:()=>db.close()};
}
