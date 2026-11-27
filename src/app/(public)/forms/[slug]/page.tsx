import type { Metadata } from "next";
import { getForm } from "@/actions/marketing-public";
import { Card } from "@/components/ui/card";
import { InboundForm } from "@/components/marketing/inbound-form";
import { db } from "@/lib/db";
import { formWebsite } from "@/lib/forms/website";

/**
 * Unlike the other public pages, this one *wants* to be found — it is a landing page, and its URL
 * is a slug rather than a token, so there is nothing in it to leak.
 */
export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const form = await getForm(slug);
  return { title: form ? `${form.headline ?? form.name} — ${form.ourName}` : "Not available" };
}

export default async function FormPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams?: Promise<{ embed?: string }> }) {
  const [{ slug }, query] = await Promise.all([params, searchParams]);
  const embed = query?.embed;
  const form = await getForm(slug);

  if (!form) {
    return (
      <Card className="mx-auto max-w-lg px-6 py-12 text-center">
        <h1 className="text-lg font-semibold text-text">This form isn&apos;t available</h1>
        <p className="mt-2 text-sm text-muted">It may have been closed. Try the address it was linked from.</p>
      </Card>
    );
  }

  // In a pop-up's frame on the business's website (src/lib/forms/website-rules.ts): the form alone.
  if (embed === "1") return <InboundForm form={form} />;

  // Its landing page (owner, 1 Nov 2026): a picture, a few highlights and a quote beside the form, where it has one.
  const id = (await db.inboundForm.findUnique({ where: { slug }, select: { id: true } }))?.id;
  const { landing } = id ? await formWebsite(id) : { landing: null };
  if (!landing?.on || (!landing.image && landing.highlights.length === 0 && !landing.quote)) return <InboundForm form={form} />;
  return (
    <div className="mx-auto grid max-w-5xl items-start gap-6 lg:grid-cols-2">
      <div className="space-y-5">
        {landing.image && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={landing.image} alt="" className="w-full rounded-2xl object-cover shadow-sm" />
        )}
        {landing.highlights.length > 0 && (
          <ul className="space-y-2">
            {landing.highlights.map((h) => (
              <li key={h} className="flex items-start gap-2 text-base text-text">
                <span aria-hidden className="mt-1 inline-block h-2 w-2 shrink-0 rounded-full bg-brand" />
                {h}
              </li>
            ))}
          </ul>
        )}
        {landing.quote && (
          <blockquote className="border-l-4 border-brand pl-4 text-sm italic text-muted">
            “{landing.quote}”{landing.quoteBy && <footer className="mt-1 not-italic text-subtle">— {landing.quoteBy}</footer>}
          </blockquote>
        )}
      </div>
      <InboundForm form={form} />
    </div>
  );
}
