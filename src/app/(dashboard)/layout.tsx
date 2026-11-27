import { createHash } from "node:crypto";
import { Suspense } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import Link from "next/link";
import { Eye, LogOut } from "lucide-react";
import { auth, signOut } from "@/lib/auth";
import { db } from "@/lib/db";
import { notMigratedYet } from "@/lib/not-migrated";
import { forcedSetupFor } from "@/lib/forced-setup";
import { ForcedSetupGuard } from "@/components/layout/forced-setup-guard";
import { Button } from "@/components/ui/button";
import { Avatar } from "@/components/ui/avatar";
import { workspaceNotices } from "@/actions/billing";
import { currentTenant, currentTenantOrNull } from "@/lib/tenancy/resolve";
import { canBroadcastNotes } from "@/actions/note";
import { Sidebar } from "@/components/layout/sidebar";
import { NavBreadcrumb } from "@/components/layout/nav-breadcrumb";
import { ShortcutsProvider } from "@/components/shortcuts/shortcuts-provider";
import { SideRail } from "@/components/layout/side-rail";
import { CreateMenu } from "@/components/layout/create-menu";
import { NotificationBell } from "@/components/layout/notification-bell";
import { HeartbeatTracker } from "@/components/layout/heartbeat-tracker";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { getBranding } from "@/actions/branding";
import { getTablePreferences } from "@/actions/table-preference";
import { pendingSplash } from "@/actions/survey";
import { SurveySplash } from "@/components/engagement/survey-splash";
import { TableColumnsProvider } from "@/components/ui/table-columns";
import { WordingProvider } from "@/components/terms/wording-provider";
import { CompanyLinksProvider } from "@/components/companies/company-link";
import { ClockProvider } from "@/components/time/clock-provider";
import { TeammatesProvider } from "@/components/ai/teammate-avatar";
import { workspaceTeammates } from "@/lib/ai/teammates-server";
import { workspaceZone } from "@/lib/time/workspace";
import { getWording } from "@/lib/terms/server";
import { viewAsContext } from "@/lib/session";
import { clearViewAsCookie } from "@/lib/impersonation";
import { listViewAsTargets } from "@/actions/impersonation";
import { ViewAsSwitcher } from "@/components/layout/view-as-switcher";
import { CelebrationSplash } from "@/components/layout/celebration-splash";
import { WishesCorner } from "@/components/layout/wishes-corner";
import { todaysMoments } from "@/lib/hr/today";
import { wishesForLayout } from "@/lib/hr/wishes";
import { getSecurityPolicy } from "@/lib/security/store";
import { dlpApplies, hasAnyDeterrent } from "@/lib/security/policy";
import { recordPageView } from "@/lib/security/page-view";
import { DlpGuard } from "@/components/security/dlp-guard";
import { Watermark } from "@/components/security/watermark";
import { MaintenanceBanner } from "@/components/layout/maintenance-banner";
import { InstallApp } from "@/components/layout/install-app";
import { OfflineKeeper } from "@/components/layout/offline-keeper";
import { offlineUserKey } from "@/lib/offline-pages";
import { AppTabBar } from "@/components/layout/app-tab-bar";
import { appMetadata, homeScreenName } from "@/lib/pwa";
import { getCopilotAvailability } from "@/actions/copilot";
import { CopilotButton } from "@/components/copilot/copilot-panel";
import { HeaderSearch } from "@/components/layout/header-search";
import { searchScopesForMe } from "@/actions/search";
import { unreadUpdateCounts } from "@/actions/help";
import { can } from "@/lib/authz/resolve";
import { accessContextFor, isModuleEntitled } from "@/lib/modules-access";
import { buildNavigation } from "@/lib/navigation";
import { applySidebarOrder, hasSidebarOrder, readSidebarOrder } from "@/lib/navigation-order";
import { activeAnnouncementsFor } from "@/lib/platform/announcements";
import { PlatformAnnouncements } from "@/components/platform/platform-announcements";
import { supportLauncherState } from "@/actions/support";
import { getSupportAccess } from "@/actions/support-access";
import { SupportLauncher } from "@/components/support/support-launcher";
import { linkedSignInEnabled } from "@/lib/platform/linked/groups";
import { PLATFORM_DOMAIN } from "@/lib/tenancy/host";
import { WorkspaceSwitcher } from "@/components/linked/workspace-switcher";
import { OnboardingWizard } from "@/components/onboarding/onboarding-wizard";
import { ChatLiveProvider } from "@/components/chat/chat-live";
import { ChatButton } from "@/components/chat/chat-button";
import { ChatMentionWindows } from "@/components/chat/chat-mention-windows";
import { unreadTotal } from "@/lib/chat/server";
import { chatChimes, parseReminderSounds } from "@/lib/reminder-sounds";
import { wizardAutoOpens, wizardMounted } from "@/lib/help/onboarding";
import { TeamStrip } from "@/components/ai/teammate-live";

