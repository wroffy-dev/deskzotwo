import type { Metadata } from "next";
import { getQuestionnaire } from "@/actions/questionnaire-public";
import { Card } from "@/components/ui/card";
import { QuestionnaireForm } from "@/components/projects/questionnaire-form";

/**
 * A project's questionnaire, as the customer's email links to it (owner, 16 Nov 2026 — src/actions/questionnaire-public.ts).
 *
 * The token in the address answers this one questionnaire, so the page is never indexed and never hands the address on
 * in a Referer header.
 */
export const metadata: Metadata = {
  title: "A few questions",
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

export default async function QuestionnairePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const page = await getQuestionnaire(token);
  // One page for every way the link can be wrong — unknown, withdrawn, replaced by a newer email — so it says nothing
  // about which links exist.
  if (!page) {
    return (
      <Card className="mx-auto max-w-lg px-6 py-12 text-center">
        <h1 className="text-lg font-semibold text-text">This questionnaire isn&apos;t available</h1>
        <p className="mt-2 text-sm text-muted">
          It may have been withdrawn, or a newer email has a fresh link. If you think it should work, reply to the email it came in.
        </p>
      </Card>
    );
  }
  return <QuestionnaireForm token={token} page={page} />;
}
