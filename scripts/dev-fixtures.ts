/**
 * DEVELOPMENT ONLY: inserts synthetic sample services, cleaners and customers
 * into ONE organization so the operational screens can be explored.
 *
 *   npm run dev:fixtures -- --org-id <24-hex id> --yes
 *
 * Refuses when NODE_ENV=production, without --yes, or when the organization
 * already has services (never mixes samples into real data). All contact
 * details are fictional (555 numbers, example.test emails).
 */
import "./_env";
import { parseArgs } from "node:util";
import { Types } from "mongoose";
import { connectDb, disconnectDb } from "@/lib/db/connect";
import { Cleaner } from "@/lib/db/models/cleaner";
import { Customer } from "@/lib/db/models/customer";
import { Organization } from "@/lib/db/models/organization";
import { Service } from "@/lib/db/models/service";
import { ServiceAddress } from "@/lib/db/models/service-address";
import { normalizeCity } from "@/lib/domain/normalize";

function fail(msg: string): never {
  console.error(`✖ ${msg}`);
  process.exit(1);
}

async function main() {
  if (process.env.NODE_ENV === "production") fail("Refusing to add sample data with NODE_ENV=production.");
  const { values } = parseArgs({ options: { "org-id": { type: "string" }, yes: { type: "boolean", default: false } } });
  const orgId = values["org-id"];
  if (!orgId || !/^[a-f0-9]{24}$/i.test(orgId)) fail("Pass --org-id <organization id>.");
  if (!values.yes) fail("This adds sample data. Re-run with --yes if this is a development organization.");
  await connectDb();
  const org = await Organization.findById(orgId).lean();
  if (!org) fail("Organization not found.");
  if (await Service.exists({ organizationId: org._id })) fail("This organization already has services; refusing to mix sample data into it.");
  const oid = new Types.ObjectId(orgId);

  const services = [
    ["Sofa cleaning", "Upholstery", 12000, 90, "sofa"],
    ["Carpet cleaning", "Floors", 4500, 30, "room"],
    ["Mattress cleaning", "Upholstery", 8000, 45, "mattress"],
    ["House cleaning", "Residential", 3500, 60, "hour"],
  ] as const;
  for (const [name, category, price, minutes, unit] of services) {
    await Service.create({ organizationId: oid, name, searchName: name.toLowerCase(), category, defaultPriceCents: price, currency: org.currency, durationMinutes: minutes, unitLabel: unit });
  }
  for (const [name, phone] of [["Sample Cleaner A", "+15145550111"], ["Sample Cleaner B", "+15145550112"]] as const) {
    await Cleaner.create({ organizationId: oid, name, searchName: name.toLowerCase(), phone, phoneDisplay: phone.replace(/^\+1(\d{3})(\d{3})(\d{4})$/, "($1) $2-$3"), serviceAreas: ["Montreal"] });
  }
  const customers = [
    { first: "Alex", last: "Sample", phone: "+15145550131", city: "Montreal", line1: "123 Example Street" },
    { first: "Jamie", last: "Placeholder", phone: "+14385550132", city: "Laval", line1: "45 Fictional Avenue" },
  ];
  for (const c of customers) {
    const name = `${c.first} ${c.last}`;
    const doc = await Customer.create({
      organizationId: oid,
      name,
      searchName: name.toLowerCase(),
      firstName: c.first,
      lastName: c.last,
      phone: c.phone,
      phoneDigits: c.phone.replace(/\D/g, ""),
      phoneDisplay: c.phone.replace(/^\+1(\d{3})(\d{3})(\d{4})$/, "($1) $2-$3"),
      email: `${c.first.toLowerCase()}@example.test`,
      addressCities: [normalizeCity(c.city)],
      primaryCity: c.city,
      tags: ["sample"],
    });
    await ServiceAddress.create({ organizationId: oid, customerId: doc._id, label: "Home", line1: c.line1, city: c.city, cityNormalized: normalizeCity(c.city), region: "QC", country: "Canada", isPrimary: true });
  }
  console.log("✔ Added 4 services, 2 cleaners and 2 customers (all synthetic, tagged “sample”).");
}

main()
  .catch((err) => {
    console.error("✖", err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  })
  .finally(() => disconnectDb());
