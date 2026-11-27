import type { ReactNode } from "react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import type { DisplayedFields } from "@/lib/custom-fields/server";
import { RevealSecret } from "@/components/custom-fields/reveal-secret";

type Reveal = () => Promise<{ ok: true; data: { secret: string } } | { ok: false; error: string }>;

/**
 * A record's own fields on its page, under their headings (src/lib/custom-fields/server.ts
 * `displayFields`). Nothing when the workspace has none this person may see; an empty value shows
 * as a dash, so a field nobody has filled in still says it exists. `action` is the Edit button.
 */
export function CustomFieldsCard({
  groups,
  action,
  title = "More details",
  fileHref,
  reveal,
}: {
  groups: DisplayedFields;
  action?: ReactNode;
  title?: string;
  /** Where a file field's file downloads from, for this record. Without it, the name alone. */
  fileHref?: (fileId: string) => string;
  /** A secret field's Reveal, bound to the record — only for those who may (src/lib/custom-fields/secure.ts). */
  reveal?: (key: string) => Reveal;
}) {
  if (groups.length === 0) return null;
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2 text-sm font-medium text-text">
        <span>{title}</span>
        {action}
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {groups.map((g) => (
          <div key={g.group || "_"} className="space-y-2">
            {g.group && <p className="text-xs font-medium text-subtle">{g.group}</p>}
            <dl className="space-y-2">
              {g.fields.map((f) => (
                <div key={f.key} className="flex flex-wrap justify-between gap-x-4 gap-y-0.5">
                  <dt className="text-muted">{f.label}</dt>
                  <dd className={`max-w-full text-right text-text ${f.type === "LONG_TEXT" ? "whitespace-pre-line text-left sm:max-w-[70%]" : "break-words"}`}>
                    {f.file && fileHref ? (
                      <a href={fileHref(f.file.id)} className="text-brand hover:underline">
                        {f.file.name}
                      </a>
                    ) : f.secretSet && reveal ? (
                      <RevealSecret masked={f.text} reveal={reveal(f.key)} />
                    ) : (
                      f.text || <span className="text-subtle">—</span>
                    )}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