/** Chat's live connection around the app, or nothing at all where chat isn't open to this person. */
function ChatGate({ on, meId, unread, sound, children }: { on: boolean; meId: string; unread: number; sound: boolean; children: React.ReactNode }) {
  return on ? (
    <ChatLiveProvider meId={meId} initialUnread={unread} sound={sound}>
      {children}
    </ChatLiveProvider>
  ) : (
    <>{children}</>
  );
}

/** Nothing unread on either side — for nobody signed in, or a count that could not be read. */
const NO_UNREAD = { deskzo: 0, company: 0 };

/** Installable as the workspace's app on a phone's home screen — an iPhone's above all (src/lib/pwa.ts). */
export const generateMetadata = appMetadata;

/**
 * The page reaches the screen's edges, so the phone's tab bar can sit above an iPhone's home bar rather than under
 * it (the bar pads itself by the safe area).
 */
export const viewport = { width: "device-width", initialScale: 1, viewportFit: "cover" } as const;

/**
 * Security audit round two, 13 Nov 2026 (R2-05): a workspace held for non-payment opens only its billing
 * page (src/lib/tenancy/hold.ts), and gets it in a bare shell — no search, copilot, chat, onboarding
 * wizard or menus, none of whose actions it may run any more (src/lib/session.ts refuses them). Just
 * the page, and a way to sign out.
 */
