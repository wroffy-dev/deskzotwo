import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import { listKnowledgeFiles } from "@/lib/ai-knowledge/store";
import { AiKnowledgeManager } from "@/components/settings/ai-knowledge-manager";

export const metadata = { title: "AI Knowledge" };
export const dynamic = "force-dynamic";

/**
 * Settings › AI Knowledge (owner, 3 Nov 2026; src/lib/ai-knowledge): the company's own .md and .txt files that
 * Deskzo AI answers from — the copilot first of all, and the Customer inbox's bot on a channel that ticks "Use AI
 * Knowledge". Upload many at once or a .zip, find, open, edit and delete them. Kept in the workspace's own database;
 * only for whoever may change the workspace's settings.
 */
export default async function AiKnowledgePage() {
  const user = await requireUser();
  if (!(await can(user.id, "settings.manage"))) notFound();
  const files = await listKnowledgeFiles();
  return (
    <div className="max-w-4xl space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-text">AI Knowledge</h1>
        <p className="mt-1 text-sm text-muted">
          Your own guides, product notes and processes, as .md or .txt files. Deskzo AI looks here first for any question about your company, your products or
          how something is done, and names the file its answer came from. A Customer inbox channel can answer customers from them too, when you tick &quot;Use AI
          Knowledge&quot; in its settings — but only from the files you mark &quot;Website chat may use this&quot; below.
        </p>
      </div>
      {files === null ? (
        <p className="rounded-base border border-line bg-surface-sunken px-3 py-2 text-sm text-muted">
          AI Knowledge isn&apos;t ready in this workspace yet — its database is being updated. Try again in a few minutes.
        </p>
      ) : (
        <AiKnowledgeManager files={files} />
      )}
    </div>
  );
}
