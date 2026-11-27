import { useEffect, useState } from "react";
import { ActivityIndicator, ScrollView, Text, TextInput, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Button, Card, Chip, Heading, Notice, colors, styles } from "@/components/ui";
import { ApiError, api } from "@/lib/api";
import { fileSize, fill, valuesFor, type FollowUp, type FollowUpSent, type FollowUpTemplate } from "@/lib/follow-up";

/**
 * The follow-up after a call (owner, 11 Nov 2026): a ready-written email or WhatsApp to the person just spoken to —
 * pick the template, read it as they will, change it, send. Opened from the after-call card once it is saved; nothing
 * goes until Send is pressed, and "Not now" sends nothing. GET and POST /api/app/calls/:id/follow-up.
 */

type Channel = "email" | "whatsapp";

export default function FollowUpScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const [data, setData] = useState<FollowUp | null | undefined>(undefined);
  const [channel, setChannel] = useState<Channel>("email");
  const [templateId, setTemplateId] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [toEmail, setToEmail] = useState<string[]>([]);
  // WhatsApp goes to one person: a contact's id, or "loose" for the number dialled with nobody behind it.
  const [toWhatsApp, setToWhatsApp] = useState("");
  const [attach, setAttach] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const listFor = (from: FollowUp, to: Channel) => from.templates.filter((t) => (to === "email" ? t.email_body : t.whatsapp_body));

  /** A channel and a template chosen: its words go in the boxes — the channel's first template when none is named. */
  const choose = (from: FollowUp, to: Channel, pickId?: string) => {
    const list = listFor(from, to);
    const pick: FollowUpTemplate | null = list.find((t) => t.id === pickId) ?? list[0] ?? null;
    setChannel(to);
    setTemplateId(pick?.id ?? "");
    setSubject(to === "email" ? (pick?.email_subject ?? "") : "");
    setBody(to === "email" ? (pick?.email_body ?? "") : (pick?.whatsapp_body ?? ""));
    setAttach(true);
    setError(null);
  };

  useEffect(() => {
    api<FollowUp>("GET", `/api/app/calls/${id}/follow-up`).then(
      (found) => {
        setData(found);
        const firstMail = found.contacts.find((c) => c.email && !c.email_stopped);
        setToEmail(firstMail ? [firstMail.id] : []);
        setToWhatsApp(found.loose ? "loose" : (found.contacts.find((c) => c.phone)?.id ?? ""));
        // Email when somebody can be emailed, else WhatsApp.
        choose(found, firstMail && found.email.ready ? "email" : "whatsapp");
      },
      () => setData(null),
    );
    // Asked once, for the call the screen was opened on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  if (data === undefined) return <ActivityIndicator style={{ marginTop: 40 }} color={colors.brand} />;
  if (data === null) {
    return (
      <View style={[styles.screen, styles.content]}>
        <Notice>There's no follow-up to send for this call from here.</Notice>
        <Button title="Back" kind="secondary" onPress={() => router.back()} />
      </View>
    );
  }

  const templates = listFor(data, channel);
  const template = templates.find((t) => t.id === templateId) ?? null;
  const person = channel === "email" ? (data.contacts.find((c) => c.id === toEmail[0]) ?? null) : toWhatsApp === "loose" ? null : (data.contacts.find((c) => c.id === toWhatsApp) ?? null);
  const values = valuesFor(data.values, person?.name ?? null);
  const windowOpen = channel === "whatsapp" && (toWhatsApp === "loose" ? !!data.loose?.whatsapp_open : !!person?.whatsapp_open);
  // Outside WhatsApp's 24 hours the approved words are what goes: shown, not edited.
  const fixedWords = channel === "whatsapp" && !windowOpen;
  const shownBody = fixedWords ? (template?.whatsapp_body ?? "") : body;
  const preview = { subject: fill(subject, values), body: fill(shownBody, values) };
  const missing = [...new Set([...(channel === "email" ? preview.subject.missing : []), ...preview.body.missing])];
  const mailable = data.contacts.filter((c) => c.email);
  const callable = data.contacts.filter((c) => c.phone);

  const blocked =
    channel === "email"
      ? !data.email.ready
        ? data.email.note
        : toEmail.length === 0
          ? "Pick who to send it to."
          : null
      : !data.whatsapp.ready
        ? data.whatsapp.note
        : !toWhatsApp
          ? "Nobody here has a phone number."
          : fixedWords && template && !template.whatsapp_approved
            ? "WhatsApp only lets a company write first with a message it has approved, and this one isn't yet. Ask your admin, or send an email."
            : null;

  async function send() {
    if (!template) return;
    setError(null);
    setBusy(true);
    try {
      const sent = await api<FollowUpSent>(
        "POST",
        `/api/app/calls/${id}/follow-up`,
        channel === "email"
          ? { channel, template_id: template.id, contact_ids: toEmail, subject, body, attach }
          : { channel, template_id: template.id, contact_id: toWhatsApp === "loose" ? null : toWhatsApp, body: windowOpen ? body : null, attach },
      );
      const skipped = sent.skipped.map((s) => `${s.name}: ${s.why}`).join(" ");
      setDone(`${channel === "email" ? `Sent to ${sent.sent} ${sent.sent === 1 ? "person" : "people"}.` : "Sent on WhatsApp."}${skipped ? ` Not sent — ${skipped}` : ""}${sent.note ? ` ${sent.note}` : ""}`);
    } catch (e) {
      setError(e instanceof ApiError ? (e.status === 0 ? "No connection — a follow-up needs one. Try again when you're back online." : e.message) : "Couldn't send. Try again.");
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <View style={[styles.screen, styles.content]}>
        <Notice tone="success">{done}</Notice>
        <Button title="Done" onPress={() => router.back()} />
      </View>
    );
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Text style={styles.title}>{data.company}</Text>
      <Text style={styles.small}>The call is saved. Send a follow-up if you like — nothing goes until you press Send.</Text>

      <View style={{ flexDirection: "row", gap: 8 }} accessibilityRole="radiogroup">
        <Chip label="Email" selected={channel === "email"} onPress={() => choose(data, "email")} />
        <Chip label="WhatsApp" selected={channel === "whatsapp"} onPress={() => choose(data, "whatsapp")} />
      </View>

      {templates.length === 0 ? (
        <Notice>No template has {channel === "email" ? "an email" : "a WhatsApp message"} for this call. Your admin can add one in Deskzo, under Settings › Message templates.</Notice>
      ) : (
        <>
          <Heading>Template</Heading>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }} accessibilityRole="radiogroup">
            {templates.map((t) => (
              <Chip key={t.id} label={t.name} selected={t.id === templateId} onPress={() => choose(data, channel, t.id)} />
            ))}
          </View>

          <Heading>To</Heading>
          {channel === "email" ? (
            mailable.length === 0 ? (
              <Notice>Nobody at {data.company} has an email address.</Notice>
            ) : (
              <View style={{ gap: 8 }}>
                {mailable.map((c) => (
                  <View key={c.id} style={{ gap: 2 }}>
                    <View style={{ flexDirection: "row" }}>
                      <Chip
                        label={`${c.name} · ${c.email}`}
                        selected={toEmail.includes(c.id)}
                        onPress={() => (c.email_stopped ? undefined : setToEmail((list) => (list.includes(c.id) ? list.filter((x) => x !== c.id) : [...list, c.id])))}
                      />
                    </View>
                    {c.email_stopped && <Text style={styles.small}>{c.email_stopped}</Text>}
                  </View>
                ))}
              </View>
            )
          ) : (
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }} accessibilityRole="radiogroup">
              {data.loose && <Chip label={data.loose.phone} selected={toWhatsApp === "loose"} onPress={() => setToWhatsApp("loose")} />}
              {callable.map((c) => (
                <Chip key={c.id} label={`${c.name} · ${c.phone}`} selected={toWhatsApp === c.id} onPress={() => setToWhatsApp(c.id)} />
              ))}
            </View>
          )}
          <Text style={styles.small}>{channel === "email" ? data.email.note : data.whatsapp.note}</Text>

          {channel === "email" && (
            <>
              <Heading>Subject</Heading>
              <TextInput style={styles.input} value={subject} onChangeText={setSubject} accessibilityLabel="Subject" />
            </>
          )}

          <Heading>Message</Heading>
          {fixedWords ? (
            <Notice>
              {template?.whatsapp_approved
                ? "WhatsApp sends the approved wording with the names filled in — it can't be changed here. Once they reply, you can write freely for 24 hours."
                : "This customer hasn't written to you on WhatsApp in the last 24 hours."}
            </Notice>
          ) : (
            <TextInput
              style={[styles.input, { minHeight: channel === "email" ? 180 : 100, textAlignVertical: "top" }]}
              value={body}
              onChangeText={setBody}
              multiline
              accessibilityLabel="Message"
            />
          )}

          <Card>
            <Text style={styles.small}>As {person?.name ?? data.loose?.phone ?? "they"} will see it</Text>
            {channel === "email" && <Text style={[styles.body, { fontWeight: "600" }]}>{preview.subject.text}</Text>}
            <Text style={styles.body}>{preview.body.text}</Text>
          </Card>

          {template?.attachment && (
            <View style={{ flexDirection: "row" }}>
              <Chip label={`${attach ? "Attached" : "Not attached"}: ${template.attachment.name} (${fileSize(template.attachment.size)})`} selected={attach} onPress={() => setAttach((on) => !on)} />
            </View>
          )}

          {missing.length > 0 && <Notice tone="danger">Nothing to fill in for {missing.map((m) => `{{${m}}}`).join(", ")}{fixedWords ? "." : " — type the words in instead."}</Notice>}
          {blocked && <Notice tone="warning">{blocked}</Notice>}
        </>
      )}

      {error && <Notice tone="danger">{error}</Notice>}
      {templates.length > 0 && <Button title={channel === "email" ? "Send email" : "Send on WhatsApp"} busy={busy} disabled={!!blocked || missing.length > 0 || !template} onPress={() => void send()} />}
      <Button title="Not now" kind="secondary" onPress={() => router.back()} />
    </ScrollView>
  );
}
