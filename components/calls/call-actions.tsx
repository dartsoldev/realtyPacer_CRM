"use client";

import { Check, Copy, Headset, Mic, MicOff, NotebookPen, Phone, PhoneOff } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Modal } from "@/components/ui/dialog";
import { Field, Input, Select } from "@/components/ui/field";
import { apiRequest } from "@/lib/client/api";
import { useIdempotencyKey } from "@/lib/client/hooks";
import { CALL_OUTCOME_LABELS, MANUAL_CALL_OUTCOMES } from "@/lib/domain/constants";
import { telHref } from "@/lib/domain/links";

export type CallTarget = { type: "customer" | "cleaner"; id: string; name: string; bookingId?: string };

/** Copies the number; falls back to selecting text when the Clipboard API is unavailable. */
function CopyNumber({ value, display }: { value: string; display: string }) {
  const [copied, setCopied] = useState(false);
  const fallbackRef = useRef<HTMLInputElement>(null);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      fallbackRef.current?.select();
    }
  }
  return (
    <>
      <button type="button" onClick={() => void copy()} className="inline-flex min-h-9 min-w-9 items-center justify-center rounded-md px-2 text-muted hover:bg-canvas hover:text-ink" aria-label={`Copy number ${display}`}>
        {copied ? <Check className="size-4 text-success" aria-hidden /> : <Copy className="size-4" aria-hidden />}
      </button>
      <input ref={fallbackRef} readOnly value={value} className="sr-only" aria-hidden tabIndex={-1} />
      <span role="status" className="sr-only">{copied ? "Number copied" : ""}</span>
    </>
  );
}

