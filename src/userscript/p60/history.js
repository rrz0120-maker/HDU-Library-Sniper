// The account write-intent ledger never reads this archive.
const KEY = "hdu-p64:history";
const LEGACY_KEY = "hdu-p63:history";
function readRows(storage, key) {
  const rows = JSON.parse(storage.getItem(key) ?? "[]");
  if (!Array.isArray(rows)) throw new Error("Invalid diagnostic history");
  return rows;
}

export function readHistory(storage = localStorage) {
  return [...readRows(storage, KEY), ...readRows(storage, LEGACY_KEY)];
}

export async function archive(row) {
  await navigator.locks.request(KEY, () => {
    const rows = readRows(localStorage, KEY);
    const index = rows.findIndex((item) => item.runId === row.runId);
    if (index >= 0) rows[index] = row;
    else rows.unshift(row);
    localStorage.setItem(KEY, JSON.stringify(rows.slice(0, 30)));
  });
}
