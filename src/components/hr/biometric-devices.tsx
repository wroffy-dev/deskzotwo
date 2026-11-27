"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Fingerprint, Link2, Pencil, Plus, RefreshCw, Trash2, Upload } from "lucide-react";
import type { listBiometricDevices, mappedEnrolments, recentPunches, unmappedEnrolments } from "@/actions/biometric";
import {
  clearEnrolment,
  importPunchFile,
  mapEnrolment,
  reprocessPunches,
  saveBiometricDevice,
  clearBiometricDeviceKey,
  issueBiometricDeviceKey,
  removeBiometricDevice,
  setBiometricDeviceActive,
} from "@/actions/biometric";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ActionNoticeRegion, type NoticeTone } from "@/components/ui/action-notice";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Select } from "@/components/ui/input";
import { SearchSelect } from "@/components/ui/search-select";
import { Switch } from "@/components/ui/switch";
import { confirmAction } from "@/components/ui/confirm";
import { useClock } from "@/components/time/clock-provider";
import { clockFor } from "@/lib/time/zone";
import { VERIFY_MODE_LABELS } from "@/lib/hr/iclock";
import { personPath } from "@/lib/record-links";

type Device = Awaited<ReturnType<typeof listBiometricDevices>>[number];
type Unmapped = Awaited<ReturnType<typeof unmappedEnrolments>>[number];
type Mapped = Awaited<ReturnType<typeof mappedEnrolments>>[number];
type Punch = Awaited<ReturnType<typeof recentPunches>>[number];

