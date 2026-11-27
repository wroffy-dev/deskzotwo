"use client";

import { Printer } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";

type Choice = { value: string; label: string; current: boolean };

/**
 * Print, and — on a tax invoice — how many copies (owner, 29 Oct 2026; Rule 48 of the CGST Rules): the original for the
 * recipient alone, or every copy the rule names, each on its own page and labelled (the print page decides which).
 *
 * Where the type has more than one print template (Settings › Document templates, owner 30 Oct 2026), which one: the
 * page reloads with `?template=`, and an empty value — the built-in Standard — drops it.
 */
export function PrintButton({ copies, templates }: { copies?: Choice[]; templates?: Choice[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const choose = (key: string, value: string) => {
    const next = new URLSearchParams(params.toString());
    if (value) next.set(key, value);
    else next.delete(key);
    const query = next.toString();
    router.replace(query ? `${pathname}?${query}` : pathname);
  };
  return (
    <div className="flex items-center gap-2">
      {templates && templates.length > 1 && (
        <Select
          aria-label="Template"
          title="Template"
          className="w-56"
          value={templates.find((t) => t.current)?.value ?? templates[0]!.value}
          onChange={(e) => choose("template", e.target.value)}
        >
          {templates.map((t) => (
            <option key={t.value || "built-in"} value={t.value}>
              {t.label}
            </option>
          ))}
        </Select>
      )}
      {copies && copies.length > 1 && (
        <Select
          aria-label="Copies to print"
          className="w-64"
          value={copies.find((c) => c.current)?.value ?? copies[0]!.value}
          onChange={(e) => choose("copies", e.target.value)}
        >
          {copies.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </Select>
      )}
      <Button onClick={() => window.print()}>
        <Printer className="h-4 w-4" /> Print / Save as PDF
      </Button>
    </div>
  );
}
