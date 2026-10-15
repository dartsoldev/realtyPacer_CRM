import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Attachment } from "@/lib/db/models/attachment";
import { Customer } from "@/lib/db/models/customer";
import { ImportJob } from "@/lib/db/models/import-job";
import { MemoryStorage, setStorageForTests } from "@/lib/storage";
import { completeUpload, deleteAttachment, initiateUpload, listAttachments, openAttachment } from "@/modules/attachments/service";
import { createBooking } from "@/modules/bookings/service";
import { linkCleanerUser } from "@/modules/cleaners/service";
import { createDefinition } from "@/modules/custom-fields/service";
import { getCustomer } from "@/modules/customers/service";
import { decideRows, getImport, previewImport, runImportBatch, uploadImport } from "@/modules/imports/customers";
import * as contentRoute from "@/app/api/v1/attachments/[id]/content/route";
import { createUser, ctx, signInAs, signOut } from "./helpers/fixtures";
import { actorFor, bookingBody, customerWithAddress, opsWorld } from "./helpers/ops-fixtures";

vi.mock("@/lib/auth/claims", () => ({ getSessionClaims: vi.fn() }));

describe("customer CSV import", () => {
  it("maps, validates, flags duplicates, honours explicit decisions and never duplicates on retry", async () => {
    const { admin } = await opsWorld();
    const pets = await createDefinition(admin, { entityType: "customer", label: "Pets", dataType: "number", filterable: true });
    const existing = await customerWithAddress(admin, { firstName: "Existing", lastName: "Person", phone: "(416) 555-0101", email: "", notes: "keep me" });
    const csv = [
      "First name,Last name,Phone,Email,City,Address line 1,Pets,Notes,=EVIL()",
      "Avery,Sample,(416) 555-0101,avery@example.test,Toronto,12 Example Ave,2,new note,x", // duplicate of existing (phone)
      "Jordan,Placeholder,(905) 555-0102,,Mississauga,40 Fictional Rd,abc,,x", // invalid custom field
      "Riley,Testcase,,riley@example.test,,,,,x", // valid, no address
      ",,,,,,,,x", // invalid: no name or contact
    ].join("\n");
    const { id } = await uploadImport(admin, { fileName: "../../etc/clients.csv", csv });
    const job = await ImportJob.findById(id).lean();
    expect(job!.fileName).not.toContain("/");
    await expect(previewImport(admin, id, { mapping: { "8": "$where" } })).rejects.toThrow();
    await expect(previewImport(admin, id, { mapping: { "0": "firstName", "1": "firstName" } })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(previewImport(admin, id, { mapping: { "0": "organizationId" } })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    const view = await previewImport(admin, id, { mapping: { "0": "firstName", "1": "lastName", "2": "phone", "3": "email", "4": "address.city", "5": "address.line1", "6": `cf:${pets.key}`, "7": "notes" } });
    expect(view.totals).toMatchObject({ rows: 4, withErrors: 2, duplicates: 1, undecided: 1, toCreate: 1, toSkip: 2 });
    await expect(runImportBatch(admin, id)).rejects.toMatchObject({ code: "ROWS_UNDECIDED" });
    await expect(decideRows(admin, id, { expectedRevision: view.revision, decisions: [{ n: 2, decision: "create" }] })).rejects.toMatchObject({ code: "VALIDATION_ERROR" }); // has errors
    const decided = await decideRows(admin, id, { expectedRevision: view.revision, decisions: [{ n: 1, decision: "update", targetId: existing.customer.id, overwrite: [] }] });

    const done = await runImportBatch(admin, id);
    expect(done.status).toBe("completed");
    expect(done.totals).toMatchObject({ created: 1, updated: 1, skipped: 2, failed: 0 });
    const updated = await getCustomer(admin, existing.customer.id);
    expect(updated.notes).toBe("keep me"); // non-empty field kept without explicit overwrite
    expect(updated.email).toBe("avery@example.test"); // blank filled
    expect(updated.customFields[pets.key]).toBe(2);
    expect(updated.firstName).toBe("Existing");

    // Simulate a crash after creating but before recording the result: re-running must not duplicate.
    const before = await Customer.countDocuments({});
    await ImportJob.updateOne({ _id: id }, { $set: { status: "running", "rows.2.result": null } });
    await runImportBatch(admin, id);
    expect(await Customer.countDocuments({})).toBe(before);
    expect(decided.status).toBe("previewed");
  });

  it("enforces permissions and limits", async () => {
    const { admin, org } = await opsWorld();
    const staff = await actorFor(await createUser(org._id, { role: "STAFF" }));
    await expect(uploadImport(staff, { csv: "First name\nA" })).rejects.toMatchObject({ status: 403 });
    await expect(uploadImport(admin, { csv: "First name" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    const big = `First name\n${"A\n".repeat(5001)}`;
    await expect(uploadImport(admin, { csv: big })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    const { id } = await uploadImport(admin, { csv: "First name,Phone\nA,4165550111" });
    const otherOrgAdmin = await actorFor(await createUser((await (await import("./helpers/fixtures")).createOrg("Else"))._id, { role: "ADMIN" }));
    await expect(getImport(otherOrgAdmin, id)).rejects.toMatchObject({ status: 404 });
  });
});

describe("private attachments", () => {
  let store: MemoryStorage;
  beforeEach(() => {
    store = new MemoryStorage();
    setStorageForTests(store);
  });
  afterEach(() => setStorageForTests(null));

  async function uploadBytes(actor: Awaited<ReturnType<typeof actorFor>>, parent: { parentType: "booking" | "address"; parentId: string }, category: string, contentType: string, bytes: Buffer, declaredSize = bytes.length) {
    const init = await initiateUpload(actor, { ...parent, category, fileName: "photo of house.jpg", contentType, size: declaredSize });
    const att = await Attachment.findById(init.attachmentId).lean();
    await store.put(att!.storageKey, bytes, contentType); // what the browser would PUT to the presigned URL
    return init.attachmentId;
  }

  it("verifies content before attaching, makes thumbnails and enforces access", async () => {
    const { admin, org, sofa, ana, ben } = await opsWorld();
    const { customer, address } = await customerWithAddress(admin);
    const { booking } = await createBooking(admin, bookingBody({ customerId: customer.id, addressId: address.id, serviceId: String(sofa._id), date: "2031-06-01", startTime: "09:00", cleanerIds: [String(ana._id)] }));
    const jpeg = await sharp({ create: { width: 1200, height: 800, channels: 3, background: "#cc3333" } }).jpeg().toBuffer();

    // Spoofed type and size mismatch are rejected and the object is removed.
    const fake = await uploadBytes(admin, { parentType: "booking", parentId: booking.id }, "before_photo", "image/png", Buffer.from("<svg onload=alert(1)>"));
    await expect(completeUpload(admin, fake)).rejects.toMatchObject({ code: "UPLOAD_REJECTED" });
    const short = await uploadBytes(admin, { parentType: "booking", parentId: booking.id }, "before_photo", "image/jpeg", jpeg, jpeg.length + 10);
    await expect(completeUpload(admin, short)).rejects.toMatchObject({ code: "UPLOAD_REJECTED" });
    await expect(initiateUpload(admin, { parentType: "booking", parentId: booking.id, category: "document", fileName: "x.svg", contentType: "image/svg+xml", size: 10 })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(initiateUpload(admin, { parentType: "booking", parentId: booking.id, category: "document", fileName: "x.exe", contentType: "application/x-msdownload", size: 10 })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    const ok = await uploadBytes(admin, { parentType: "booking", parentId: booking.id }, "before_photo", "image/jpeg", jpeg);
    const item = await completeUpload(admin, ok);
    expect(item).toMatchObject({ width: 1200, height: 800, hasThumb: true });
    const pdf = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(200, 32)]);
    const doc = await uploadBytes(admin, { parentType: "booking", parentId: booking.id }, "document", "application/pdf", pdf);
    await completeUpload(admin, doc);

    // Assigned cleaner sees photos but not office documents; another cleaner sees nothing.
    const anaUser = await createUser(org._id, { role: "CLEANER" });
    const benUser = await createUser(org._id, { role: "CLEANER" });
    await linkCleanerUser(admin, String(ana._id), String(anaUser._id));
    await linkCleanerUser(admin, String(ben._id), String(benUser._id));
    const anaA = await actorFor(anaUser);
    const benA = await actorFor(benUser);
    expect((await listAttachments(anaA, { parentType: "booking", parentId: booking.id })).map((i) => i.category)).toEqual(["before_photo"]);
    await expect(openAttachment(anaA, doc, "original")).rejects.toMatchObject({ status: 404 });
    await expect(listAttachments(benA, { parentType: "booking", parentId: booking.id })).rejects.toMatchObject({ status: 404 });
    await expect(initiateUpload(anaA, { parentType: "booking", parentId: booking.id, category: "document", fileName: "a.pdf", contentType: "application/pdf", size: 100 })).rejects.toMatchObject({ status: 403 });
    const after = await uploadBytes(anaA, { parentType: "booking", parentId: booking.id }, "after_photo", "image/jpeg", jpeg);
    await completeUpload(anaA, after);

    // Authenticated route: requires a session; documents download; private caching only.
    await signOut();
    expect((await contentRoute.GET(new Request(`http://localhost:3000/api/v1/attachments/${ok}/content`), ctx({ id: ok }))).status).toBe(401);
    await signInAs(await createUser(org._id, { role: "ADMIN" }));
    const res = await contentRoute.GET(new Request(`http://localhost:3000/api/v1/attachments/${doc}/content`), ctx({ id: doc }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toMatch(/^attachment;/);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");

    // Other organization: guessed ids get nothing.
    const other = await actorFor(await createUser((await (await import("./helpers/fixtures")).createOrg("Elsewhere"))._id, { role: "ADMIN" }));
    await expect(openAttachment(other, ok, "original")).rejects.toMatchObject({ status: 404 });

    // Removal: uploader or attachments:delete only.
    await expect(deleteAttachment(benA, after)).rejects.toMatchObject({ status: 404 });
    await deleteAttachment(anaA, after);
    expect(store.objects.size).toBe(3); // before photo + its thumbnail + pdf; rejected and deleted objects are gone
  });
});
