"use client";

import {
  Children,
  Fragment,
  forwardRef,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
  type SelectHTMLAttributes,
} from "react";
import { Check, ChevronDown, Search } from "lucide-react";
import { AnchoredPopover } from "@/components/ui/anchored-popover";
import { fieldClasses } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * A select you can type into (owner, 29 Oct 2026: "wherever a list of people to assign appears, let
 * them search it"). Drawn as the select it replaces; opening it puts a search box over the list, and
 * typing narrows it — a name out of fifty without the scroll.
 *
 * A drop-in for `<select>` / `Select`: the same props and the same `<option>` (and `<optgroup>`)
 * children. A real `<select>` stays underneath, hidden, holding the value — so a form posts it under
 * its `name`, `required` still stops a submit, `defaultValue` and a form's reset still work, and
 * picking from the list sets that select and fires its `change` event, so `onChange` (and
 * react-hook-form's `register`) see exactly what a native pick would have given them.
 *
 * Not for `multiple`. A value set from code without an event (react-hook-form's `setValue`) is shown
 * only when the select is controlled, through `value`.
 */
type Option = { value: string; label: string; disabled: boolean; group?: string };

/** An option's text, as the browser would show it: `{u.name} ({u.role})` is three children. */
function textOf(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement(node)) return textOf((node.props as { children?: ReactNode }).children);
  return "";
}

function collectOptions(children: ReactNode, out: Option[] = [], group?: string): Option[] {
  Children.forEach(children, (child) => {
    if (!isValidElement(child)) return;
    const props = child.props as { children?: ReactNode; value?: unknown; disabled?: boolean; label?: string };
    if (child.type === Fragment) collectOptions(props.children, out, group);
    else if (child.type === "optgroup") collectOptions(props.children, out, props.label);
    else if (child.type === "option") {
      const label = textOf(props.children);
      out.push({ value: props.value === undefined ? label : String(props.value), label, disabled: !!props.disabled, group });
    }
  });
  return out;
}

/**
 * The classes that place the control (its margins, width, flex share) go on the box holding it; the
 * rest (height, text size, padding, border) draw the button.
 */
const PLACING = /^-?(m[trblxy]?-|w-|min-w-|max-w-|flex-(1|auto|initial|none)$|grow|shrink|basis-|self-|order-|col-|row-|justify-self-|place-self-|hidden$|block$|inline-block$)/;
function splitClasses(className = ""): [string, string] {
  const outer: string[] = [];
  const inner: string[] = [];
  for (const token of className.split(/\s+/).filter(Boolean)) {
    const utility = token.slice(token.lastIndexOf(":") + 1).replace(/^!/, "");
    (PLACING.test(utility) ? outer : inner).push(token);
  }
  return [outer.join(" "), inner.join(" ")];
}

/** Whole words first: "ra" offers Ravi before Ankit Sharma. */
function rank(label: string, query: string) {
  const lower = label.toLowerCase();
  if (lower.startsWith(query)) return 0;
  return lower.split(/[\s(@.,-]+/).some((word) => word.startsWith(query)) ? 1 : 2;
}

export type SearchSelectProps = SelectHTMLAttributes<HTMLSelectElement> & {
  /** The search box's hint. */
  searchPlaceholder?: string;
  /** What the button shows in place of the chosen option's text and the chevron — a filter pill's face. */
  face?: (chosen: { value: string; label: string } | null) => ReactNode;
  /** Draw the button with `className` alone, without the form field's look. */
  bare?: boolean;
};

export const SearchSelect = forwardRef<HTMLSelectElement, SearchSelectProps>(function SearchSelect(
  {
    className,
    children,
    searchPlaceholder = "Search…",
    face,
    bare = false,
    id,
    disabled,
    value,
    defaultValue,
    onChange,
    onBlur,
    title,
    style,
    "aria-label": ariaLabel,
    "aria-labelledby": ariaLabelledBy,
    "aria-describedby": ariaDescribedBy,
    "aria-invalid": ariaInvalid,
    "aria-busy": ariaBusy,
    ...rest
  },
  ref,
) {
  const selectRef = useRef<HTMLSelectElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [panelWidth, setPanelWidth] = useState(240);
  const [alignEnd, setAlignEnd] = useState(false);

  const options = collectOptions(children);
  const controlled = value !== undefined;
  const [ownValue, setOwnValue] = useState(() => (defaultValue === undefined ? (options[0]?.value ?? "") : String(defaultValue)));
  const current = controlled ? String(value ?? "") : ownValue;
  // As the browser shows it: a value no option has shows the first option.
  const chosen = options.find((o) => o.value === current) ?? options[0] ?? null;

  // A prompt such as `<option value="" disabled>Choose…</option>` is the empty face, not a row.
  const rows = options.filter((o) => !(o.disabled && o.value === ""));
  const trimmed = query.trim().toLowerCase();
  const results = trimmed
    ? rows
        .filter((o) => o.label.toLowerCase().includes(trimmed))
        .map((o, i) => ({ o, i, r: rank(o.label, trimmed) }))
        .sort((a, b) => a.r - b.r || a.i - b.i)
        .map(({ o }) => o)
    : rows;

  const setRefs = useCallback(
    (el: HTMLSelectElement | null) => {
      selectRef.current = el;
      // A value set from code — react-hook-form's defaultValues, setValue and reset — lands on the element's
      // `value` with no event to say so; the button hears it here, so an edit form shows what it holds.
      const native = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value");
      if (el && native?.get && native.set) {
        const { get, set } = native;
        Object.defineProperty(el, "value", {
          configurable: true,
          get() {
            return get.call(this);
          },
          set(next: string) {
            set.call(this, next);
            setOwnValue(get.call(this));
          },
        });
      }
      if (typeof ref === "function") ref(el);
      else if (ref) ref.current = el;
    },
    [ref],
  );

  // A form's reset puts the hidden select back; the button follows it.
  useEffect(() => {
    const form = selectRef.current?.form;
    if (!form || controlled) return;
    const onReset = () => setTimeout(() => selectRef.current && setOwnValue(selectRef.current.value));
    form.addEventListener("reset", onReset);
    return () => form.removeEventListener("reset", onReset);
  }, [controlled]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      const target = event.target as HTMLElement | null;
      if (buttonRef.current?.contains(target) || target?.closest?.("[data-search-select-panel]")) return;
      // Its scrollbar: the panel scrolls in the popover's own box, which holds the panel rather than being inside it
      // (owner, 30 Oct 2026 — dragging the account manager list's scrollbar closed it).
      if (target?.closest?.("[data-anchored-popover]")?.querySelector(":scope > [data-search-select-panel]")) return;
      setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  useEffect(() => {
    if (open) document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [open, active, listId]);

  // Into the search box as the panel opens, wherever on the page the panel was drawn.
  const attachSearch = useCallback((el: HTMLInputElement | null) => {
    if (el && document.activeElement !== el) el.focus({ preventScroll: true });
  }, []);

  function openPanel(seed: string) {
    if (disabled) return;
    const rect = buttonRef.current?.getBoundingClientRect();
    if (rect) {
      const width = Math.min(Math.max(rect.width, 240), window.innerWidth - 16);
      setPanelWidth(width);
      setAlignEnd(rect.left + width > window.innerWidth - 8);
    }
    setQuery(seed);
    setActive(seed ? 0 : Math.max(0, rows.findIndex((o) => o.value === current)));
    setOpen(true);
  }

  function close(refocus: boolean) {
    setOpen(false);
    if (refocus) buttonRef.current?.focus();
    // Somebody listening for the field being left (react-hook-form's touched state) hears it here.
    if (onBlur) selectRef.current?.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  }

  function choose(option: Option) {
    if (option.disabled) return;
    close(true);
    if (!controlled) setOwnValue(option.value);
    const select = selectRef.current;
    if (select && select.value !== option.value) {
      select.value = option.value;
      // React's own `onChange` for a select is the native `change` event: this is the pick, as the
      // browser would have reported it.
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }

  function step(from: number, by: 1 | -1) {
    for (let n = 1; n <= results.length; n++) {
      const next = (from + by * n + results.length * n) % results.length;
      if (!results[next]?.disabled) return next;
    }
    return from;
  }

  function onSearchKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    switch (event.key) {
      case "ArrowDown":
      case "ArrowUp":
        event.preventDefault();
        if (results.length) setActive((a) => step(a, event.key === "ArrowDown" ? 1 : -1));
        return;
      case "Enter":
        // Never the form's submit while the list is open: Enter takes the highlighted row.
        event.preventDefault();
        if (results[active]) choose(results[active]);
        return;
      case "Escape":
        // Marked handled, so a dialog this sits in stays open (see useModalA11y).
        event.preventDefault();
        close(true);
        return;
      case "Tab":
        // Back on the button, from where Tab carries on to the next field.
        close(true);
        return;
    }
  }

  const [outer, inner] = splitClasses(className);
  const chosenOption = chosen && !(chosen.disabled && chosen.value === "") ? chosen : null;
  let lastGroup: string | undefined;

  return (
    <div className={cn("relative w-full", outer)} style={style}>
      <button
        ref={buttonRef}
        type="button"
        id={id}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        aria-describedby={ariaDescribedBy}
        aria-invalid={ariaInvalid}
        aria-busy={ariaBusy}
        title={title}
        disabled={disabled}
        onClick={() => (open ? close(false) : openPanel(""))}
        onKeyDown={(event) => {
          if (open) return;
          if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            openPanel("");
          } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
            // Typing on the closed select starts the search with that letter.
            event.preventDefault();
            openPanel(event.key);
          }
        }}
        className={cn(
          bare ? "inline-flex w-full items-center text-left" : cn(fieldClasses, "cursor-pointer items-center justify-between gap-2 pr-2 text-left"),
          inner,
        )}
      >
        {face ? (
          face(chosenOption ? { value: chosenOption.value, label: chosenOption.label } : null)
        ) : (
          <>
            <span className={cn("min-w-0 flex-1 truncate", !chosenOption && "text-subtle")}>{chosen?.label ?? ""}</span>
            <ChevronDown aria-hidden="true" className="h-4 w-4 shrink-0 text-subtle" />
          </>
        )}
      </button>
      {/* The value itself, for the form: out of sight and out of the tab order; the browser focusing it
          (a `required` left empty) hands focus to the button. */}
      <select
        ref={setRefs}
        {...rest}
        {...(controlled ? { value } : { defaultValue })}
        onChange={onChange}
        disabled={disabled}
        tabIndex={-1}
        aria-hidden="true"
        onFocus={() => buttonRef.current?.focus()}
        className="pointer-events-none absolute inset-0 h-full w-full opacity-0"
      >
        {children}
      </select>

      <AnchoredPopover anchorRef={buttonRef} open={open} width={panelWidth} align={alignEnd ? "end" : "start"} maxHeight={340}>
        <div data-search-select-panel="">
          <div className="sticky top-0 z-10 border-b border-line bg-surface p-2">
            <div className="relative">
              <Search aria-hidden="true" className="pointer-events-none absolute left-2.5 top-1/2 h-[15px] w-[15px] -translate-y-1/2 text-subtle" />
              <input
                ref={attachSearch}
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setActive(0);
                }}
                onKeyDown={onSearchKeyDown}
                placeholder={searchPlaceholder}
                autoComplete="off"
                data-1p-ignore
                data-lpignore="true"
                role="combobox"
                aria-expanded="true"
                aria-controls={listId}
                aria-autocomplete="list"
                aria-activedescendant={results[active] ? `${listId}-${active}` : undefined}
                aria-label={searchPlaceholder.replace(/…$/, "")}
                className="h-8 w-full rounded-md border border-line-strong bg-surface pl-8 pr-2.5 text-[13px] text-text placeholder:text-subtle focus-visible:border-brand"
              />
            </div>
          </div>
          <div id={listId} role="listbox" aria-label={ariaLabel ?? "Options"} className="py-1">
            {results.map((option, index) => {
              const heading = option.group !== lastGroup && option.group ? option.group : null;
              lastGroup = option.group;
              const selected = option.value === current;
              return (
                <Fragment key={`${option.group ?? ""}\u0000${option.value}\u0000${index}`}>
                  {heading && <div className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-subtle">{heading}</div>}
                  <div
                    id={`${listId}-${index}`}
                    role="option"
                    aria-selected={selected}
                    aria-disabled={option.disabled || undefined}
                    onMouseEnter={() => setActive(index)}
                    onClick={() => choose(option)}
                    className={cn(
                      "flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm",
                      index === active && "bg-surface-sunken",
                      selected ? "font-medium text-text" : "text-text",
                      option.disabled && "cursor-not-allowed text-subtle",
                    )}
                  >
                    <span className="min-w-0 flex-1 truncate">{option.label || " "}</span>
                    {selected && <Check aria-hidden="true" className="h-4 w-4 shrink-0 text-brand" />}
                  </div>
                </Fragment>
              );
            })}
            {results.length === 0 && <div className="px-3 py-2 text-sm text-subtle">Nothing matches “{query.trim()}”.</div>}
          </div>
        </div>
      </AnchoredPopover>
    </div>
  );
});
