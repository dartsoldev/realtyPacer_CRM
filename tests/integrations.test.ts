import { randomBytes } from "node:crypto";
import twilio from "twilio";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Activity } from "@/lib/db/models/activity";
import { CallLog } from "@/lib/db/models/call-log";
import { Notification } from "@/lib/db/models/notification";
import { Organization } from "@/lib/db/models/organization";
import { OutboxMessage } from "@/lib/db/models/outbox-message";
import { EmailDeliveryError } from "@/lib/email/mailer";
import { createBooking, transitionBooking, updateBooking } from "@/modules/bookings/service";
import { previewBookingEmail, sendBookingEmail } from "@/modules/bookings/emails";
import { applyCallStatus, logCall, startBrowserCall, voiceTwiml } from "@/modules/calls/service";
import { linkCleanerUser } from "@/modules/cleaners/service";
import { listNotifications, markRead } from "@/modules/notifications/service";
import { enqueueEmail, processOutboxBatch } from "@/modules/outbox/service";
import * as statusRoute from "@/app/api/v1/telephony/twilio/status/route";
import * as voiceRoute from "@/app/api/v1/telephony/twilio/voice/route";
import { createOrg, createUser } from "./helpers/fixtures";
import { actorFor, bookingBody, customerWithAddress, opsWorld } from "./helpers/ops-fixtures";
import { key } from "./helpers/finance-fixtures";

vi.mock("@/lib/auth/claims", () => ({ getSessionClaims: vi.fn() }));

const hex = (n: number) => randomBytes(n).toString("hex");
const TWILIO = {
  CALLING_MODE: "browser",
  TWILIO_ACCOUNT_SID: `AC${hex(16)}`,
  TWILIO_API_KEY_SID: `SK${hex(16)}`,
  TWILIO_API_KEY_SECRET: hex(16),
  TWILIO_AUTH_TOKEN: hex(16),
  TWILIO_TWIML_APP_SID: `AP${hex(16)}`,
  TWILIO_CALLER_ID: "+14165550100",
  CALLING_ALLOWED_COUNTRIES: "CA,US",
};
const callSid = () => `CA${hex(16)}`;

