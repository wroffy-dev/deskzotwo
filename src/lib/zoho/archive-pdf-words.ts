/** Why there are no archive PDFs to fetch — said beside the faded button rather than left to guess (owner, 26 Nov 2026). */
export function noPdfsWhy(s: { archivePdfsHave?: number; archivePdfsNoId?: number }): string {
  const have = s.archivePdfsHave ?? 0;
  const noId = s.archivePdfsNoId ?? 0;
  const n = (k: number) => k.toLocaleString("en-IN");
  if (have === 0 && noId === 0) return "Nothing to fetch: the archive has no earlier years' invoices, credit notes, quotes or orders yet.";
  const fetched = have ? `${n(have)} already ha${have === 1 ? "s its" : "ve their"} PDF` : "";
  if (noId === 0) return `Nothing to fetch: all ${n(have)} of the archive's documents have their PDF.`;
  const missing = `${n(noId)} can't be fetched yet — ${noId === 1 ? "it has" : "they have"} no Zoho id, as the backup's files carry none. "Read everything again" brings the ids, and this then fetches them.`;
  return `Nothing to fetch now: ${fetched ? `${fetched}; ` : ""}${missing}`;
}
