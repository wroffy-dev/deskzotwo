import type { Metadata } from "next";
import { Card } from "@/components/ui/card";
import { PublicFormFiller } from "@/components/smart-lists/list-forms";
import { publicFormFor } from "@/lib/smart-lists/public-forms";

/** Kept out of search engines: the address is the only key, and a list's form is meant for whoever was sent it. */
export const metadata: Metadata = { title: "Form", robots: { index: false, follow: false } };

/**
 * A Smart List form's public link (owner, 20 Nov 2026 — Smart Lists phase 4, src/lib/smart-lists/public-forms.ts): for
 * people outside the company, signed in or not. The form's name, what it's for and its questions — never the list, its
 * rows or the company's people. A link that never was, was turned off or whose form closed reads the same.
 */
export default async function PublicListFormPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const form = await publicFormFor(slug);
  if (!form) {
    return (
      <Card className="mx-auto max-w-lg px-6 py-12 text-center">
        <h1 className="text-lg font-semibold text-text">This form isn&apos;t available</h1>
        <p className="mt-2 text-sm text-muted">It may have been closed. Try the address it was linked from.</p>
      </Card>
    );
  }
  return (
    <div className="mx-auto max-w-xl space-y-4">
      <div>
        <p className="text-sm text-muted">{form.ourName}</p>
        <h1 className="text-xl font-semibold text-text">{form.name}</h1>
        {form.intro && <p className="mt-1 whitespace-pre-line text-sm text-muted">{form.intro}</p>}
      </div>
      <PublicFormFiller form={form} />
    </div>
  );
}