function LogCallDialog({ target, open, onClose }: { target: CallTarget; open: boolean; onClose: () => void }) {
  const router = useRouter();
  const idem = useIdempotencyKey();
  const [direction, setDirection] = useState<"outbound" | "inbound">("outbound");
  const [outcome, setOutcome] = useState<(typeof MANUAL_CALL_OUTCOMES)[number]>("answered");
  const [minutes, setMinutes] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function save() {
    const m = minutes.trim() === "" ? undefined : Number(minutes);
    if (m !== undefined && (!Number.isInteger(m) || m < 0 || m > 600)) return setError("Duration must be whole minutes (0–600).");
    setBusy(true);
    setError(null);
    const res = await apiRequest("/api/v1/calls", {
      method: "POST",
      body: { idempotencyKey: idem.key, targetType: target.type, targetId: target.id, ...(target.bookingId ? { bookingId: target.bookingId } : {}), direction, outcome, ...(m !== undefined ? { durationMinutes: m } : {}), notes },
    });
    setBusy(false);
    if (!res.ok) return setError(res.message);
    idem.renew();
    setNotes("");
    setMinutes("");
    onClose();
    window.dispatchEvent(new Event("rp:activity-changed"));
    router.refresh();
  }
  return (
    <Modal title={`Log a call with ${target.name}`} open={open} onClose={onClose}>
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <p className="text-sm text-muted">Record what happened on a call made from your phone. Opening the dialer never logs a call by itself.</p>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Direction">
            {(p) => (
              <Select {...p} data-autofocus value={direction} onChange={(e) => setDirection(e.target.value as "outbound" | "inbound")}>
                <option value="outbound">I called them</option>
                <option value="inbound">They called us</option>
              </Select>
            )}
          </Field>
          <Field label="Outcome" required>
            {(p) => (
              <Select {...p} value={outcome} onChange={(e) => setOutcome(e.target.value as typeof outcome)}>
                {MANUAL_CALL_OUTCOMES.map((o) => <option key={o} value={o}>{CALL_OUTCOME_LABELS[o]}</option>)}
              </Select>
            )}
          </Field>
          <Field label="Duration (minutes)" hint="Optional">
            {(p) => <Input {...p} inputMode="numeric" value={minutes} onChange={(e) => setMinutes(e.target.value)} />}
          </Field>
        </div>
        <Field label="Notes">
          {(p) => <textarea id={p.id} aria-describedby={p.describedBy} rows={3} maxLength={2000} value={notes} onChange={(e) => setNotes(e.target.value)} className="block w-full rounded-lg border border-line bg-surface px-3 py-2 text-base sm:text-sm" />}
        </Field>
        {error ? <Alert tone="danger" title="Not saved">{error}</Alert> : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={busy}>Save call</Button>
        </div>
      </form>
    </Modal>
  );
}

type Phase = "idle" | "mic" | "starting" | "connecting" | "ringing" | "connected" | "ended" | "failed";
const PHASE_TEXT: Record<Phase, string> = {
  idle: "Ready",
  mic: "Waiting for microphone permission…",
  starting: "Starting…",
  connecting: "Connecting…",
  ringing: "Ringing…",
  connected: "Connected",
  ended: "Call ended",
  failed: "Call failed",
};

type VoiceCall = { on: (e: string, cb: (...a: unknown[]) => void) => void; mute: (m?: boolean) => void; disconnect: () => void };
type VoiceDevice = { connect: (o: { params: Record<string, string> }) => Promise<VoiceCall>; on: (e: string, cb: (...a: unknown[]) => void) => void; updateToken: (t: string) => void; destroy: () => void };

/**
 * Browser call via Twilio Voice (only when CALLING_MODE=browser is configured).
 * The SDK is loaded on demand. The browser sends only the server-issued call id;
 * the server decides the destination and caller ID.
 */
function BrowserCallDialog({ target, open, onClose }: { target: CallTarget; open: boolean; onClose: () => void }) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("idle");
  const [muted, setMuted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [seconds, setSeconds] = useState(0);
  const [callLogId, setCallLogId] = useState<string | null>(null);
  const [notes, setNotes] = useState("");
  const deviceRef = useRef<VoiceDevice | null>(null);
  const callRef = useRef<VoiceCall | null>(null);

  useEffect(() => {
    if (phase !== "connected") return;
    const t = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [phase]);
  useEffect(() => () => deviceRef.current?.destroy(), []);

  async function fail(message: string, id: string | null, reason: string) {
    setPhase("failed");
    setError(message);
    if (id) await apiRequest(`/api/v1/calls/${id}/failed`, { method: "POST", body: { reason } });
  }

  async function start() {
    setError(null);
    setSeconds(0);
    setPhase("mic");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
    } catch {
      return fail("Microphone access was blocked. Allow the microphone for this site in your browser settings, or use your phone.", null, "microphone");
    }
    setPhase("starting");
    const res = await apiRequest<{ callLogId: string; token: string }>("/api/v1/calls/browser", { method: "POST", body: { targetType: target.type, targetId: target.id, ...(target.bookingId ? { bookingId: target.bookingId } : {}) } });
    if (!res.ok) return fail(res.message, null, "start");
    setCallLogId(res.data.callLogId);
    try {
      const { Device } = await import("@twilio/voice-sdk");
      const device = new Device(res.data.token, { closeProtection: true }) as unknown as VoiceDevice;
      deviceRef.current = device;
      device.on("tokenWillExpire", () => {
        void apiRequest<{ token: string }>("/api/v1/calls/browser/token", { method: "POST" }).then((r) => r.ok && device.updateToken(r.data.token));
      });
      device.on("error", () => setError("The calling service reported an error."));
      setPhase("connecting");
      const call = await device.connect({ params: { callLogId: res.data.callLogId } });
      callRef.current = call;
      call.on("ringing", () => setPhase("ringing"));
      call.on("accept", () => setPhase("connected"));
      call.on("mute", (isMuted) => setMuted(Boolean(isMuted)));
      call.on("disconnect", () => { setPhase("ended"); router.refresh(); });
      call.on("cancel", () => setPhase("ended"));
      call.on("error", () => { setPhase("failed"); setError("The call dropped or could not connect."); });
    } catch {
      return fail("The call could not be started. Check your connection and try again, or use your phone.", res.data.callLogId, "sdk");
    }
  }

  async function saveNotes() {
    if (!callLogId || !notes.trim()) return;
    await apiRequest(`/api/v1/calls/${callLogId}`, { method: "PATCH", body: { notes } });
    window.dispatchEvent(new Event("rp:activity-changed"));
    router.refresh();
    onClose();
  }

  const live = phase === "connecting" || phase === "ringing" || phase === "connected";
  const mmss = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  return (
    <Modal title={`Call ${target.name}`} open={open} onClose={() => { if (!live) onClose(); }}>
      <div className="space-y-4">
        <p className="text-sm text-muted">Calls from your browser use the organization’s phone number and your microphone. The call result is reported by the phone network, not assumed.</p>
        <p role="status" aria-live="polite" className={cn("rounded-lg p-3 text-center text-base font-semibold", phase === "connected" ? "bg-success-soft text-success" : phase === "failed" ? "bg-danger-soft text-danger" : "bg-canvas")}>
          {PHASE_TEXT[phase]}{phase === "connected" ? ` · ${mmss}` : ""}
        </p>
        {error ? <Alert tone="danger" title="Problem">{error}</Alert> : null}
        <div className="flex flex-wrap justify-center gap-2">
          {phase === "idle" || phase === "failed" || phase === "ended" ? (
            <Button data-autofocus onClick={() => void start()}>
              <Phone className="size-4" aria-hidden /> {phase === "idle" ? "Start call" : "Call again"}
            </Button>
          ) : null}
          {live ? (
            <>
              <Button variant="secondary" onClick={() => callRef.current?.mute(!muted)} aria-pressed={muted}>
                {muted ? <MicOff className="size-4" aria-hidden /> : <Mic className="size-4" aria-hidden />} {muted ? "Unmute" : "Mute"}
              </Button>
              <Button variant="danger" onClick={() => callRef.current?.disconnect()}>
                <PhoneOff className="size-4" aria-hidden /> Hang up
              </Button>
            </>
          ) : null}
        </div>
        {phase === "ended" && callLogId ? (
          <div className="space-y-2">
            <Field label="Notes about this call">
              {(p) => <textarea id={p.id} rows={3} maxLength={2000} value={notes} onChange={(e) => setNotes(e.target.value)} className="block w-full rounded-lg border border-line bg-surface px-3 py-2 text-base sm:text-sm" />}
            </Field>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={onClose}>Close</Button>
              <Button onClick={() => void saveNotes()} disabled={!notes.trim()}>Save notes</Button>
            </div>
          </div>
        ) : !live ? (
          <div className="flex justify-end"><Button variant="secondary" onClick={onClose}>Close</Button></div>
        ) : null}
      </div>
    </Modal>
  );
}

/**
 * Call controls for a phone number: dialer link (opens the device's phone app),
 * copy, manual "Log call" and — when configured — a browser call.
 */
export function CallActions({ e164, display, target, canLog, browserCalling, compact }: { e164: string | null; display?: string | null; target: CallTarget; canLog: boolean; browserCalling: boolean; compact?: boolean }) {
  const [logOpen, setLogOpen] = useState(false);
  const [browserOpen, setBrowserOpen] = useState(false);
  if (!e164) return <span className="text-sm text-muted">No phone number</span>;
  const shown = display ?? e164;
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <a href={telHref(e164)} className="inline-flex min-h-9 items-center gap-1.5 rounded-md font-medium text-brand underline-offset-4 hover:underline" aria-label={`Call ${shown} — opens your phone app`}>
        <Phone className="size-4" aria-hidden />
        {shown}
      </a>
      <CopyNumber value={e164} display={shown} />
      {canLog ? (
        <button type="button" onClick={() => setLogOpen(true)} className="inline-flex min-h-9 items-center gap-1 rounded-md px-2 text-sm text-muted hover:bg-canvas hover:text-ink" aria-label={`Log a call with ${target.name}`}>
          <NotebookPen className="size-4" aria-hidden />
          {compact ? null : "Log call"}
        </button>
      ) : null}
      {browserCalling ? (
        <button type="button" onClick={() => setBrowserOpen(true)} className="inline-flex min-h-9 items-center gap-1 rounded-md px-2 text-sm text-muted hover:bg-canvas hover:text-ink" aria-label={`Call ${target.name} from the browser`}>
          <Headset className="size-4" aria-hidden />
          {compact ? null : "Call in browser"}
        </button>
      ) : null}
      {logOpen ? <LogCallDialog target={target} open onClose={() => setLogOpen(false)} /> : null}
      {browserOpen ? <BrowserCallDialog target={target} open onClose={() => setBrowserOpen(false)} /> : null}
    </span>
  );
}
