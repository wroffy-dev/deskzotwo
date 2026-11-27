import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { listFeedback } from "@/actions/feedback";
import { getOrganisation } from "@/lib/organisation";
import { Card } from "@/components/ui/card";
import { ClearFilters, ToolbarSearch } from "@/components/ui/filter-toolbar";
import { ListHeader } from "@/components/ui/list-header";
import { SelectParamFilter } from "@/components/ui/select-param-filter";
import { FeedbackList } from "@/components/feedback/feedback-list";
import { FeedbackSummaryStrip } from "@/components/feedback/feedback-summary";
import { AlertTriangle, ListFilter } from "lucide-react";
import { tenantOrigin } from "@/lib/tenancy/resolve";

export default async function FeedbackPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; search?: string; companyId?: string }>;
}) {
  const enabled = await isModuleEnabled("feedback");
  if (!enabled) return <ModuleDisabledNotice moduleKey="feedback" />;

  const params = await searchParams;
  const [{ rows, summary, viewAll }, org] = await Promise.all([listFeedback(params), getOrganisation()]);

  // The link has to survive being pasted into WhatsApp, so it needs an absolute URL. Taken from the
  // request rather than an env var, so it is right on localhost, on staging and in production.
  const origin = await tenantOrigin();

  return (
    <div className="animate-fade-rise">
      <ListHeader
        title="Customer feedback"
        search={<ToolbarSearch paramName="search" placeholder="Search" label="Company, reference or what they wrote" />}
        filters={
          <>
            <SelectParamFilter
              variant="pill"
              icon={<ListFilter />}
              paramName="view"
              label="Show"
              options={[
                { value: "answered", label: "Answered" },
                { value: "waiting", label: "Waiting for a reply" },
                { value: "unhappy", label: "3 stars or below" },
                { value: "unanswered", label: "Low scores nobody has answered" },
              ]}
            />
            <ClearFilters params={["search", "view"]} />
          </>
        }
      />
      <p className="mt-1 max-w-2xl text-sm text-muted">
        One-time links sent to customers, and what came back. Every answer is kept here whatever the score — a
        happy one can also be offered the public review page.
        {!viewAll && " You're seeing feedback about you, feedback you asked for, and your own accounts."}
      </p>

      {!org.feedbackReviewUrl && (
        <Card className="mt-5 border-warning/40 bg-warning-bg px-4 py-3 text-sm text-warning">
          <span className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              No public review page is set up, so nobody is being offered one — the feedback is still recorded. Add
              your Google Business Profile review link in Settings → Organisation.
            </span>
          </span>
        </Card>
      )}

      <div className="mt-5">
        <FeedbackSummaryStrip summary={summary} />
      </div>

      <div className="mt-4">
        <FeedbackList
          rows={rows}
          origin={origin}
          emptyHint="Nothing yet. Open a customer and use “Ask for feedback” — the link works once and expires."
        />
      </div>
    </div>
  );
}
