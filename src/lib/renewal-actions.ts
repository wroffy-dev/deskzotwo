import { viewerHas } from "@/actions/permission";
import { isModuleEnabled } from "@/actions/module";

/**
 * What the person looking may do to a renewal — so Renewals shows only those (owner, 26 Nov 2026: "what if i want analyst
 * to see the renewal but can't do anything ! like actions column not accessible to him or not visible … stage also").
 *
 * Each answer is the one the action itself asks, so a button is shown exactly when pressing it would work; the actions go
 * on refusing by themselves, this only stops offering what they would refuse:
 *
 *   · stage, renew — Edit products & subscriptions or Process orders (src/actions/renewal-stage.ts, renewal-order.ts);
 *   · email the customer — either of those, or Send marketing (src/actions/order-notice.ts);
 *   · renewal proposal — Create proposals (src/actions/renewal-proposal.ts);
 *   · call — the Calls module open to them (src/actions/call.ts callsAllowed).
 *
 * Somebody who may do none of it only reads the list: no Actions column, no tick boxes, the stage a label.
 * Asked as whoever the page is for (`viewerHas`), so an admin viewing as somebody sees what they would.
 */
export type RenewalActions = { stage: boolean; renew: boolean; email: boolean; proposal: boolean; call: boolean };

export async function viewerRenewalActions(): Promise<RenewalActions> {
  const [productsEdit, process, marketing, proposal, calls] = await Promise.all([
    viewerHas("products.edit"),
    viewerHas("orders.process"),
    viewerHas("marketing.send"),
    viewerHas("docs.createProposal"),
    isModuleEnabled("calls"),
  ]);
  const works = productsEdit || process;
  return { stage: works, renew: works, email: works || marketing, proposal, call: calls };
}

/** Whether there is anything at all to offer — the Actions column, the tick boxes and the selection's own actions. */
export const worksRenewals = (a: RenewalActions) => a.stage || a.renew || a.email || a.proposal || a.call;
