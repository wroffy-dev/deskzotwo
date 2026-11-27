import { notFound } from "next/navigation";
import { isModuleEnabled } from "@/actions/module";
import { listMissingPrices } from "@/actions/order-prices";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { MissingPrices } from "@/components/orders/missing-prices";

/**
 * Orders › Fill missing prices (owner, 3 Nov 2026): every order recorded without a price — most brought in
 * from the old system — with the product's selling price suggested, to check and save, all at once, or from
 * a CSV of the real old prices. src/actions/order-prices.ts holds the rules.
 */
export default async function MissingPricesPage({ searchParams }: { searchParams: Promise<{ q?: string; page?: string }> }) {
  if (!(await isModuleEnabled("orders"))) return <ModuleDisabledNotice moduleKey="orders" />;
  const params = await searchParams;
  const list = await listMissingPrices({ q: params.q, page: Number(params.page) || 1 });
  if (!list.allowed) notFound();
  return (
    <div className="animate-fade-rise">
      <h1 className="text-xl font-semibold text-text">Fill missing prices</h1>
      <p className="mt-1 max-w-3xl text-sm text-muted">
        Orders saved without a price — most brought in from the old system with their seats and dates but no sale price. Renewal
        values, pro-rata quotes, adding seats and renewal quotes all work from an order&apos;s price, so fill it in once here. The
        product&apos;s selling price is suggested; change it to what the customer actually paid where you know it. An order that
        already has a price is never changed.
      </p>
      <MissingPrices list={list} q={params.q ?? ""} />
    </div>
  );
}