async function HeldForBillingShell({ children }: { children: React.ReactNode }) {
  const [wording, zone] = await Promise.all([getWording(), workspaceZone()]);
  return (
    <WordingProvider initial={wording}>
      <ClockProvider zone={zone}>
        <div className="flex min-h-screen flex-col bg-bg">
          <header className="flex h-14 items-center justify-end border-b border-line bg-surface px-4 md:px-6">
            <form
              action={async () => {
                "use server";
                await clearViewAsCookie();
                await signOut({ redirectTo: "/login" });
              }}
            >
              <Button type="submit" variant="ghost" size="sm">
                <LogOut aria-hidden="true" className="mr-1.5 h-4 w-4" />
                Sign out
              </Button>
            </form>
          </header>
          <main className="mx-auto w-full max-w-[1200px] flex-1 px-4 py-6 md:px-6 md:py-8">{children}</main>
        </div>
      </ClockProvider>
    </WordingProvider>
  );
}

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const tenantNow = await currentTenantOrNull().catch(() => null);
  if (tenantNow?.status === "SUSPENDED" && tenantNow.holdReason === "BILLING") return <HeldForBillingShell>{children}</HeldForBillingShell>;
  const [session, requestHeaders, branding, viewAs, securityPolicy, wording, zone, teammates] = await Promise.all([
    auth(),
    headers(),
    getBranding(),
    viewAsContext(),
    getSecurityPolicy(),
    // The workspace's own words (Settings → Wording, src/lib/terms) — the menu's, and every client
    // component's through WordingProvider. Never throws.
    getWording(),
    // The workspace's clock (Settings → Profile, src/lib/time) — every client component's through
    // ClockProvider.
    workspaceZone(),
    // The AI teammates as this workspace names them (src/lib/ai/teammates.ts) — every client component's through
    // TeammatesProvider.
    workspaceTeammates(),
  ]);
  // While viewing as someone else, every chrome element below describes them, not the admin — the
  // point of the feature is to see their app, and a header still showing the admin's name and role
  // would make it impossible to tell whose permissions a page was rendered with.
  const shownUser = viewAs?.user ?? session?.user;
  /**
   * What this person may open — the plan, the company's switches and their permissions, resolved
   * once for the request and for whoever it is acting as, so an admin viewing as a salesperson sees
   * the salesperson's menu. The sidebar, the Create menu and the rail are drawn from it; the pages
   * and actions they lead to ask the same rule again (src/lib/navigation.ts). Read fresh on every
   * request, so a permission taken away is gone from the menu on the next page.
   */
  const [access, viewAsTargets, tablePreferences, canBroadcast, splash, copilot, searchScopes, unreadUpdates, canManageHelp, supportLauncher, supportAccess] = await Promise.all([
    shownUser ? accessContextFor(shownUser.id) : Promise.resolve(null),
    listViewAsTargets(),
    // One read for every table on every page — see src/components/ui/table-columns.tsx for why this
    // is hoisted rather than fetched per table.
    getTablePreferences(),
    // Whether the Create menu's note composer offers "Everyone". `canBroadcastNotes` resolves the
    // acting user through `requireUser`, so it already follows "view as" — but it throws when
    // nobody is signed in, and this layout renders in that case rather than redirecting.
    shownUser ? canBroadcastNotes() : Promise.resolve(false),
      // The skip is per session, so nothing is passed in: a dismissal the server remembered would
    // make "not now" permanent, which is the opposite of what a mandatory form needs.
    isModuleEntitled("engagement").then((has) => (has ? pendingSplash([]) : null)),
    // Not while viewing as somebody: a copilot chat is private, and would open as theirs.
    shownUser && !viewAs ? getCopilotAvailability().catch(() => null) : Promise.resolve(null),
    // The header search offers only the lists this person can open — src/actions/search.ts. Like
    // the sidebar, it follows "view as".
    shownUser ? searchScopesForMe().catch(() => []) : Promise.resolve([]),
    // What's new, Deskzo's and the company's counted apart (src/actions/help.ts): the rail gives each its
    // own dot. Deskzo's side is a minute-long shared copy that never throws, so it costs a page nothing.
    shownUser ? unreadUpdateCounts().catch(() => NO_UNREAD) : Promise.resolve(NO_UNREAD),
    shownUser ? can(shownUser.id, "help.manage") : Promise.resolve(false),
    // The platform's Contact Support button — null for a view-as, platform support staff, or support
    // switched off. Never throws, and reads its settings from a minute-long copy with a 1.5 s limit,
    // so a slow control plane costs a page nothing (src/actions/support.ts).
    session?.user && !viewAs ? supportLauncherState() : Promise.resolve(null),
    // The rail's door for Deskzo support — the super admin's alone, null for everybody else
    // (src/actions/support-access.ts). A control plane out of reach only hides the button.
    session?.user && !viewAs ? getSupportAccess().catch(() => null) : Promise.resolve(null),
]);

  const permissions: string[] = access?.permissions ?? [];
  const openModules = access?.openModules ?? [];
  // In the person's own order, where they arranged it (src/lib/navigation-order.ts) — the shown person's while viewing as
  // somebody, as the rest of the menu is. Only the order: what is in it is buildNavigation's alone.
  const sidebarOrder = shownUser
    ? await db.user
        .findUnique({ where: { id: shownUser.id }, select: { sidebarOrder: true } })
        .then((u) => readSidebarOrder(u?.sidebarOrder))
        .catch((err: unknown) => {
          if (notMigratedYet(err)) return {};
          throw err;
        })
    : {};
  const navigation = access ? applySidebarOrder(buildNavigation(access), sidebarOrder) : [];

  // Not while viewing as somebody else: an admin borrowing an account should not be wished a happy
  // birthday on their behalf, and dismissing it would mark it seen for a person who never saw it.
  const today = viewAs ? null : await todaysMoments();
  // Wishes on the shown person's birthday or work anniversary today — an admin viewing as them sees
  // theirs, read-only. Empty on any other day; never throws (src/lib/hr/wishes.ts).
  const wishes = shownUser ? await wishesForLayout(shownUser.id) : [];
  // The reminder while a trial or a grace period runs, and the workspace's storage from 80% full (one control-plane row,
  // read at most once a minute — src/lib/storage-view.ts), to whoever manages billing — null for everybody else.
  const notices = session?.user && !viewAs ? await workspaceNotices().catch(() => null) : null;
  const billing = notices?.billing ?? null;
  const storageNotice = notices?.storage ?? null;
  // The platform's announcements for this workspace. Cached for a minute and never throws, so a
  // control plane that is down or slow costs a page nothing (src/lib/platform/announcements.ts).
  const announcements = session?.user ? await activeAnnouncementsFor(await currentTenant()) : [];

  const currentPath = requestHeaders.get("x-pathname") ?? "";
  // Skipped while viewing as someone else: "you must change your password" is about the person
  // signed in, and forcing an admin into a borrowed account's password form would be both useless
  // and the start of an account takeover.
  // Read on /profile too, where the redirect lands: the onboarding wizard stays shut over that form.
  let forcedSetup = false;
  if (session?.user && !viewAs) {
    forcedSetup = await forcedSetupFor(session.user.id, session.user.sid);
    if (forcedSetup && !currentPath.startsWith("/profile")) {
      redirect("/profile");
    }
  }

  // Resolved against whoever the request is acting as, so an admin viewing as a salesperson sees
  // the salesperson's restrictions. That is the point of "view as" — an admin who wants to know
  // why somebody cannot copy an order number should experience it, not read about it.
  // The session token has no photo marker on it, so it is read here. One tiny column, and it
  // resolves against whoever the request is acting as — an admin viewing as somebody should see
  // that person's face in the header, for the same reason the name and role already change.
  // The same read carries the account's kind, for the workspace switcher below.
  const viewer = shownUser
    ? await db.user.findUnique({ where: { id: shownUser.id }, select: { photoUpdatedAt: true, kind: true, onboardingCompletedAt: true, roleRef: { select: { name: true } } } })
    : null;
  const viewerPhotoUpdatedAt = viewer?.photoUpdatedAt ?? null;
  // Linked sign-in's workspace switcher (spec §2.1): the person's own member account only — never while
  // viewing as somebody (then `viewer` is them), never a platform support account — and only while the
  // platform's switch is on, which it never is without a control plane. That answer is cached for 30 s;
  // the list itself is asked for only when the switcher is opened.
  const canSwitch = !viewAs && !!session?.user && viewer?.kind === "MEMBER" && (await linkedSignInEnabled());

  const dlpOn = dlpApplies(shownUser?.role, securityPolicy) && hasAnyDeterrent(securityPolicy);

  // Team chat (src/lib/chat): one live connection for the whole app, and its unread count — for the
  // person as themselves only. Chats are private, so never while viewing as somebody.
  const chatOn = !!session?.user && !viewAs && openModules.includes("chat");
  // While viewing as somebody, their chat button and rail tool still show — the screen should be theirs —
  // but lead only to a note that chats are private; nothing of theirs is read.
  const chatShown = !!shownUser && openModules.includes("chat");
  const chatUnread = chatOn ? await unreadTotal(session!.user.id).catch(() => 0) : 0;
  // Its chime follows the person's sounds (Notifications → Sounds); on unless they turned it off.
  const chatSound = chatOn
    ? chatChimes(
        parseReminderSounds(
          (await db.user.findUnique({ where: { id: session!.user.id }, select: { reminderSounds: true } }).catch(() => null))?.reminderSounds,
        ),
      )
    : false;

  // The Getting Started wizard (src/lib/help/onboarding.ts): for a person still being onboarded, signed in as
  // themselves; never while viewing as somebody (then `viewer` is them). It opens by itself once per sign-in — the
  // key names the sign-in without carrying its id to the page — except over a forced password or two-factor form.
  const onboardingGate = { person: viewer, viewingAs: !!viewAs, forcedSetup };
  const onboarding =
    session?.user && wizardMounted(onboardingGate)
      ? {
          autoOpen: wizardAutoOpens(onboardingGate),
          signInKey: createHash("sha256").update(`onboarding|${session.user.sid ?? session.user.id}`).digest("hex").slice(0, 16),
        }
      : null;

  // Only when the admin has asked for it — see recordPageView. Not awaited: a page must not wait on
  // its own audit trail, and the write is throttled so a burst of navigation is one row anyway.
  if (shownUser && currentPath) {
    void recordPageView({
      userId: shownUser.id,
      userName: shownUser.name,
      role: shownUser.role,
      path: currentPath,
    });
  }

  return (
    <TableColumnsProvider initial={tablePreferences}>
    <WordingProvider initial={wording}>
    <ClockProvider zone={zone}>
    <TeammatesProvider teammates={teammates}>
    {/* A company is a link only for somebody who may open one (src/components/companies/company-link.tsx). */}
    <CompanyLinksProvider open={openModules.includes("companies")}>
    <ChatGate on={chatOn} meId={session?.user?.id ?? ""} unread={chatUnread} sound={chatSound}>
    <div className="flex min-h-screen bg-bg">
      {/* Not while impersonating: the heartbeat accrues "time spent on the CRM" against whoever the
          request resolves as, and an admin reading somebody's screen is not that person working. */}
      {!viewAs && <HeartbeatTracker />}

      {/* Never while impersonating: putting a mandatory form in front of an admin who is viewing as
          somebody else would record an answer from the wrong person, on a form that cannot be
          answered twice. */}
      {!viewAs && splash && <SurveySplash pending={splash} />}

      {onboarding && <OnboardingWizard autoOpen={onboarding.autoOpen} signInKey={onboarding.signInKey} />}

      {dlpOn && (
        <>
          <DlpGuard
            policy={{
              blockCopy: securityPolicy.blockCopy,
              blockCut: securityPolicy.blockCut,
              blockPaste: securityPolicy.blockPaste,
              blockContextMenu: securityPolicy.blockContextMenu,
              blockTextSelection: securityPolicy.blockTextSelection,
              blockPrint: securityPolicy.blockPrint,
              blockDevTools: securityPolicy.blockDevTools,
              blurOnBlur: securityPolicy.blurOnBlur,
              screenshotLimitPerDay: securityPolicy.screenshotLimitPerDay,
            }}
          />
          {securityPolicy.watermarkEnabled && shownUser && (
            <Watermark
              // The address as well as the name: two people called Amit make a name-only watermark
              // useless at exactly the moment it is needed.
              label={`${shownUser.name} · ${shownUser.email}`}
              opacity={securityPolicy.watermarkOpacity}
              scope={securityPolicy.watermarkScope}
            />
          )}
        </>
      )}
      <Sidebar
        navigation={navigation}
        // Arranging is the person's own, and never somebody else's while viewing as them.
        arrangeable={!!session?.user && !viewAs}
        arranged={hasSidebarOrder(sidebarOrder)}
        branding={branding}
        support={!!supportLauncher}
        // On a phone the header has no room for these; they are at the foot of the menu drawer instead (owner,
        // 31 Oct 2026: the phone's header kept to menu, search, +, AI, bell and the photo).
        drawerExtras={
          <div className="space-y-1">
            <div className="flex items-center justify-between gap-2 py-1">
              Theme <ThemeToggle defaultTheme={branding.defaultTheme} />
            </div>
            {canSwitch && (
              <div className="flex items-center justify-between gap-2 py-1">
                Workspace
                <WorkspaceSwitcher current={{ name: (await currentTenant()).name, initials: "", logoDataUrl: branding.logoDataUrl }} domain={PLATFORM_DOMAIN} />
              </div>
            )}
            {!viewAs && viewAsTargets.length > 0 && (
              <div className="flex items-center justify-between gap-2 py-1">
                View as someone
                <ViewAsSwitcher targets={viewAsTargets} viewingAs={null} />
              </div>
            )}
            {/* The header's own form, hidden on a phone, is what this submits. */}
            <button type="submit" form="deskzo-sign-out" className="flex w-full items-center gap-2 rounded-base py-1.5 text-left text-sm text-text hover:text-danger">
              <LogOut aria-hidden="true" className="h-4 w-4" />
              Sign out
            </button>
          </div>
        }
      />

      {/*
        Clipped sideways (owner, 29 Oct 2026): nothing on a page may make the window wider than it — the leads board,
        scrolled to its last column, carried on into a blank strip beside the rail. `clip`, not `hidden`: it makes no
        scroll box, so the sticky header still sticks. `relative`, so an element positioned inside is clipped here too
        rather than placed against the window, past the clip.
      */}
      <div className={`relative flex min-w-0 flex-1 flex-col overflow-x-clip${viewAs ? " ring-2 ring-inset ring-warning/50" : ""}`}>
        {/* Sticky so the controls stay reachable when a long table scrolls. */}
        <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-line bg-surface/85 px-4 backdrop-blur-md md:px-6">
          {/* Leaves room for the mobile menu button, which floats over this corner. */}
          <div className="w-9 shrink-0 md:hidden" />
          {/* Everything a person may open, from one box — their lists, their menu's pages and the help. */}
          {shownUser && <HeaderSearch scopes={searchScopes} navigation={navigation} />}
          {viewAs && (
            <span className="flex min-w-0 items-center gap-1.5 rounded-full bg-warning-bg px-2.5 py-1 text-xs font-medium text-warning">
              <Eye className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">
                Viewing as {viewAs.user.name}
                <span className="hidden sm:inline"> · you are {viewAs.actor.name}</span>
              </span>
            </span>
          )}
          {/* `min-w-0` so the name below can give way; nothing here may push the page sideways. */}
          <div className="ml-auto flex min-w-0 items-center gap-2 md:gap-3">
            {/* From `sm`; on a phone it is in the menu drawer. */}
            {canSwitch && (
              <div className="hidden sm:block">
              <WorkspaceSwitcher
                // The workspace's own name, as the panel lists every workspace: an unbranded workspace's app
                // name is the product's default, the same for all of them, and a switcher can't tell them apart.
                // Initials come from that name too (blank lets the mark work them out).
                current={{ name: (await currentTenant()).name, initials: "", logoDataUrl: branding.logoDataUrl }}
                domain={PLATFORM_DOMAIN}
              />
              </div>
            )}
            {/* Resolved for whoever the request is acting as, like everything else in this header —
                an admin viewing as a salesperson should be offered the salesperson's options. */}
            <CreateMenu
              openModules={openModules}
              permissions={permissions}
              canBroadcastNotes={canBroadcast}
            />
            {/* On a phone only while viewing as somebody — that must always show; otherwise it is in the menu drawer. */}
            <div className={viewAs ? "" : "hidden sm:block"}>
              <ViewAsSwitcher
                targets={viewAsTargets}
                viewingAs={viewAs ? { userName: viewAs.user.name, actorName: viewAs.actor.name } : null}
              />
            </div>
            {/* The AI team, seen working (src/components/ai/teammate-live.tsx) — wherever Deskzo AI is this person's to use. */}
            {copilot && <TeamStrip />}
            {copilot && <CopilotButton availability={copilot} />}
            {/* In the menu drawer below `sm` — seven controls and the search don't fit a phone's header. */}
            <div className="hidden sm:block">
              <ThemeToggle defaultTheme={branding.defaultTheme} />
            </div>
            {/* On a phone Chat is a tab along the bottom (AppTabBar); here it would push Sign out off the screen. */}
            {chatShown && (
              <div className="hidden md:block">
                <ChatButton />
              </div>
            )}
            <NotificationBell />
            <Link
              href="/profile"
              className="group flex min-w-0 items-center gap-2 rounded-base px-1.5 py-1 transition-colors hover:bg-surface-sunken"
            >
              <Avatar
                user={shownUser ? { id: shownUser.id, name: shownUser.name, photoUpdatedAt: viewerPhotoUpdatedAt } : null}
                size="sm"
                tone={viewAs ? "warning" : "default"}
              />
              <span className="hidden min-w-0 text-left leading-tight lg:block">
                <span className="block truncate text-[13px] font-medium text-text">{shownUser?.name}</span>
                {/* The role's own name ("HR head"), read with the photo on this request — the same row Staff & roles
                    and the profile page show, so a role changed there is the one shown here on the next page. */}
                <span className="block truncate text-[11px] text-subtle">{viewer?.roleRef.name ?? shownUser?.role}</span>
              </span>
            </Link>
            {/* Its id is how BUSY's switch-user and lock keys sign out (src/components/shortcuts). */}
            {/* Hidden on a phone, where the menu drawer's Sign out submits it; still here for BUSY's keys. */}
            <form
              className="hidden sm:block"
              id="deskzo-sign-out"
              action={async () => {
                "use server";
                // Cleared first: the ticket is bound to this admin's id, so leaving it behind would
                // put the next sign-in straight back into somebody else's account.
                await clearViewAsCookie();
                await signOut({ redirectTo: "/login" });
              }}
            >
              {/* An icon on a tablet, its words from `lg`; named either way. */}
              <Button type="submit" variant="ghost" size="sm" aria-label="Sign out" title="Sign out" className="px-2 lg:px-3">
                <LogOut aria-hidden="true" className="h-4 w-4 lg:hidden" />
                <span className="hidden lg:inline">Sign out</span>
              </Button>
            </form>
          </div>
        </header>
        <MaintenanceBanner />
        {/*
          The platform's banners sit above <main>, not inside it: a page may bleed its header into
          main's top padding with negative margins (the dashboard's welcome header does), which would
          pull it over anything placed first inside main. Their spacing is their own margins, so a
          banner dismissed or absent leaves no gap.
        */}
        <div className="mx-auto w-full max-w-[1600px] px-4 md:px-6">
          <PlatformAnnouncements items={announcements} />
          {/* Its service worker, and on an iPhone in Safari how to add it to the home screen — not to an admin viewing as somebody. */}
          <InstallApp appName={homeScreenName(branding)} hint={!!session?.user && !viewAs} />
          {/* What may be kept for offline, and the note when offline (public/sw.js): never while viewing as somebody. */}
          <OfflineKeeper userKey={session?.user && !viewAs && !forcedSetup ? offlineUserKey((await currentTenant()).id, session.user.id) : null} />
          {billing && (
            <Link
              href="/settings/billing"
              className={`my-4 block rounded-base border px-3 py-2 text-sm md:my-6 ${billing.tone === "warning" ? "border-warning/40 bg-warning-bg text-warning" : "border-info/30 bg-info-bg text-info"}`}
            >
              {billing.text} <span className="font-medium underline">Plan &amp; billing</span>
            </Link>
          )}
          {storageNotice && (
            <Link
              href="/settings/billing#storage"
              className={`my-4 block rounded-base border px-3 py-2 text-sm md:my-6 ${storageNotice.tone === "danger" ? "border-danger/30 bg-danger-bg text-danger" : "border-warning/40 bg-warning-bg text-warning"}`}
            >
              {storageNotice.text} <span className="font-medium underline">Settings › Billing</span>
            </Link>
          )}
        </div>
        {/* On a phone the page ends above the bottom tab bar and the home bar under it. */}
        <main className="mx-auto w-full max-w-[1600px] flex-1 animate-fade-rise px-4 pb-[calc(5rem+env(safe-area-inset-bottom))] pt-6 md:px-6 md:py-8">
          <NavBreadcrumb navigation={navigation} />
          {/* The same rule on every click, not only a full page load (src/lib/forced-setup.ts). */}
          {forcedSetup && <ForcedSetupGuard />}
          {children}
        </main>
        {/* The phone's tabs along the bottom, as the Android app has them (owner, 31 Oct 2026). */}
        {shownUser && <AppTabBar sales={openModules.includes("leads")} chat={chatShown} calls={openModules.includes("calls")} chatUnread={chatUnread} />}
        {/* BUSY's shortcut keys, over whatever page this is (src/lib/shortcuts/busy.ts). */}
        <ShortcutsProvider navigation={navigation} />
        {today && <CelebrationSplash moments={today.moments} />}
        {wishes.length > 0 && (
          <Suspense fallback={null}>
            <WishesCorner initial={wishes} readOnly={!!viewAs} />
          </Suspense>
        )}
      </div>

      {/*
        Hidden below `xl`. On a laptop the content column is already the narrow part, and taking
        another twenty rem out of it to hold a calculator would make every table worse in exchange
        for a convenience. The tools it offers all have pages of their own.
      */}
      <div className="hidden xl:block">
        <SideRail
          copilot={!!copilot}
          unreadUpdates={unreadUpdates.company}
          unreadDeskzoUpdates={unreadUpdates.deskzo}
          canManageHelp={canManageHelp}
          // The name it was registered under heads the company's own guides. A workspace read from the
          // environment may be named only by its slug, so it keeps "From your company".
          companyName={(await currentTenant()).source === "control" ? (await currentTenant()).name : null}
          // It lists a customer's subscriptions and what each was sold at, so it needs "View orders";
          // its Create proposal button needs "Create proposals" (owner, 8 Oct 2026).
          proRata={(await isModuleEntitled("renewals")) && permissions.includes("renewals.view")}
          proRataProposals={(await isModuleEntitled("sales_documents")) && permissions.includes("docs.createProposal")}
          // The rail's tasks, calendar and notes are those modules' — not offered where their pages aren't.
          tasks={openModules.includes("tasks")}
          calendar={openModules.includes("calendar")}
          notes={openModules.includes("notes")}
          country={(await currentTenant()).country}
          support={!!supportLauncher}
          supportAccess={supportAccess ? { inside: !!supportAccess.grant } : null}
          chat={chatShown}
        />
      </div>

      {/* The Contact Support dialog; its button is on the tool rail from xl, and at the foot of the sidebar below it. */}
      {supportLauncher && <SupportLauncher state={supportLauncher} />}

      {/* A chat that @mentions this person opens in the corner, on any page (src/components/chat/chat-mention-windows.tsx). */}
      {chatOn && <ChatMentionWindows />}
    </div>
    </ChatGate>
    </CompanyLinksProvider>
    </TeammatesProvider>
    </ClockProvider>
    </WordingProvider>
    </TableColumnsProvider>
  );
}
