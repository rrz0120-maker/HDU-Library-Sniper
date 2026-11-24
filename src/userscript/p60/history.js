// The account write-intent ledger never reads this archive.
const KEY = "hdu-p63:history";
export function readHistory(storage = localStorage) {
  const rows = JSON.parse(storage.getItem(KEY) ?? "[]");
  if (!Array.isArray(rows)) throw new Error("Invalid diagnostic history");
  return rows;
}

export async function archive(row) {
  await navigator.locks.request(KEY, () => {
    const rows = readHistory();
    const index = rows.findIndex((item) => item.runId === row.runId);
    if (index >= 0) rows[index] = row;
    else rows.unshift(row);
    localStorage.setItem(KEY, JSON.stringify(rows.slice(0, 30)));
  });
}