export function BiometricDevices({
  devices,
  unmapped,
  mapped,
  punches,
  people,
  serverUrl,
  serverIp,
}: {
  devices: Device[];
  unmapped: Unmapped[];
  mapped: Mapped[];
  punches: Punch[];
  people: { id: string; name: string }[];
  serverUrl: string;
  /** This server's public IP number, when the deployment names it (DEVICE_SERVER_IP). */
  serverIp?: string | null;
}) {
  const router = useRouter();
  const clock = useClock();
  const [pending, startTransition] = useTransition();
  const [notice, setNotice] = useState<{ tone: NoticeTone; message: string } | null>(null);

  function reprocess() {
    setNotice(null);
    startTransition(async () => {
      const result = await reprocessPunches();
      // Told apart. Both outcomes used to land in the same muted line, so "you can't do that" and
      // "1,400 punches processed" were the same sentence in the same grey.
      setNotice(
        result.ok
          ? {
              tone: "success",
              message: `${result.data.punches} punch(es) processed into ${result.data.days} day(s)${result.data.skipped > 0 ? `, ${result.data.skipped} day(s) left alone (leave or a manual correction)` : ""}.`,
            }
          : { tone: "error", message: result.error },
      );
      router.refresh();
    });
  }

  return (
    <div className="space-y-5">
      <SetupCard serverUrl={serverUrl} serverIp={serverIp ?? null} />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-2">
          <DeviceDialog />
          {devices.length > 0 && <ImportDialog devices={devices} />}
        </div>
        <div className="flex items-center gap-2">
          <ActionNoticeRegion notice={notice} />
          <Button size="sm" variant="ghost" disabled={pending} onClick={reprocess}>
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
            Reprocess
          </Button>
        </div>
      </div>

      <Card className="overflow-hidden p-0">
        <CardHeader className="text-sm font-medium text-text">Terminals</CardHeader>
        <table className="w-full text-sm">
          <thead className="border-y border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-4 py-2.5">Name</th>
              <th className="px-4 py-2.5">Serial</th>
              <th className="px-4 py-2.5">Last seen</th>
              <th className="px-4 py-2.5">Last punch</th>
              <th className="px-4 py-2.5 text-right">Punches</th>
              <th className="px-4 py-2.5">On / off</th>
              <th className="px-4 py-2.5" aria-label="Edit or remove" />
            </tr>
          </thead>
          <tbody>
            {devices.map((d) => (
              <tr key={d.id} className="border-b border-line last:border-0">
                <td className="px-4 py-2.5">
                  <span className="font-medium text-text">{d.name}</span>
                  {d.location && <div className="text-xs text-subtle">{d.location}</div>}
                </td>
                <td className="px-4 py-2.5 font-mono text-xs text-muted">
                  {d.serialNumber}
                  {/* Its address list (audit M-8): a call from anywhere else is refused. */}
                  {d.allowedIps.length > 0 && <div className="font-sans text-xs text-subtle">only from {d.allowedIps.join(", ")}</div>}
                  {/* Security audit, Nov 2026: its own secret address, or an address list, or HR's word to accept it from anywhere —
                      the serial printed on the box is never proof enough on its own. */}
                  {d.hasKey ? (
                    <div className="font-sans text-xs text-success">secret address on</div>
                  ) : (
                    d.allowedIps.length === 0 &&
                    (d.acceptAnyAddress ? (
                      <div className="font-sans text-xs text-warning">accepted from any address — anyone who knows the serial can send punches; give it a secret address or an address list</div>
                    ) : (
                      <div className="font-sans text-xs text-danger">punches refused — give it a secret address or an address list, or accept it from any address</div>
                    ))
                  )}
                </td>
                <td className="px-4 py-2.5 text-xs text-muted">
                  {d.lastSeenAt ? clock.dateTimeShort(d.lastSeenAt) : <span className="text-warning">never</span>}
                </td>
                {/*
                  A punch is stored as the terminal's own wall-clock reading labelled UTC (src/lib/hr/iclock.ts),
                  so its UTC reading is the time the terminal showed — as under Recent punches. The workspace's
                  clock would move it by the offset a second time.
                */}
                <td className="px-4 py-2.5 text-xs text-muted">
                  {d.lastPunchAt ? clockFor("UTC").dateTimeShort(d.lastPunchAt) : "—"}
                </td>
                <td className="px-4 py-2.5 text-right tabular-nums text-muted">{d._count.punches}</td>
                <td className="px-4 py-2.5">
                  {/* On or off (owner, 2 Nov 2026): off, the terminal's uploads are refused until it is switched back on. */}
                  <div className="flex items-center gap-2">
                    <Switch
                      size="sm"
                      checked={d.active}
                      disabled={pending}
                      aria-label={`${d.name}: ${d.active ? "on — switch off to refuse its uploads" : "off — switch on to accept its uploads"}`}
                      title={d.active ? "On — switch off to refuse its uploads" : "Off — its uploads are refused"}
                      onChange={(next) =>
                        startTransition(async () => {
                          const result = await setBiometricDeviceActive(d.id, next);
                          if (!result.ok) setNotice({ tone: "error", message: result.error });
                          router.refresh();
                        })
                      }
                    />
                    <span className={d.active ? "text-xs font-medium text-success" : "text-xs text-subtle"}>{d.active ? "On" : "Off"}</span>
                  </div>
                </td>
                <td className="px-4 py-2.5">
                  <div className="flex items-center justify-end gap-1">
                    <DeviceDialog device={d} />
                    <SecretAddressDialog device={d} serverUrl={serverUrl} />
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={pending}
                      aria-label={`Remove ${d.name}`}
                      title="Remove this terminal"
                      className="text-muted hover:text-danger"
                      onClick={async () => {
                        const sure = await confirmAction({
                          title: `Remove ${d.name}?`,
                          message: `It is refused from now on and leaves this list. ${
                            d._count.punches === 0
                              ? "It hasn't sent any punches."
                              : `The ${d._count.punches.toLocaleString("en-IN")} ${d._count.punches === 1 ? "punch" : "punches"} it sent stay, with the attendance worked out from them.`
                          } Registering serial ${d.serialNumber} again brings it back.`,
                          confirmLabel: "Remove",
                          danger: true,
                        });
                        if (!sure) return;
                        startTransition(async () => {
                          const result = await removeBiometricDevice(d.id);
                          setNotice(result.ok ? { tone: "success", message: `${d.name} removed.` } : { tone: "error", message: result.error });
                          router.refresh();
                        });
                      }}
                    >
                      <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
            {devices.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-subtle">
                  No terminals registered. Until a serial is registered here, anything it sends is refused.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader className="text-sm font-medium text-text">
            Unmapped enrolment numbers
            {unmapped.length > 0 && <span className="ml-1.5 text-xs font-normal text-warning">{unmapped.length}</span>}
          </CardHeader>
          <CardContent className="space-y-2">
            <p className="text-xs text-subtle">
              Numbers the terminals have sent that belong to nobody yet. Their punches are kept — mapping one
              recovers everything already collected against it.
            </p>
            {unmapped.length === 0 && <p className="text-sm text-subtle">Every number seen so far is mapped.</p>}
            {unmapped.map((u) => (
              <MapRow key={u.deviceUserId} row={u} people={people} />
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="text-sm font-medium text-text">Mapped</CardHeader>
          <CardContent className="space-y-1.5">
            {mapped.length === 0 && <p className="text-sm text-subtle">Nobody has a biometric number yet.</p>}
            {mapped.map((m) => (
              <div key={m.userId} className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
                <Link href={personPath(m.user.userSeq)} className="text-text hover:underline">
                  {m.user.name}
                  {!m.user.active && <span className="ml-1 text-xs text-subtle">(inactive)</span>}
                </Link>
                <span className="flex items-center gap-2">
                  <span className="font-mono text-xs text-muted">#{m.biometricId}</span>
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() =>
                      startTransition(async () => {
                        await clearEnrolment(m.userId);
                        router.refresh();
                      })
                    }
                    className="text-xs text-subtle hover:text-danger"
                  >
                    unmap
                  </button>
                </span>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      <Card className="overflow-hidden p-0">
        <CardHeader className="text-sm font-medium text-text">
          Recent punches
          <span className="ml-1.5 text-xs font-normal text-subtle">first and last of each day</span>
        </CardHeader>
        <table className="w-full text-sm">
          <thead className="border-y border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-4 py-2.5">When</th>
              <th className="px-4 py-2.5">Who</th>
              <th className="px-4 py-2.5">Terminal</th>
              <th className="px-4 py-2.5">Type</th>
              <th className="px-4 py-2.5">Verified by</th>
            </tr>
          </thead>
          <tbody>
            {punches.map((p) => (
              <tr key={p.id} className="border-b border-line last:border-0">
                <td className="px-4 py-2.5 font-mono text-xs text-text">
                  {String(p.punchedAt).slice(0, 19).replace("T", " ")}
                </td>
                <td className="px-4 py-2.5">
                  {p.user ? (
                    <Link href={personPath(p.user.userSeq)} className="text-text hover:underline">
                      {p.user.name}
                    </Link>
                  ) : (
                    <span className="text-warning">#{p.deviceUserId} — unmapped</span>
                  )}
                </td>
                <td className="px-4 py-2.5 text-muted">{p.device.name}</td>
                {/* First and last of the day, not the terminal's own in/out: it opens the gate too (src/actions/biometric.ts). */}
                <td className="px-4 py-2.5 text-muted">{p.role === "first" ? "First punch (in)" : "Last punch (out)"}</td>
                <td className="px-4 py-2.5 text-muted">
                  {p.verifyMode !== null ? (VERIFY_MODE_LABELS[p.verifyMode] ?? p.verifyMode) : "—"}
                </td>
              </tr>
            ))}
            {punches.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-subtle">
                  Nothing received yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

/**
 * What to type into the terminal's keypad, and the warning that goes with it.
 *
 * Most eSSL / ZKTeco firmware speaks plain HTTP only and cannot follow a redirect, so the terminal is pointed at
 * port 80 — the server answers /iclock there as it is (deploy/azure/Caddyfile). With the server's IP number,
 * "Enable domain name" is off; with the workspace's address it must be on, or the terminal reads the name as a
 * malformed IP and never connects.
 */
function SetupCard({ serverUrl, serverIp }: { serverUrl: string; serverIp: string | null }) {
  let host = serverUrl;
  try {
    host = new URL(serverUrl).hostname;
  } catch {
    // Leave the raw value — better to show something than nothing.
  }
  const isIp = /^(\d{1,3}\.){3}\d{1,3}$/.test(host);
  const rows = [
    ...(serverIp && !isIp
      ? [{ label: "With the server's IP", address: serverIp, port: "80", domain: "OFF", recommended: true }]
      : []),
    { label: isIp ? "Server" : "With the workspace's address", address: host, port: "80", domain: isIp ? "OFF" : "ON", recommended: !serverIp || isIp },
  ];

  return (
    <Card>
      <CardHeader className="flex items-center gap-2 text-sm font-medium text-text">
        <Fingerprint className="h-4 w-4" />
        Pointing a terminal at this server
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-muted">
          On the terminal: <span className="text-text">Menu → Comm → Cloud Server / ADMS</span>, then set either of these:
        </p>
        {rows.map((r) => (
          <div key={r.label} className="rounded-base border border-line bg-surface-sunken px-3 py-2">
            <div className="mb-1.5 text-xs font-medium text-muted">
              {r.label}
              {rows.length > 1 && r.recommended && <span className="ml-1.5 text-brand">· recommended</span>}
            </div>
            <div className="grid grid-cols-1 gap-2 font-mono text-xs sm:grid-cols-3">
              <div>
                <div className="text-subtle">Server address</div>
                <div className="text-text">{r.address}</div>
              </div>
              <div>
                <div className="text-subtle">Server port</div>
                <div className="text-text">{r.port}</div>
              </div>
              <div>
                <div className="text-subtle">Enable domain name</div>
                <div className="text-text">{r.domain}</div>
              </div>
            </div>
          </div>
        ))}
        <p className="text-xs text-muted">
          Leave HTTPS off on the terminal — most can&apos;t speak it. If yours has an HTTPS switch and you use the
          workspace&apos;s address, port 443 with HTTPS on works too. A minute after saving, the terminal&apos;s{" "}
          <span className="text-text">Last seen</span> below should change from &ldquo;never&rdquo;.
        </p>
        <p className="text-xs text-muted">
          Register the terminal&apos;s serial below first — until then its uploads are refused. The serial is on the
          sticker underneath, and on the device under <span className="text-text">Menu → System → Device Info</span>.
        </p>
        <p className="rounded-base border border-warning/40 bg-warning-bg px-3 py-2 text-xs text-warning">
          The protocol these terminals speak carries no authentication — the firmware offers no way to add one. Keep
          this server reachable only from the office network or over a VPN, never open to the internet. Where a
          terminal has to reach it over the internet, give it the addresses it calls from under{" "}
          <span className="font-medium">Edit</span>, so a call from anywhere else is refused — or, where the terminal&apos;s
          server address takes a web address with a slash in it, a <span className="font-medium">secret address</span> of
          its own, so its serial alone is no longer believed.
        </p>
      </CardContent>
    </Card>
  );
}

function MapRow({ row, people }: { row: Unmapped; people: { id: string; name: string }[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [userId, setUserId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  function map() {
    if (!userId) return;
    setError(null);
    startTransition(async () => {
      const result = await mapEnrolment(userId, row.deviceUserId);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setDone(`${result.data.linked} punch(es) recovered into ${result.data.days} day(s).`);
      router.refresh();
    });
  }

  if (done) return <p className="text-xs text-success">#{row.deviceUserId} mapped — {done}</p>;

  return (
    <div className="rounded-base border border-line p-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-sm text-text">#{row.deviceUserId}</span>
        <span className="text-xs text-subtle">
          {row.punches} punch(es)
          {row.lastSeen && ` · last ${String(row.lastSeen).slice(0, 10)}`}
        </span>
        {/*
          One of these per unmapped enrolment, so the device number goes in the name — a column of
          selects all called "Who is this?" tells a reader nothing about which one they are on.
        */}
        <SearchSelect
          aria-label={`Person for enrolment #${row.deviceUserId}`}
          searchPlaceholder="Search people…"
          value={userId}
          onChange={(e) => setUserId(e.target.value)}
          className="h-8 flex-1 text-xs"
        >
          <option value="">Who is this?</option>
          {people.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </SearchSelect>
        <Button size="sm" disabled={pending || !userId} onClick={map}>
          <Link2 className="mr-1 h-3 w-3" />
          Map
        </Button>
      </div>
      {error && <p className="mt-1 text-xs text-danger">{error}</p>}
    </div>
  );
}

/**
 * Registers a terminal, or with `device` edits that one — its name, place, a serial typed wrong, or the addresses it
 * may call from (audit M-8: checked again, entry by entry, by saveBiometricDevice — this only splits what is typed).
 */
/**
 * A terminal's own secret address (owner, 12 Nov 2026 — security audit SEC-06). The key is made here and shown once:
 * what to type into the terminal, and the warning that it stops sending until that is done.
 */
function SecretAddressDialog({ device, serverUrl }: { device: Device; serverUrl: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [address, setAddress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  let host = serverUrl;
  try {
    host = new URL(serverUrl).hostname;
  } catch {
    // Leave the raw value.
  }

  function make() {
    setError(null);
    startTransition(async () => {
      const done = await issueBiometricDeviceKey(device.id);
      if (!done.ok) return void setError(done.error);
      setAddress(`${host}${done.data.path}`);
      router.refresh();
    });
  }

  function remove() {
    setError(null);
    startTransition(async () => {
      const done = await clearBiometricDeviceKey(device.id);
      if (!done.ok) return void setError(done.error);
      setAddress(null);
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <>
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)} title="Secret address">
        {device.hasKey ? "Secret address" : "Add secret address"}
      </Button>
      <Dialog
        open={open}
        onClose={() => {
          setOpen(false);
          setAddress(null);
        }}
        title={`${device.name}: secret address`}
      >
        <div className="space-y-3 text-sm">
          {address ? (
            <>
              <p className="text-muted">Type this into the terminal as its server address, with “Enable domain name” on and port 80. It is shown only this once.</p>
              <div className="break-all rounded-base border border-line bg-surface-sunken px-3 py-2 font-mono text-sm text-text">{address}</div>
              <p className="text-warning">Until the terminal has this address it sends nothing here. Its punches stay on the terminal and arrive once it does.</p>
            </>
          ) : (
            <>
              <p className="text-muted">
                A terminal is believed by its serial number, which is printed on the box. A secret address adds a key only this terminal knows: anything naming its serial without the key is refused.
              </p>
              <p className="text-muted">
                It needs a terminal whose server address takes a web address with a slash in it (“Enable domain name” on). If yours doesn’t, leave this off and give the terminal its address list instead (Edit).
              </p>
              {device.hasKey && <p className="text-text">This terminal has a secret address. Making a new one stops the old one working.</p>}
            </>
          )}
          {error && <p className="text-danger">{error}</p>}
          <div className="flex flex-wrap justify-end gap-2">
            {!address && device.hasKey && (
              <Button variant="ghost" disabled={pending} onClick={remove}>
                Remove it
              </Button>
            )}
            {!address && (
              <Button disabled={pending} onClick={make}>
                {pending ? "Making…" : device.hasKey ? "Make a new one" : "Make a secret address"}
              </Button>
            )}
            <Button
              variant="secondary"
              onClick={() => {
                setOpen(false);
                setAddress(null);
              }}
            >
              {address ? "Done" : "Close"}
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}

function DeviceDialog({ device }: { device?: Device }) {
  const router = useRouter();
  // A terminal keeps the time of the office it is bolted to — the workspace's zone unless told otherwise.
  const clock = useClock();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const blank = () =>
    device
      ? { serialNumber: device.serialNumber, name: device.name, location: device.location ?? "", timezone: device.timezone, allowedIps: device.allowedIps.join(", "), acceptAnyAddress: device.acceptAnyAddress }
      : { serialNumber: "", name: "", location: "", timezone: clock.zone, allowedIps: "", acceptAnyAddress: false };
  const [form, setForm] = useState(blank);

  function openDialog() {
    setForm(blank());
    setError(null);
    setOpen(true);
  }

  function save() {
    setError(null);
    startTransition(async () => {
      // Commas, spaces or one to a line; an empty box is any address.
      const input = { ...form, allowedIps: form.allowedIps.split(/[\s,;]+/).filter(Boolean) };
      // An edit keeps the terminal enabled or disabled as it was — the badge in its row is what changes that.
      const result = await saveBiometricDevice(device ? { ...input, id: device.id, active: device.active } : input);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setOpen(false);
      setForm(blank());
      router.refresh();
    });
  }

  return (
    <>
      {device ? (
        <Button size="sm" variant="ghost" onClick={openDialog} aria-label={`Edit ${device.name}`} title="Edit">
          <Pencil className="h-3.5 w-3.5" />
        </Button>
      ) : (
        <Button onClick={openDialog}>
          <Plus className="mr-1.5 h-3.5 w-3.5" />
          Register terminal
        </Button>
      )}
      <Dialog open={open} onClose={() => setOpen(false)} title={device ? "Edit terminal" : "Register a biometric terminal"}>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="serial">Serial number</Label>
            <Input
              id="serial"
              value={form.serialNumber}
              onChange={(e) => setForm((f) => ({ ...f, serialNumber: e.target.value.toUpperCase() }))}
              placeholder="CJXK194860123"
              className="font-mono"
            />
            <p className="text-xs text-subtle">
              Exactly as the device reports it — this is the only thing identifying it, and a mismatch means every
              upload is refused.
              {device && " Change it only if it was typed wrong; its punches so far stay with the terminal."}
            </p>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="devName">Name</Label>
              <Input
                id="devName"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="Main gate"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="devLoc">Location</Label>
              <Input
                id="devLoc"
                value={form.location}
                onChange={(e) => setForm((f) => ({ ...f, location: e.target.value }))}
                placeholder="Noida office, ground floor"
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="devIps">Accepted from</Label>
            <Input
              id="devIps"
              value={form.allowedIps}
              onChange={(e) => setForm((f) => ({ ...f, allowedIps: e.target.value }))}
              placeholder="Any address"
              className="font-mono"
            />
            <p className="text-xs text-subtle">
              The addresses this terminal calls from — an IP number such as 203.0.113.7, or a range such as
              203.0.113.0/24, separated by commas. A call from anywhere else is refused, because its serial alone proves
              nothing. Behind an office router, that is the office&apos;s public address. A list only works when the
              server is set up to see callers&apos; addresses behind its proxy (TRUST_PROXY=1) — saving one tells you if
              it isn&apos;t.
            </p>
          </div>
          {!form.allowedIps.trim() && (
            <label className="flex items-start gap-2 rounded-md border border-line p-3 text-sm">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={form.acceptAnyAddress}
                onChange={(e) => setForm((f) => ({ ...f, acceptAnyAddress: e.target.checked }))}
              />
              <span>
                <span className="font-medium text-text">Accept this terminal from any address</span>
                <span className="mt-0.5 block text-xs text-warning">
                  Not recommended. With no address list, anyone who knows the serial printed on the device can send punches
                  that become attendance. Leave it unticked and the terminal&apos;s punches are refused until it has a list.
                </span>
              </span>
            </label>
          )}
          {error && <p className="text-sm text-danger">{error}</p>}
          <div className="flex gap-2">
            <Button disabled={pending || !form.serialNumber || !form.name} onClick={save}>
              {pending ? "Saving…" : device ? "Save" : "Register"}
            </Button>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}

function ImportDialog({ devices }: { devices: Device[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [deviceId, setDeviceId] = useState(devices[0]?.id ?? "");
  const [contents, setContents] = useState("");

  function submit() {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const result = await importPunchFile(deviceId, contents);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      const d = result.data;
      setNotice(
        `${d.parsed} row(s) read, ${d.stored} new, ${d.linked} matched to people, ${d.days} attendance day(s) written${d.rejected > 0 ? `. ${d.rejected} row(s) unreadable.` : "."}`,
      );
      setContents("");
      router.refresh();
    });
  }

  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        <Upload className="mr-1.5 h-3.5 w-3.5" />
        Import a file
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Import attendance from a file">
        <div className="space-y-4">
          <p className="rounded-base border border-line bg-surface-sunken px-3 py-2 text-xs text-muted">
            For sites where the terminal can&apos;t reach this server. Export from eTimeTrackLite (or pull the .dat off
            the device) and paste it here — it&apos;s the same tab-separated format the terminals push, so the same
            reader handles it. Re-importing the same file is harmless.
          </p>

          <div className="space-y-1.5">
            <Label htmlFor="impDevice">Which terminal did it come from?</Label>
            <Select id="impDevice" value={deviceId} onChange={(e) => setDeviceId(e.target.value)}>
              {devices.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name} ({d.serialNumber})
                </option>
              ))}
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="impBody">File contents</Label>
            <textarea
              id="impBody"
              rows={8}
              value={contents}
              onChange={(e) => setContents(e.target.value)}
              placeholder={"1\t2026-09-18 09:15:00\t0\t1\t0\t0\n2\t2026-09-18 09:22:14\t0\t1\t0\t0"}
              className="w-full rounded-base border border-line-strong bg-surface px-3 py-2 font-mono text-xs text-text"
            />
          </div>

          {error && <p className="text-sm text-danger">{error}</p>}
          {notice && <p className="text-sm text-success">{notice}</p>}

          <div className="flex gap-2">
            <Button disabled={pending || !contents.trim() || !deviceId} onClick={submit}>
              {pending ? "Importing…" : "Import"}
            </Button>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Close
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
