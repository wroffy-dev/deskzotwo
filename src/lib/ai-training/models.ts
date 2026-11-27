import { AI_FEATURES } from "@/lib/ai/catalogue";
import { routeFor } from "@/lib/ai/accounts";
import { FEATURE_TEAMMATE, type TeammateModels } from "@/lib/ai-training/shared";

/**
 * The models each teammate runs on now, from console › Settings › AI's routing (owner, 23 Nov 2026: "training goes to
 * the teammate — show which model that is, so we know it reaches Claude Sonnet"). Training is given by teammate, not by
 * model (./prompt.ts), so whatever model a teammate's features are routed to is given the same files. A feature with no
 * model of its own counts as its fallback's (`routeFor`); the chat's "harder questions" model (copilot.escalate) is
 * marked, and left out when it is one of the teammate's own. A teammate with nothing routed is absent.
 */
export async function teammateModels(): Promise<TeammateModels> {
  const routes = await Promise.all(AI_FEATURES.map(async (f) => ({ feature: f.key, route: await routeFor(f.key).catch(() => null) })));
  const out: TeammateModels = {};
  // Main models first, so a model that is also a teammate's main one is never listed as only for harder questions.
  const ordered = [...routes].sort((a, b) => Number(a.feature === "copilot.escalate") - Number(b.feature === "copilot.escalate"));
  for (const { feature, route } of ordered) {
    if (!route) continue;
    const list = (out[FEATURE_TEAMMATE[feature]] ??= []);
    if (list.some((m) => m.key === route.model.key)) continue;
    list.push({ key: route.model.key, label: route.model.label, providerModel: route.model.providerModel, harder: feature === "copilot.escalate" });
  }
  return out;
}
