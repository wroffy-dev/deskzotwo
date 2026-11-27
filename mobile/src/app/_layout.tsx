import { useEffect, useRef } from "react";
import { Stack, useRouter, useSegments } from "expo-router";
import * as Notifications from "expo-notifications";
import { StatusBar } from "expo-status-bar";
import { Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useOfflineCopy } from "@/lib/offline";
import { dismissFailed, useOutbox, useOutboxSender } from "@/lib/outbox";
import { colors } from "@/components/ui";
import { ChatBanner } from "@/components/chat/banner";
import { ChatProvider } from "@/lib/chat";
import { ScreenRules } from "@/lib/screen-rules";
import { SessionProvider, useSession } from "@/lib/session";
import { dataOf, onPushAddressChange, registerForPush, routeFor } from "@/lib/push";

/**
 * Notifications (src/lib/push.ts): once signed in, the phone's push address handed to Deskzo — asking the person
 * first — and kept current; a tap on one, while the app was open or the tap that opened it, leads where it says.
 */
function PushSetup() {
  const { paired, me } = useSession();
  const router = useRouter();
  const registered = useRef(false);

  useEffect(() => {
    if (!paired) {
      registered.current = false;
      return;
    }
    if (!me || registered.current) return;
    registered.current = true;
    void registerForPush();
  }, [paired, me]);

  useEffect(() => (paired ? onPushAddressChange() : undefined), [paired]);

  useEffect(() => {
    if (!paired) return;
    const open = (response: Notifications.NotificationResponse) => {
      if (response.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return;
      const to = routeFor(dataOf(response));
      if (to) router.push(to);
    };
    void Notifications.getLastNotificationResponseAsync().then((response) => {
      if (!response) return;
      open(response);
      void Notifications.clearLastNotificationResponseAsync();
    });
    const sub = Notifications.addNotificationResponseReceivedListener(open);
    return () => sub.remove();
  }, [paired, router]);

  return null;
}

/** Under everything while the last copy is on screen (src/lib/offline.ts): what it is, and that nothing done now will save. */
function OfflineNote() {
  const savedAt = useOfflineCopy();
  const insets = useSafeAreaInsets();
  const { pending, failed } = useOutbox();
  if (savedAt === null && pending.length === 0 && failed.length === 0) return null;
  const at = savedAt === null ? null : new Date(savedAt).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
  return (
    <View style={{ backgroundColor: "#fef3c7", paddingHorizontal: 12, paddingTop: 8, paddingBottom: Math.max(8, insets.bottom), gap: 4 }}>
      {at && <Text style={{ color: "#92400e", fontSize: 13 }}>You&apos;re offline — showing what you saw at {at}. Tasks and call notes will send when you&apos;re back; anything else needs a connection.</Text>}
      {pending.length > 0 && <Text style={{ color: "#92400e", fontSize: 13 }}>{pending.length} change{pending.length === 1 ? "" : "s"} waiting to send.</Text>}
      {failed.map((f) => (
        <Text key={f.id} style={{ color: "#b91c1c", fontSize: 13 }} onPress={() => dismissFailed(f.id)}>
          Couldn&apos;t save &ldquo;{f.label}&rdquo;: {f.why} (tap to dismiss)
        </Text>
      ))}
    </View>
  );
}

/**
 * The tabs — Today, Sales, Chat, Calls, More — and over them a conversation (full screen), approvals, leave,
 * Settings, signing in, call sync and the after-call card. Everything but pairing needs a paired phone; a paired phone has no business on the pairing
 * screen.
 */
function Screens() {
  const { ready, paired } = useSession();
  useOutboxSender(paired);
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    if (!ready) return;
    // Signing in: the screen itself, and the one the browser's sign-in comes back to.
    // "app-return": the same way back on an App Link (R2-12, src/app/app-return/signed-in.tsx).
    const onPair = segments[0] === "pair" || segments[0] === "signed-in" || segments[0] === "app-return";
    if (!paired && !onPair) router.replace("/pair");
    else if (paired && onPair) router.replace("/");
  }, [ready, paired, segments, router]);

  return (
    <>
      <Stack screenOptions={{ headerTintColor: colors.brand, headerTitleStyle: { fontWeight: "600", color: colors.text }, contentStyle: { backgroundColor: colors.sunken } }}>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="pair" options={{ title: "Sign in", headerBackVisible: false, gestureEnabled: false }} />
        <Stack.Screen name="signed-in" options={{ title: "Signing in", headerBackVisible: false }} />
        <Stack.Screen name="setup" options={{ title: "Call sync" }} />
        <Stack.Screen name="review/[id]" options={{ title: "How did it go?" }} />
        <Stack.Screen name="follow-up/[id]" options={{ title: "Follow up" }} />
        <Stack.Screen name="conversation/[id]" options={{ headerShown: false }} />
        <Stack.Screen name="new-chat" options={{ title: "New chat" }} />
        <Stack.Screen name="approvals" options={{ title: "Approvals" }} />
        <Stack.Screen name="waiting" options={{ title: "Waiting for you" }} />
        <Stack.Screen name="waiting-email/[kind]/[id]" options={{ title: "Check and send" }} />
        <Stack.Screen name="leave" options={{ title: "Leave" }} />
        {/* A page of its own, opened from Today and More, since Sales took its place on the bar. As a hidden tab it
            couldn't be opened at all: "All my tasks" only brought Today back. */}
        <Stack.Screen name="tasks" options={{ title: "Tasks" }} />
        <Stack.Screen name="settings" options={{ title: "Settings" }} />
        {/* The sales screens (22 Oct 2026), and the web's own pages for whatever has no screen of the app's yet. */}
        <Stack.Screen name="lead/[ref]" options={{ title: "Lead" }} />
        <Stack.Screen name="company/[ref]" options={{ title: "Company" }} />
        <Stack.Screen name="new-lead" options={{ title: "New lead" }} />
        <Stack.Screen name="new-company" options={{ title: "New company" }} />
        <Stack.Screen name="new-contact" options={{ title: "New contact" }} />
        <Stack.Screen name="search" options={{ title: "Search" }} />
        {/* Field work (22 Oct 2026): visits, claims and the calendar. */}
        <Stack.Screen name="visits" options={{ title: "Visits" }} />
        <Stack.Screen name="visit/[id]" options={{ title: "Visit" }} />
        <Stack.Screen name="new-visit" options={{ title: "Plan a visit" }} />
        <Stack.Screen name="expenses" options={{ title: "Expenses" }} />
        <Stack.Screen name="new-expense" options={{ title: "New claim" }} />
        <Stack.Screen name="meetings" options={{ title: "Calendar" }} />
        <Stack.Screen name="new-meeting" options={{ title: "Schedule a meeting" }} />
        <Stack.Screen name="web" options={{ title: "Deskzo" }} />
      </Stack>
      <OfflineNote />
      {/* The workspace's screenshot allowance and watermark, over every screen. */}
      <ScreenRules />
      {/* "New message" from a chat that isn't open — who, never what. */}
      <ChatBanner />
      <PushSetup />
    </>
  );
}

export default function Layout() {
  return (
    <SessionProvider>
      <ChatProvider>
        <StatusBar style="dark" />
        <Screens />
      </ChatProvider>
    </SessionProvider>
  );
}
