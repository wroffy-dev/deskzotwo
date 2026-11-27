import { allMailBlockFor } from "@/lib/mail-blocks";
import { parseCc } from "@/lib/mail/cc";

/**
 * The typed Cc addresses of an email a person sends (src/lib/mail/cc.ts), checked against the workspace's block
 * rules too — the same "all mail" blocks the To line answers to.
 */
export async function checkedCc(raw: unknown, alreadyTo: string[] = []): Promise<{ ok: true; cc: string[] } | { ok: false; error: string }> {
  const parsed = parseCc(raw, alreadyTo);
  if (!parsed.ok) return parsed;
  const blocked = await allMailBlockFor(parsed.cc);
  if (blocked) {
    return { ok: false, error: `${blocked.address} can't be copied: mail to ${blocked.scope === "DOMAIN" ? blocked.value : "that address"} is blocked${blocked.by ? ` by ${blocked.by}` : ""}.` };
  }
  return parsed;
}
