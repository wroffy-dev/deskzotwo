import type { ReactNode } from "react";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * How to set WhatsApp up in Meta, step by step, inside the WhatsApp card (owner, 16 Nov 2026: "give this info
 * somewhere so its easier to setup for admin"). Open until the workspace is set up; the steps Deskzo can see — a
 * token, the app secret, a number — are ticked as they're done. Meta renames its menus now and then: the words
 * here name each place the way Meta's own screens did when this was written.
 */
export function WhatsAppSetupGuide({
  webhookUrl,
  hasToken,
  hasAppSecret,
  numbers,
}: {
  webhookUrl: string;
  hasToken: boolean;
  hasAppSecret: boolean;
  numbers: number;
}) {
  const ready = hasToken && hasAppSecret && numbers > 0;
  const steps: { title: string; done?: boolean; body: ReactNode }[] = [
    {
      title: "Have a Meta Business portfolio",
      body: (
        <>
          At <Ext href="https://business.facebook.com">business.facebook.com</Ext>, use your company&apos;s portfolio or create one. Business verification
          isn&apos;t needed to start, but it raises your sending limits and lets Meta show your business name.
        </>
      ),
    },
    {
      title: "Create a Meta app with WhatsApp",
      body: (
        <>
          At <Ext href="https://developers.facebook.com/apps">developers.facebook.com › My Apps</Ext>, choose <b>Create app</b>, pick the WhatsApp use case
          (&ldquo;Connect with customers through WhatsApp&rdquo;, or <b>Other › Business</b>), and link it to your portfolio. Create or choose the WhatsApp
          Business account when it asks.
        </>
      ),
    },
    {
      title: "Add your number to it",
      done: numbers > 0,
      body: (
        <>
          In the app, <b>WhatsApp › API Setup › Add phone number</b>: give the display name and verify the number by SMS or call. The number must not be in
          use on the WhatsApp phone app — delete that account first, or use a new number. Then choose it under <b>From</b> and copy its{" "}
          <b>Phone number ID</b> for the last step.
        </>
      ),
    },
    {
      title: "Make a permanent access token",
      done: hasToken,
      body: (
        <>
          In <b>business.facebook.com › Settings › Users › System users</b>, add an <b>Admin</b> system user. <b>Assign assets</b>: full control of the app
          and of the WhatsApp account. <b>Generate new token</b> for the app, expiry <b>Never</b>, with <code>whatsapp_business_messaging</code> and{" "}
          <code>whatsapp_business_management</code>. Paste it into <b>Access token</b> below — not the 24-hour test token from API Setup.
        </>
      ),
    },
    {
      title: "Copy the app secret",
      done: hasAppSecret,
      body: (
        <>
          In the app, <b>App settings › Basic › App secret › Show</b>, and paste it into <b>Meta app secret</b> below. Leave <b>Template language</b> as{" "}
          <code>en</code> unless your templates use another code (such as <code>en_US</code>). Then <b>Save WhatsApp settings</b>.
        </>
      ),
    },
    {
      title: "Point Meta's webhook here",
      body: (
        <>
          In the app, <b>WhatsApp › Configuration › Webhook › Edit</b>: the callback URL <code className="break-all">{webhookUrl}</code> and the verify token
          from the box below, then <b>Verify and save</b>. Under <b>Webhook fields › Manage</b>, subscribe to <b>messages</b>.
        </>
      ),
    },
    {
      title: "Put the app live",
      body: (
        <>
          Switch the app&apos;s <b>App mode</b> to <b>Live</b> (Meta asks for your privacy policy&apos;s address). While it is in development, Meta sends test
          calls only, and no customer&apos;s message reaches here.
        </>
      ),
    },
    {
      title: "Add a payment method and templates",
      body: (
        <>
          In <Ext href="https://business.facebook.com/wa/manage/home/">WhatsApp Manager</Ext>, add a payment method — Meta charges for conversations you
          start — and create <b>Message templates</b> for Meta to approve. You can reply freely within 24 hours of a customer&apos;s last message; after that,
          only an approved template can be sent.
        </>
      ),
    },
    {
      title: "Add the number here, and try it",
      done: numbers > 0,
      body: (
        <>
          <b>Add a WhatsApp number</b> below with its Phone number ID and the number as people dial it, and say whose it is: the team&apos;s or a rep&apos;s.
          Then send it a WhatsApp from your own phone: it should be in the Inbox within seconds.
        </>
      ),
    },
  ];

  return (
    <details open={!ready} className="group rounded-base border border-line text-xs">
      <summary className="cursor-pointer select-none px-3 py-2 font-medium text-text">
        How to set this up in Meta, step by step
        {ready && <span className="ml-2 font-normal text-success">Set up</span>}
      </summary>
      <ol className="space-y-3 border-t border-line px-3 py-3">
        {steps.map((step, i) => (
          <li key={step.title} className="flex gap-3">
            <span
              aria-hidden="true"
              className={cn(
                "grid h-5 w-5 shrink-0 place-items-center rounded-full text-[10px] font-semibold",
                step.done ? "bg-success-bg text-success" : "bg-surface-sunken text-muted",
              )}
            >
              {step.done ? <Check className="h-3 w-3" /> : i + 1}
            </span>
            <div className="min-w-0">
              <p className="font-medium text-text">
                {step.title}
                {step.done && <span className="sr-only"> (done)</span>}
              </p>
              <p className="mt-0.5 leading-relaxed text-muted">{step.body}</p>
            </div>
          </li>
        ))}
        <li className="rounded-base bg-surface-sunken p-2 text-muted">
          <span className="font-medium text-text">Nothing arriving?</span> Check the app is <b>Live</b> and <b>messages</b> is subscribed, and that the app
          secret is this app&apos;s: a message that fails its check is dropped. If Meta didn&apos;t connect the app to your WhatsApp account, call{" "}
          <code>POST /&lt;WhatsApp Business Account ID&gt;/subscribed_apps</code> with your token in Meta&apos;s Graph API Explorer.
        </li>
      </ol>
    </details>
  );
}

function Ext({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="text-brand underline-offset-2 hover:underline">
      {children}
    </a>
  );
}
