import type { Metadata } from "next";
import { Card } from "@/components/ui/card";
import { PollAnswer } from "@/components/marketing/poll-answer";
import { getOrganisation } from "@/lib/organisation";
import { pollAsk } from "@/lib/marketing/polls";

export const metadata: Metadata = { title: "Your answer", referrer: "no-referrer", robots: { index: false, follow: false } };

/**
 * Where a poll's button in an email lands (owner, 1 Nov 2026 — src/lib/marketing/email-widgets.ts): the question,
 * the answer they picked, and one press to send it. Opening the page changes nothing — mail scanners open links.
 */
export default async function PollAnswerPage({ params, searchParams }: { params: Promise<{ token: string }>; searchParams?: Promise<{ q?: string; a?: string }> }) {
  const { token } = await params;
  const { q = "", a = "" } = (await searchParams) ?? {};
  const org = await getOrganisation();
  const ours = org.tradeName || org.legalName || "us";
  const ask = await pollAsk(String(token), String(q), String(a), ours);
  if (!ask) {
    return (
      <Card className="mx-auto max-w-lg px-6 py-12 text-center">
        <h1 className="text-lg font-semibold text-text">This answer can&apos;t be counted</h1>
        <p className="mt-2 text-sm text-muted">The link may be from a preview or a test email, or out of date.</p>
      </Card>
    );
  }
  return (
    <Card className="mx-auto max-w-lg space-y-3 px-6 py-10 text-center">
      <h1 className="text-lg font-semibold text-text">{ask.question}</h1>
      {ask.current === ask.answer ? (
        <p className="text-sm text-success">Thanks — {ours} already has “{ask.answer}” from you.</p>
      ) : (
        <>
          <p className="text-sm text-muted">{ask.current ? `You answered “${ask.current}” before. Change it to “${ask.answer}”?` : `Your answer: “${ask.answer}”.`}</p>
          <div className="flex justify-center">
            <PollAnswer token={String(token)} question={ask.question} answer={ask.answer} ours={ours} />
          </div>
        </>
      )}
    </Card>
  );
}