function twilioRequest(path: string, params: Record<string, string>, signature?: string) {
  const url = `http://localhost:3000${path}`;
  const sig = signature ?? twilio.getExpectedTwilioSignature(TWILIO.TWILIO_AUTH_TOKEN, url, params);
  return new Request(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": sig }, body: new URLSearchParams(params).toString() });
}

describe("calls", () => {
  it("logs phone-app calls idempotently and mirrors them into the customer timeline", async () => {
    const { admin } = await opsWorld();
    const { customer } = await customerWithAddress(admin);
    const body = { idempotencyKey: key(), targetType: "customer", targetId: customer.id, direction: "outbound", outcome: "no_answer", durationMinutes: 0, notes: "Left no message" };
    const a = await logCall(admin, body);
    const b = await logCall(admin, body);
    expect(a.created).toBe(true);
    expect(b).toEqual({ id: a.id, created: false });
    expect(await CallLog.countDocuments({})).toBe(1);
    const act = await Activity.findOne({ type: "call", customerId: customer.id }).lean();
    expect(act?.callOutcome).toBe("no_answer");
    // Never "answered" unless someone recorded it; manual entry can't claim provider outcomes.
    await expect(logCall(admin, { ...body, idempotencyKey: key(), outcome: "failed" })).rejects.toThrow();
  });

  it("refuses other organizations' records and cleaners", async () => {
    const { admin, org } = await opsWorld();
    const other = await createOrg("Other Co");
    const otherAdmin = await actorFor(await createUser(other._id, { role: "ADMIN" }));
    const { customer } = await customerWithAddress(admin);
    await expect(logCall(otherAdmin, { idempotencyKey: key(), targetType: "customer", targetId: customer.id, direction: "outbound", outcome: "answered" })).rejects.toMatchObject({ status: 404 });
    const cleaner = await actorFor(await createUser(org._id, { role: "CLEANER" }));
    await expect(logCall(cleaner, { idempotencyKey: key(), targetType: "customer", targetId: customer.id, direction: "outbound", outcome: "answered" })).rejects.toMatchObject({ status: 403 });
  });

  describe("browser calling (Twilio, mocked network)", () => {
    beforeEach(() => Object.assign(process.env, TWILIO));
    afterEach(() => {
      for (const k of Object.keys(TWILIO)) delete process.env[k];
    });

    it("is unavailable in tel mode", async () => {
      process.env.CALLING_MODE = "tel";
      const { admin } = await opsWorld();
      const { customer } = await customerWithAddress(admin);
      await expect(startBrowserCall(admin, { targetType: "customer", targetId: customer.id })).rejects.toMatchObject({ status: 503, code: "CALLING_NOT_CONFIGURED" });
    });

    it("issues a short-lived token, dials only the stored number for the right identity, and applies callbacks idempotently", async () => {
      const { admin, adminDoc } = await opsWorld();
      const { customer } = await customerWithAddress(admin);
      const started = await startBrowserCall(admin, { targetType: "customer", targetId: customer.id });
      const claims = JSON.parse(Buffer.from(started.token.split(".")[1]!, "base64url").toString());
      expect(claims.grants.voice.outgoing.application_sid).toBe(TWILIO.TWILIO_TWIML_APP_SID);
      expect(claims.grants.voice.incoming?.allow ?? false).toBe(false);
      expect(claims.exp - claims.iat).toBeLessThanOrEqual(600);

      // Wrong identity: refused. Destination is never taken from the request.
      const parent = callSid();
      const evil = await voiceTwiml({ callLogId: started.callLogId, From: "client:rp_someoneelse", CallSid: parent, To: "+19005550100" });
      expect(evil).toContain("<Hangup");
      const twiml = await voiceTwiml({ callLogId: started.callLogId, From: `client:rp_${adminDoc._id}`, CallSid: parent, To: "+19005550100" });
      expect(twiml).toContain("<Dial");
      expect(twiml).toContain("+15145550199");
      expect(twiml).toContain(`callerId="${TWILIO.TWILIO_CALLER_ID}"`);
      expect(twiml).not.toContain("+19005550100");
      // A used call id can't start a second call.
      expect(await voiceTwiml({ callLogId: started.callLogId, From: `client:rp_${adminDoc._id}`, CallSid: callSid() })).toContain("<Hangup");

      const child = callSid();
      const ev = (status: string, seq: number, extra: Record<string, string> = {}) => ({ ParentCallSid: parent, CallSid: child, CallStatus: status, SequenceNumber: String(seq), ...extra });
      expect(await applyCallStatus(ev("ringing", 1))).toEqual({ applied: true });
      expect(await applyCallStatus(ev("ringing", 1))).toEqual({ applied: false }); // duplicate
      expect(await applyCallStatus(ev("in-progress", 2))).toEqual({ applied: true });
      expect(await applyCallStatus(ev("completed", 3, { CallDuration: "47" }))).toEqual({ applied: true });
      expect(await applyCallStatus(ev("ringing", 2))).toEqual({ applied: false }); // late, out of order
      const log = await CallLog.findById(started.callLogId).lean();
      expect(log).toMatchObject({ status: "completed", outcome: "answered", durationSeconds: 47, providerChildSid: child });
    });

    it("rejects destinations outside the allowed countries", async () => {
      const { admin } = await opsWorld();
      const { customer } = await customerWithAddress(admin, { phone: "+33 1 23 45 67 89" });
      await expect(startBrowserCall(admin, { targetType: "customer", targetId: customer.id })).rejects.toMatchObject({ status: 422, code: "DESTINATION_NOT_ALLOWED" });
    });

    it("validates webhook signatures against APP_URL", async () => {
      const { admin, adminDoc } = await opsWorld();
      const { customer } = await customerWithAddress(admin);
      const started = await startBrowserCall(admin, { targetType: "customer", targetId: customer.id });
      const params = { callLogId: started.callLogId, From: `client:rp_${adminDoc._id}`, CallSid: callSid(), AccountSid: TWILIO.TWILIO_ACCOUNT_SID };
      expect((await voiceRoute.POST(twilioRequest("/api/v1/telephony/twilio/voice", params, "bad-signature"))).status).toBe(403);
      const ok = await voiceRoute.POST(twilioRequest("/api/v1/telephony/twilio/voice", params));
      expect(ok.status).toBe(200);
      expect(await ok.text()).toContain("<Dial");
      const status = { ParentCallSid: params.CallSid, CallSid: callSid(), CallStatus: "busy", SequenceNumber: "1" };
      expect((await statusRoute.POST(twilioRequest("/api/v1/telephony/twilio/status", { ...status, SequenceNumber: "9" }, twilio.getExpectedTwilioSignature(TWILIO.TWILIO_AUTH_TOKEN, "http://localhost:3000/api/v1/telephony/twilio/status", status)))).status).toBe(403); // tampered
      expect((await statusRoute.POST(twilioRequest("/api/v1/telephony/twilio/status", status))).status).toBe(204);
      expect((await CallLog.findById(started.callLogId).lean())?.outcome).toBe("busy");
    });
  });
});

describe("email outbox", () => {
  it("dedupes, retries with backoff and marks permanent failures", async () => {
    const org = await createOrg("Mail Co");
    const message = { to: "someone@example.test", subject: "Hello\r\nBcc: injected@example.test", html: "<p>x</p>", text: "x" };
    const a = await enqueueEmail({ organizationId: org._id, kind: "booking_confirmation", message, dedupeKey: "k1" });
    const b = await enqueueEmail({ organizationId: org._id, kind: "booking_confirmation", message, dedupeKey: "k1" });
    expect(b).toEqual({ id: a.id, created: false });
    expect((await OutboxMessage.findById(a.id).lean())!.subject).not.toMatch(/[\r\n]/);

    let t = Date.now();
    const now = () => new Date(t);
    const failing = vi.fn().mockRejectedValue(new EmailDeliveryError("SMTP_CONNECTION"));
    expect(await processOutboxBatch(10, now, failing)).toEqual({ sent: 0, retried: 1, failed: 0 });
    expect(await processOutboxBatch(10, now, failing)).toEqual({ sent: 0, retried: 0, failed: 0 }); // backoff: not due yet
    t += 61_000;
    const ok = vi.fn().mockResolvedValue({ messageId: "<m1@test>" });
    expect(await processOutboxBatch(10, now, ok)).toEqual({ sent: 1, retried: 0, failed: 0 });
    expect(ok).toHaveBeenCalledTimes(1);
    expect(await OutboxMessage.findById(a.id).lean()).toMatchObject({ status: "sent", attempts: 2 });

    const c = await enqueueEmail({ organizationId: org._id, kind: "booking_confirmation", message, dedupeKey: "k2" });
    await processOutboxBatch(10, now, vi.fn().mockRejectedValue(new EmailDeliveryError("SMTP_REJECTED_RECIPIENT")));
    expect(await OutboxMessage.findById(c.id).lean()).toMatchObject({ status: "failed", lastError: "SMTP_REJECTED_RECIPIENT" });
  });

  describe("booking emails", () => {
    beforeEach(() => Object.assign(process.env, { SMTP_HOST: "127.0.0.1", SMTP_PORT: "2525", SMTP_SECURE: "false", EMAIL_FROM: "Test <test@example.test>" }));
    afterEach(() => {
      for (const k of ["SMTP_HOST", "SMTP_PORT", "SMTP_SECURE", "EMAIL_FROM"]) delete process.env[k];
    });

    it("are off by default, preview without prices or office notes, and queue once per request", async () => {
      const { admin, org, sofa, ana } = await opsWorld();
      const { customer, address } = await customerWithAddress(admin, { email: "casey.client@example.test" });
      const { booking } = await createBooking(admin, { ...bookingBody({ customerId: customer.id, addressId: address.id, serviceId: String(sofa._id), date: "2031-03-03", startTime: "09:00", cleanerIds: [String(ana._id)] }), officeNotes: "SECRET-OFFICE-NOTE" });
      const off = await previewBookingEmail(admin, booking.id, "booking_confirmation");
      expect(off.blocked).toMatch(/turned off/);
      await expect(sendBookingEmail(admin, booking.id, { kind: "booking_confirmation", idempotencyKey: key() })).rejects.toMatchObject({ code: "BOOKING_EMAILS_OFF" });

      await Organization.updateOne({ _id: org._id }, { $set: { "notifications.customerBookingEmails": "manual" } });
      const p = await previewBookingEmail(admin, booking.id, "booking_confirmation");
      expect(p.blocked).toBeNull();
      expect(p.to).toBe("casey.client@example.test");
      expect(p.text).toContain(booking.reference);
      expect(p.text).not.toContain("SECRET-OFFICE-NOTE");
      expect(p.text).not.toMatch(/\$\d/);
      const k = key();
      const first = await sendBookingEmail(admin, booking.id, { kind: "booking_confirmation", idempotencyKey: k });
      const again = await sendBookingEmail(admin, booking.id, { kind: "booking_confirmation", idempotencyKey: k });
      expect(again.id).toBe(first.id);
      expect(await OutboxMessage.countDocuments({ relatedId: booking.id })).toBe(1);

      const noEmail = await customerWithAddress(admin, { email: "" });
      const { booking: b2 } = await createBooking(admin, bookingBody({ customerId: noEmail.customer.id, addressId: noEmail.address.id, serviceId: String(sofa._id), date: "2031-03-04", startTime: "09:00" }));
      expect((await previewBookingEmail(admin, b2.id, "booking_confirmation")).blocked).toMatch(/no email/);
    });

    it("are queued automatically on changes when set to auto (once per change)", async () => {
      const { admin, org, sofa } = await opsWorld();
      await Organization.updateOne({ _id: org._id }, { $set: { "notifications.customerBookingEmails": "auto" } });
      const { customer, address } = await customerWithAddress(admin, { email: "auto.client@example.test" });
      const { booking } = await createBooking(admin, bookingBody({ customerId: customer.id, addressId: address.id, serviceId: String(sofa._id), date: "2031-04-01", startTime: "09:00" }));
      await updateBooking(admin, booking.id, { expectedVersion: booking.version, date: "2031-04-02", startTime: "10:00", durationMinutes: 60 });
      const kinds = (await OutboxMessage.find({ relatedId: booking.id }).lean()).map((m) => m.kind).sort();
      expect(kinds).toEqual(["booking_changed", "booking_confirmation"]);
    });
  });
});

describe("in-app notifications", () => {
  it("notify only the linked cleaners concerned, and only their own can be read", async () => {
    const { admin, org, sofa, ana, ben } = await opsWorld();
    const anaUser = await createUser(org._id, { role: "CLEANER" });
    const benUser = await createUser(org._id, { role: "CLEANER" });
    await linkCleanerUser(admin, String(ana._id), String(anaUser._id));
    await linkCleanerUser(admin, String(ben._id), String(benUser._id));
    const { customer, address } = await customerWithAddress(admin);
    const { booking } = await createBooking(admin, bookingBody({ customerId: customer.id, addressId: address.id, serviceId: String(sofa._id), date: "2031-05-01", startTime: "09:00", cleanerIds: [String(ana._id)] }));
    const anaActor = await actorFor(anaUser);
    const benActor = await actorFor(benUser);
    expect((await listNotifications(anaActor)).items.map((n) => n.type)).toEqual(["assignment_added"]);
    expect((await listNotifications(benActor)).items).toHaveLength(0);

    const v1 = await updateBooking(admin, booking.id, { expectedVersion: booking.version, cleanerIds: [String(ben._id)] });
    expect((await listNotifications(anaActor)).items.map((n) => n.type)).toContain("assignment_removed");
    expect((await listNotifications(benActor)).items.map((n) => n.type)).toEqual(["assignment_added"]);
    const v2 = await updateBooking(admin, booking.id, { expectedVersion: v1.version, date: "2031-05-02", startTime: "11:00", durationMinutes: 60 });
    await transitionBooking(admin, booking.id, { action: "cancel", expectedVersion: v2.version, reason: "Customer request" });
    const benTypes = (await listNotifications(benActor)).items.map((n) => n.type);
    expect(benTypes).toEqual(expect.arrayContaining(["booking_rescheduled", "booking_cancelled"]));
    expect((await listNotifications(anaActor)).items.map((n) => n.type)).not.toContain("booking_cancelled");
    // Bodies never contain office data or prices.
    expect(JSON.stringify(await Notification.find({}).lean())).not.toMatch(/\$|officeNotes/);

    const anaIds = (await listNotifications(anaActor)).items.map((n) => n.id);
    expect(await markRead(benActor, { ids: anaIds })).toEqual({ updated: 0 });
    expect((await markRead(anaActor, { all: true })).updated).toBe(anaIds.length);
  });
});
