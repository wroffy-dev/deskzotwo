"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

/**
 * "Are you sure?" in the app's own dialog, from anywhere: `if (!(await confirmAction("Delete it?"))) return;`
 *
 * It replaced the browser's `confirm()`, which ninety-odd buttons used and which was wrong for every
 * one of them in the same ways: it looks like the browser rather than the app, a phone shows it as a
 * system alert with the site's address for a title, its buttons are always "OK" and "Cancel" whatever
 * is being asked — "OK" to deleting a challan reads like agreeing to a notice — and nothing marks the
 * one that destroys something. It also froze the page while it was open.
 *
 * Called as a function, not a hook, so a handler deep in a table row needs no provider threaded down
 * to it: the one `ConfirmHost` (in the root layout) draws whatever was asked last. Where no host is
 * mounted — a page rendered on its own, as the check suites do — it falls back to the browser's, so
 * the question is still asked.
 *
 * A bare string is read the way these questions are written in this app: the opening question is the
 * title ("Delete "Q3 plan"?") and the rest is what it means ("Workflows made from it stay as they
 * are."); the first word names the button ("Delete", not "OK"); and a question that deletes, removes,
 * disconnects or can't be undone is drawn in red, with Cancel holding the focus so Enter can't do it
 * by accident. Pass the fields to say otherwise.
 */
export type ConfirmOptions = {
  /** The question. Taken from the message's opening question when not given. */
  title?: string;
  /** What saying yes will do — the consequences, in a sentence or two. */
  message?: string;
  /** The button that goes ahead. The question's first word when not given ("Delete", "Send"). */
  confirmLabel?: string;
  /** The button that backs out. */
  cancelLabel?: string;
  /** Red, for something that destroys or can't be taken back. Worked out from the words when not given. */
  danger?: boolean;
};

type Request = Required<Omit<ConfirmOptions, "message">> & { message: string; resolve: (yes: boolean) => void };

/** Verbs whose question is a destructive one. */
const DANGER_VERBS = new Set(["delete", "remove", "revoke", "disconnect", "archive", "leave", "withdraw", "end", "discard", "cancel", "stop", "un-apply", "replace", "throw"]);
/** Words in the consequences that make any question a destructive one. */
const DANGER_WORDS = /can't be undone|cannot be undone|can't be brought back|for good|permanently|stops? working|can't be switched back|are deleted|will be deleted|is wiped|are wiped/i;
/** Verbs that read well alone on the button. Anything else gets "Continue". */
const BUTTON_VERBS = new Set([...DANGER_VERBS, "send", "post", "approve", "receive", "export", "build", "switch", "reset", "save", "rotate"]);
/** Verbs that need a word after them to make a button. */
const BUTTON_PHRASES: Record<string, string> = { cancel: "Yes, cancel it", go: "Go back", sign: "Sign out", try: "Try again", throw: "Discard" };

function capitalised(word: string) {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/** A bare question, read as this app writes them — see the note at the top. */
export function readQuestion(text: string): Required<Omit<ConfirmOptions, "cancelLabel">> & { cancelLabel?: string } {
  const trimmed = text.trim();
  // The opening question is the title when the text starts with one: up to the first "?" with no
  // sentence ending or line break before it — a full stop inside a figure ("₹1,234.50") isn't one.
  const opening = /^(?:[^.!?\n]|[.!](?=\S))+\?/.exec(trimmed);
  const title = opening ? opening[0].trim() : "Are you sure?";
  const message = opening ? trimmed.slice(opening[0].length).trim() : trimmed;
  const verb = (opening ? title : "").split(/\s+/)[0]?.toLowerCase().replace(/[^a-z-]/g, "") ?? "";
  const danger = DANGER_VERBS.has(verb) || DANGER_WORDS.test(trimmed);
  const confirmLabel = BUTTON_PHRASES[verb] ?? (BUTTON_VERBS.has(verb) ? capitalised(verb) : "Continue");
  // "Cancel Pro?" can't be answered with two buttons both saying Cancel.
  return { title, message, danger, confirmLabel, ...(verb === "cancel" ? { cancelLabel: "Keep it" } : {}) };
}

let current: Request | null = null;
let hosts = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

/** Asks, and resolves true for yes and false for no — Escape, the backdrop and the X are all no. */
export function confirmAction(question: string | (ConfirmOptions & { message: string })): Promise<boolean> {
  const asked = typeof question === "string" ? { message: question } : question;
  const read = readQuestion(asked.message);
  const options = {
    title: asked.title ?? read.title,
    message: asked.title ? asked.message : read.message,
    confirmLabel: asked.confirmLabel ?? read.confirmLabel,
    cancelLabel: asked.cancelLabel ?? read.cancelLabel ?? "Cancel",
    danger: asked.danger ?? read.danger,
  };
  if (hosts === 0 || typeof window === "undefined") {
    // No host on this page: the browser's own, so the question is still asked.
    // eslint-disable-next-line no-restricted-properties
    return Promise.resolve(typeof window !== "undefined" && window.confirm([options.title === "Are you sure?" ? "" : options.title, options.message].filter(Boolean).join(" ")));
  }
  // One question at a time: a second one asked over the first (it can't be clicked, but a shortcut
  // can) answers the first no.
  current?.resolve(false);
  return new Promise<boolean>((resolve) => {
    current = { ...options, resolve };
    emit();
  });
}

function answer(yes: boolean) {
  const asked = current;
  current = null;
  emit();
  asked?.resolve(yes);
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** Draws the question asked last. Mounted once, in the root layout. */
export function ConfirmHost() {
  const asked = useSyncExternalStore(subscribe, () => current, () => null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    hosts += 1;
    return () => {
      hosts -= 1;
      // Gone with a question open (the page left): the question is answered no, never left hanging.
      if (hosts === 0) answer(false);
    };
  }, []);

  // After the dialog's own focus handling, which puts focus on its first control (the X): for a
  // destructive question, on Cancel, so a reflexive Enter backs out; otherwise on the button that goes ahead.
  useEffect(() => {
    if (!asked) return;
    (asked.danger ? cancelRef : confirmRef).current?.focus();
  }, [asked]);

  return (
    <Dialog open={asked !== null} onClose={() => answer(false)} title={asked?.title ?? ""}>
      {asked && (
        <div className="space-y-5">
          {asked.message && <p className="whitespace-pre-line text-sm text-muted">{asked.message}</p>}
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button ref={cancelRef} type="button" variant="secondary" onClick={() => answer(false)}>
              {asked.cancelLabel}
            </Button>
            <Button ref={confirmRef} type="button" variant={asked.danger ? "danger" : "primary"} onClick={() => answer(true)}>
              {asked.confirmLabel}
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
