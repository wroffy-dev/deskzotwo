import { useCallback, useState } from "react";
import { Alert, ScrollView, Text, TextInput, View } from "react-native";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { Button, Card, Notice, colors, styles } from "@/components/ui";
import { api, type WaitingDone, type WaitingEmail } from "@/lib/api";

/**
 * One email an AI teammate drafted, checked and sent from the phone (owner, 22 Nov 2026): change anything, then approve
 * it for the working morning or send it now — or don't send it. The server sends it by the web's own action, from the
 * person's mailbox, with every check the web makes (src/lib/app/waiting.ts).
 */
export default function WaitingEmailScreen() {
  const router = useRouter();
  const { kind, id } = useLocalSearchParams<{ kind: string; id: string }>();
  const [email, setEmail] = useState<WaitingEmail | null>(null);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState<"hold" | "now" | "skip" | null>(null);

  const load = useCallback(async () => {
    setProblem(null);
    try {
      const next = await api<WaitingEmail>("GET", `/api/app/waiting/${kind}/${id}`);
      setEmail(next);
      setSubject(next.subject);
      setBody(next.body);
    } catch (e) {
      setProblem(e instanceof Error ? e.message : "Couldn't open it.");
    }
  }, [kind, id]);

  useFocusEffect(
    useCallback(() => {
      if (!email) void load();
    }, [email, load]),
  );

  async function decide(how: "hold" | "now" | "skip") {
    setBusy(how);
    setProblem(null);
    try {
      const done = await api<WaitingDone>("POST", `/api/app/waiting/${kind}/${id}`, { action: how === "skip" ? "skip" : "send", when: how === "hold" ? "working-hours" : "now", subject, body });
      const words = done.done === "skipped" ? "Set aside — it won't go." : done.done === "held" ? `Approved — it goes ${email?.hold_until ?? "on the next working morning"}.` : "Sent from your mailbox.";
      Alert.alert(done.done === "skipped" ? "Not sent" : "Done", words, [{ text: "OK", onPress: () => router.back() }]);
    } catch (e) {
      setProblem(e instanceof Error ? e.message : "That didn't work.");
      setBusy(null);
    }
  }

  if (!email) {
    return (
      <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
        {problem ? <Notice tone="danger">{problem}</Notice> : <Notice>Opening…</Notice>}
      </ScrollView>
    );
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <View>
        <Text style={[styles.small, { color: colors.brand, fontWeight: "600" }]}>Drafted by {email.teammate_name}</Text>
        <Text style={styles.title}>{email.company}</Text>
        <Text style={styles.small}>To {email.to}</Text>
        {email.lines.map((l) => (
          <Text key={l} style={styles.small}>
            {l}
          </Text>
        ))}
      </View>
      {email.from_problem && <Notice tone="warning">{email.from_problem}</Notice>}
      <Card>
        <Text style={styles.small}>Subject</Text>
        <TextInput style={styles.input} value={subject} onChangeText={setSubject} maxLength={300} accessibilityLabel="Subject" />
        <Text style={styles.small}>Email</Text>
        <TextInput style={[styles.input, { minHeight: 220, textAlignVertical: "top" }]} value={body} onChangeText={setBody} multiline maxLength={5000} accessibilityLabel="Email" />
        <Text style={styles.small}>{email.hint}</Text>
      </Card>
      {problem && <Notice tone="danger">{problem}</Notice>}
      {email.hold_until ? (
        <>
          <Button title={`Approve — goes ${email.hold_until}`} busy={busy === "hold"} disabled={!!busy} onPress={() => void decide("hold")} />
          <Button title="Send now" kind="secondary" busy={busy === "now"} disabled={!!busy} onPress={() => void decide("now")} />
        </>
      ) : (
        <Button title="Approve & send" busy={busy === "now"} disabled={!!busy || !!email.from_problem} onPress={() => void decide("now")} />
      )}
      <Button title="Don't send" kind="secondary" busy={busy === "skip"} disabled={!!busy} onPress={() => void decide("skip")} />
      <Button title="Open on the web" kind="secondary" disabled={!!busy} onPress={() => router.push({ pathname: "/web", params: { path: email.path } })} />
    </ScrollView>
  );
}
