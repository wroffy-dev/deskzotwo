"use client";

import { useEffect, useRef } from "react";
import { Bold, Italic, Link2, List, ListOrdered, RemoveFormatting, Underline } from "lucide-react";
import { MERGE_FIELDS } from "@/lib/marketing/merge";

/**
 * The email builder's text editor: type, and make words bold, italic or underlined, a list or a link, or drop in a
 * merge field. What it keeps is a small set of tags (below) — the same that reach the email once the server cleans it —
 * so a paste from Word or a web page arrives as words, not its styling.
 */

const KEEP = new Set(["P", "BR", "STRONG", "B", "EM", "I", "U", "A", "UL", "OL", "LI", "SPAN", "DIV"]);

/** Only the tags kept, a link only to the web, an email or a phone (or a merge field), and no attribute but that. */
export function cleanRichText(html: string): string {
  if (typeof window === "undefined") return html;
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  const walk = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return (node.textContent ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    if (node.nodeType !== Node.ELEMENT_NODE) return "";
    const el = node as Element;
    const inner = [...el.childNodes].map(walk).join("");
    const tag = el.tagName;
    if (!KEEP.has(tag)) return inner;
    if (tag === "BR") return "<br>";
    if (tag === "DIV") return `<p>${inner}</p>`;
    if (tag === "SPAN") return inner;
    if (tag === "A") {
      const to = (el.getAttribute("href") ?? "").trim();
      return /^(https?:\/\/|mailto:|tel:|\{\{)/i.test(to) ? `<a href="${to.replace(/"/g, "&quot;")}">${inner}</a>` : inner;
    }
    const name = tag === "B" ? "strong" : tag === "I" ? "em" : tag.toLowerCase();
    return `<${name}>${inner}</${name}>`;
  };
  return [...doc.body.childNodes].map(walk).join("").trim();
}

export function RichText({ value, onChange }: { value: string; onChange: (html: string) => void }) {
  const box = useRef<HTMLDivElement>(null);
  // Where the caret was, so a field picked from the menu goes in there rather than at the start.
  const caret = useRef<Range | null>(null);
  const keep = () => {
    const sel = window.getSelection();
    if (sel && sel.rangeCount && box.current?.contains(sel.anchorNode)) caret.current = sel.getRangeAt(0).cloneRange();
  };
  // Written into the box once — as it opens, or when another block is chosen — never while typing, or the caret jumps.
  useEffect(() => {
    if (box.current && cleanRichText(box.current.innerHTML) !== cleanRichText(value)) box.current.innerHTML = cleanRichText(value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const changed = () => box.current && onChange(cleanRichText(box.current.innerHTML));
  const run = (command: string, arg?: string) => {
    box.current?.focus();
    const sel = window.getSelection();
    if (caret.current && sel) {
      sel.removeAllRanges();
      sel.addRange(caret.current);
    }
    document.execCommand(command, false, arg);
    changed();
  };
  const addLink = () => {
    const to = window.prompt("Link to (https://…, mailto:… or tel:…)", "https://");
    if (to && /^(https?:\/\/|mailto:|tel:|\{\{)/i.test(to.trim())) run("createLink", to.trim());
  };

  const tool = "flex h-7 w-7 items-center justify-center rounded text-muted hover:bg-surface-sunken hover:text-text";
  return (
    <div className="rounded-base border border-line-strong bg-surface">
      <div className="flex flex-wrap items-center gap-0.5 border-b border-line px-1 py-1">
        <button type="button" className={tool} title="Bold" onMouseDown={(e) => (e.preventDefault(), run("bold"))}>
          <Bold className="h-3.5 w-3.5" />
        </button>
        <button type="button" className={tool} title="Italic" onMouseDown={(e) => (e.preventDefault(), run("italic"))}>
          <Italic className="h-3.5 w-3.5" />
        </button>
        <button type="button" className={tool} title="Underline" onMouseDown={(e) => (e.preventDefault(), run("underline"))}>
          <Underline className="h-3.5 w-3.5" />
        </button>
        <button type="button" className={tool} title="Bulleted list" onMouseDown={(e) => (e.preventDefault(), run("insertUnorderedList"))}>
          <List className="h-3.5 w-3.5" />
        </button>
        <button type="button" className={tool} title="Numbered list" onMouseDown={(e) => (e.preventDefault(), run("insertOrderedList"))}>
          <ListOrdered className="h-3.5 w-3.5" />
        </button>
        <button type="button" className={tool} title="Link" onMouseDown={(e) => (e.preventDefault(), addLink())}>
          <Link2 className="h-3.5 w-3.5" />
        </button>
        <button type="button" className={tool} title="Clear formatting" onMouseDown={(e) => (e.preventDefault(), run("removeFormat"), run("unlink"))}>
          <RemoveFormatting className="h-3.5 w-3.5" />
        </button>
        <MergeFieldMenu onPick={(token) => run("insertText", token)} />
      </div>
      <div
        ref={box}
        contentEditable
        suppressContentEditableWarning
        onInput={() => (keep(), changed())}
        onKeyUp={keep}
        onMouseUp={keep}
        onBlur={() => (keep(), changed())}
        onPaste={(e) => {
          // Pasted as words — another program's styling stays behind.
          e.preventDefault();
          document.execCommand("insertText", false, e.clipboardData.getData("text/plain"));
          changed();
        }}
        className="min-h-32 px-3 py-2 text-sm text-text outline-none [&_a]:text-brand [&_a]:underline [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:mb-2 [&_ul]:list-disc [&_ul]:pl-5"
      />
    </div>
  );
}

/** The merge fields, to drop into text: {{firstName|there}} rather than a name typed in. */
export function MergeFieldMenu({ onPick }: { onPick: (token: string) => void }) {
  const fallback: Record<string, string> = { firstName: "there", fullName: "there", companyName: "your company", ownerName: "your account manager", productName: "your subscription", expiryDate: "its renewal date", daysLeftPhrase: "" };
  return (
    <select
      aria-label="Insert a merge field"
      value=""
      onMouseDown={(e) => e.stopPropagation()}
      onChange={(e) => {
        const key = e.target.value;
        if (!key) return;
        onPick(key in fallback ? `{{${key}|${fallback[key]}}}` : `{{${key}}}`);
        e.target.value = "";
      }}
      className="ml-auto h-7 rounded border border-line bg-surface px-1 text-xs text-muted"
    >
      <option value="">Insert field…</option>
      {MERGE_FIELDS.filter((f) => !["formName", "formLink", "eventDate", "eventVenue", "inviterName", "unsubscribeUrl"].includes(f.key)).map((f) => (
        <option key={f.key} value={f.key}>
          {f.label}
        </option>
      ))}
    </select>
  );
}
