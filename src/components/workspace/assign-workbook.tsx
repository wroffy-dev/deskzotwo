"use client";

import { PeopleMultiSelect } from "@/components/ui/people-multi-select";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { UserPlus } from "lucide-react";
import { assignWorkbook } from "@/actions/workspace";
import { Badge } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label } from "@/components/ui/input";

type Assignee = { userId: string; note: string | null; user: { id: string; name: string } };

/**
 * Who is working this list.
 *
 * The whole set is chosen at once rather than added one at a time, because assignment is thought
 * about as "these three people" — and a bare add would make removing somebody a separate step that
 * gets forgotten, leaving a list assigned to someone who stopped working it months ago.
 */
export function AssignWorkbook({
  workbookId,
  assignees,
  users,
  canAssign,
  calling = false,
}: {
  workbookId: string;
  assignees: Assignee[];
  users: { id: string; name: string }[];
  canAssign: boolean;
  /** A calling activity: changing its people shares the uncalled records out again. */
  calling?: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>(assignees.map((a) => a.userId));
  const [note, setNote] = useState("");

  function save() {
    setError(null);
    startTransition(async () => {
      const result = await assignWorkbook({ id: workbookId, userIds: selected, note });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <>
      <div className="flex flex-wrap items-center gap-1.5">
        {assignees.map((a) => (
          <Badge key={a.userId} tone="blue">
            {a.user.name}
          </Badge>
        ))}
        {assignees.length === 0 && <span className="text-xs text-subtle">Nobody assigned</span>}
        {canAssign && (
          <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
            <UserPlus className="mr-1 h-3.5 w-3.5" />
            {assignees.length > 0 ? "Change" : "Assign"}
          </Button>
        )}
      </div>

      <Dialog open={open} onClose={() => setOpen(false)} title="Who is working this list?">
        <div className="space-y-4">
          {/* Search and pick (owner, 16 Nov 2026), not every name in the workspace as a button. */}
          <PeopleMultiSelect people={users} selected={selected} onChange={setSelected} label="Who is working this list" />

          <div className="space-y-1.5">
            <Label htmlFor="assignNote">What should they do with it?</Label>
            <Input
              id="assignNote"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Call through by Friday, log every outcome"
            />
            <p className="text-xs text-subtle">
              Sent with the notification to anyone newly assigned. People already on the list aren&apos;t notified again.
            </p>
            {calling && (
              <p className="text-xs text-subtle">
                Changing who is on a calling activity shares the records nobody has called yet between them again. Calls already made stay with whoever made them.
              </p>
            )}
          </div>

          {error && <p className="text-sm text-danger">{error}</p>}

          <div className="flex gap-2">
            <Button disabled={pending} onClick={save}>
              {pending ? "Saving…" : selected.length === 0 ? "Remove everyone" : `Assign ${selected.length}`}
            </Button>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
