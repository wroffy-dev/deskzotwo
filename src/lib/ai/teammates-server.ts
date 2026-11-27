import { workspaceCountry } from "@/lib/country-pack";
import { lookPhoto, looksFor } from "@/lib/ai/teammate-looks";
import { TEAMMATE_KEYS, teammatePhotoPath, teammatesWith, type Teammate, type TeammateKey, type TeammateOverride } from "@/lib/ai/teammates";

/**
 * The AI teammates as this workspace sees them (src/lib/ai/teammates.ts): the names and photos Deskzo's console set for
 * the workspace's country, else the defaults (src/lib/ai/teammate-looks.ts — owner, 23 Nov 2026; a workspace no longer
 * names them itself). A photo goes to pages as its address only (/api/teammates/<key>/photo, cached). Server only.
 */
export async function teammateOverrides(): Promise<Partial<Record<TeammateKey, TeammateOverride>>> {
  const looks = await looksFor(workspaceCountry());
  return Object.fromEntries(TEAMMATE_KEYS.map((key) => [key, { name: looks[key].name, photo: key === "deskzo" ? null : teammatePhotoPath(key, looks[key].photoVersion) }]));
}

export async function workspaceTeammates(): Promise<Record<TeammateKey, Teammate>> {
  return teammatesWith(await teammateOverrides());
}

export async function teammate(key: TeammateKey): Promise<Teammate> {
  return (await workspaceTeammates())[key];
}

/** A teammate's photo as bytes, for its own address — null for Deskzo AI itself, which is its mark. */
export async function teammatePhoto(key: string): Promise<{ type: string; bytes: Buffer } | null> {
  return lookPhoto(workspaceCountry(), key);
}
