// Read-only, single-statement SELECT guard. The database handle must also be opened
// with { readOnly: true }: this check limits what is ASKED, the handle limits what CAN happen.
export class SqlError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

export function runSelect(db, sql, limit) {
  const src = String(sql).trim().replace(/;\s*$/, '');
  if (!/^(select|with)\b/i.test(src)) throw new SqlError('SQL_NOT_SELECT', 'Only a single SELECT (or WITH … SELECT) statement is allowed.');
  if (/;/.test(src.replace(/'(?:[^']|'')*'/g, '').replace(/"(?:[^"]|"")*"/g, ''))) throw new SqlError('SQL_MULTI', 'Only one statement is allowed.');
  let stmt;
  try { stmt = db.prepare(src); } catch (e) { throw new SqlError('SQL_ERROR', e.message); }
  const rows = [];
  try {
    for (const row of stmt.iterate()) {
      rows.push({ ...row });
      if (rows.length > limit) break;
    }
  } catch (e) { throw new SqlError('SQL_ERROR', e.message); }
  return { sql: src, rows: rows.slice(0, limit), truncated: rows.length > limit };
}
