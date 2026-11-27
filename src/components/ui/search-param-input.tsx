"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

/** How long the typing has to stop before the list is searched (owner, 30 Oct 2026). Enter doesn't wait. */
export const SEARCH_DELAY_MS = 2000;

/**
 * A search box whose value lives in the URL, so a filtered list survives a reload or a shared link.
 *
 * Typing returns to the first page. Without that, searching while standing on page 3 leaves the
 * page number behind and shows an empty page 3 of a result that now has one page — which reads as
 * "no matches" and is how a working filter gets reported as broken.
 */
export function SearchParamInput({
  paramName,
  placeholder,
  label,
  className,
  resetParams = ["page"],
}: {
  paramName: string;
  placeholder?: string;
  /**
   * What the box is called, read before every interaction.
   *
   * Defaults to the placeholder, which is the wording each screen already chose for this box —
   * "Search company name…" on one list, "Tag, serial, make or model" on another. Worth setting
   * separately only where the placeholder is an example rather than a name.
   */
  label?: string;
  className?: string;
  /**
   * The page numbers this search invalidates. Named rather than guessed, because a screen showing
   * two paginated lists has two of them and resetting only one is worse than resetting neither.
   */
  resetParams?: string[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const currentParam = searchParams.get(paramName) ?? "";

  const [value, setValue] = useState(currentParam);
  const [lastSynced, setLastSynced] = useState(currentParam);
  /**
   * What this box last sent to the address — so its own search arriving there isn't taken for a change made
   * elsewhere (owner, 30 Oct 2026: "search mein double type ho raha").
   *
   * It used to mark the URL as synced the moment it pushed, while the address still held the old text until the
   * list had loaded. The render in between read that as "the URL changed from elsewhere" and put the old text back
   * in the box, then the new text once the list arrived: whatever was typed meanwhile was lost or came out twice
   * ("ser", a pause, "ver" ended as "serr"), and the list was asked for twice.
   */
  const [sent, setSent] = useState<string | null>(null);

  // Keep the field in sync when the URL param changes from elsewhere (another filter link, browser back/forward)
  // — adjusted during render rather than in an effect, per React's guidance. Our own search landing is not that:
  // the box already says it, and may by now say more.
  if (currentParam !== lastSynced) {
    setLastSynced(currentParam);
    if (currentParam !== sent) {
      setValue(currentParam);
      setSent(null);
    }
  }

  function search(text: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (text) params.set(paramName, text);
    else params.delete(paramName);
    for (const key of resetParams) params.delete(key);
    const query = params.toString();
    router.push(query ? `${pathname}?${query}` : pathname);
    setSent(text);
  }

  useEffect(() => {
    /**
     * Nothing to do when the box already matches the URL, or what it last sent is still on its way there.
     *
     * The first is the case on mount, and is what makes clearing the page number safe: without it, simply
     * opening `?q=acme&page=3` would fire a push that dropped the page and bounced the reader back to page 1 of
     * a list they had deliberately paged into. The second keeps one search from going out twice.
     */
    if (value === currentParam || value === sent) return;
    // Searched once the typing has stopped for a moment (owner, 30 Oct 2026: two seconds), not at every pause.
    const handle = setTimeout(() => search(value), SEARCH_DELAY_MS);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, currentParam, sent]);

  return (
    /**
     * Everything here is about keeping the browser out of it.
     *
     * With no name and no autocomplete, Chrome treated this as a fillable field and put the saved
     * sign-in address into it moments after somebody signed in. On the credential vault that
     * silently became `?q=someone@example.com` and the page said "Nothing here yet" over a
     * cupboard full of records — a filter nobody set, reported as an empty vault.
     *
     * `autoComplete="off"` alone is not enough, because Chrome ignores it on fields it has decided
     * it recognises. The name is what stops it recognising this one, and the `data-*` attributes
     * are the opt-outs 1Password and LastPass read.
     */
    <input
      type="search"
      name={`search-${paramName}`}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      // Enter searches now rather than after the wait.
      onKeyDown={(e) => {
        if (e.key === "Enter" && value !== currentParam && value !== sent) {
          e.preventDefault();
          search(value);
        }
      }}
      placeholder={placeholder}
      /*
       * The placeholder is the only wording this box has on screen, and it stops being readable at
       * the first keystroke — so it is copied into the name rather than relied on as one. A
       * `<label htmlFor>` pairing is not an option: these sit in a toolbar with nothing visible to
       * pair with, and adding text there would be a redesign.
       */
      aria-label={label ?? placeholder ?? "Search"}
      autoComplete="off"
      autoCorrect="off"
      autoCapitalize="off"
      spellCheck={false}
      data-1p-ignore
      data-lpignore="true"
      data-form-type="other"
      className={className ?? "h-9 w-64 rounded-md border border-line-strong px-3 text-sm"}
    />
  );
}
