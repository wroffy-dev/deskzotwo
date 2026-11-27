import { useCallback, useState } from "react";
import { Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { Card, Notice, colors, styles } from "@/components/ui";
import { api, type WaitingItem, type WaitingList } from "@/lib/api";
import { when } from "@/lib/format";

/**
 * Waiting for you (owner, 22 Nov 2026 — "go with phone approvals"): what the AI teammates left for the person. The
 * emails — Tara's follow-ups and check-ins, Arjun's chase emails — open to check, change and send right here; the rest
 * (a reply to act on, an HR question, a chat) open in Deskzo. Server: src/lib/app/waiting.ts.
 */
export default function WaitingScreen() {
  const router = useRouter();
  const [list, setList] = useState<WaitingList | null>(null);
  const [loading, setLoading] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setProblem(null);
    try {
      setList(await api<WaitingList>("GET", "/api/app/waiting"));
    } catch (e) {
      setProblem(e instanceof Error ? e.message : "Couldn't load what waits for you.");
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  function open(item: WaitingItem) {
    if (item.decide) router.push({ pathname: "/waiting-email/[kind]/[id]", params: { kind: item.decide.kind, id: item.decide.id } });
    else router.push({ pathname: "/web", params: { path: item.path } });
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content} refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void load()} />}>
      {problem && <Notice tone="danger">{problem}</Notice>}
      {list && list.items.length === 0 && <Notice>Your AI team has nothing waiting for you.</Notice>}
      {list && list.total > list.items.length && <Text style={styles.small}>The oldest {list.items.length} of {list.total}.</Text>}
      {list?.items.map((item, i) => (
        <Pressable key={`${item.decide?.id ?? item.path}:${i}`} accessibilityRole="button" accessibilityLabel={item.title} onPress={() => open(item)}>
          <Card style={styles.row}>
            <View style={{ width: 34, height: 34, borderRadius: 17, backgroundColor: colors.brandSoft, alignItems: "center", justifyContent: "center" }}>
              <Text style={{ color: colors.brand, fontWeight: "700" }}>{item.teammate_name.slice(0, 1).toUpperCase()}</Text>
            </View>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={[styles.small, { color: colors.brand, fontWeight: "600" }]}>
                {item.teammate_name} · {when(item.at)}
              </Text>
              <Text style={styles.body}>{item.title}</Text>
              {item.detail && (
                <Text style={styles.small} numberOfLines={2}>
                  {item.detail}
                </Text>
              )}
            </View>
            <Ionicons name={item.decide ? "create-outline" : "open-outline"} size={20} color={colors.muted} />
          </Card>
        </Pressable>
      ))}
    </ScrollView>
  );
}
