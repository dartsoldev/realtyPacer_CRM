/**
 * LOCAL DEVELOPMENT ONLY: starts an in-memory MongoDB and a local SMTP sink so
 * the full app (including email flows) can be exercised without real services.
 *
 *   npm run dev:services      # then, in another terminal: npm run dev
 *
 * Use with .env.local:
 *   MONGODB_URI=mongodb://127.0.0.1:27027/realtypacer
 *   SMTP_HOST=127.0.0.1  SMTP_PORT=2525  SMTP_SECURE=false  EMAIL_FROM="RealtyPacer Dev <dev@localhost>"
 *
 * Emails are written to .dev-mail/*.eml (gitignored) and never leave this machine.
 * Data is discarded when the process stops.
 *
 *   npm run dev:services -- --smtp-only   # just the mail sink (use your own MongoDB)
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { MongoMemoryServer } from "mongodb-memory-server";
import { SMTPServer } from "smtp-server";

const MONGO_PORT = Number(process.env.DEV_MONGO_PORT ?? 27027);
const SMTP_PORT = Number(process.env.DEV_SMTP_PORT ?? 2525);
const outDir = path.resolve(process.cwd(), ".dev-mail");

const smtpOnly = process.argv.includes("--smtp-only");

async function main() {
  const mongo = smtpOnly ? null : await MongoMemoryServer.create({ instance: { port: MONGO_PORT, ip: "127.0.0.1" } });
  if (mongo) console.log(`✔ MongoDB (in-memory) at ${mongo.getUri()}realtypacer`);

  mkdirSync(outDir, { recursive: true });
  const smtp = new SMTPServer({
    authOptional: true,
    disabledCommands: ["STARTTLS"],
    onData(stream, session, callback) {
      const chunks: Buffer[] = [];
      stream.on("data", (c: Buffer) => chunks.push(c));
      stream.on("end", () => {
        const file = path.join(outDir, `${Date.now()}-${session.id}.eml`);
        writeFileSync(file, Buffer.concat(chunks));
        console.log(`✉ Captured email → ${path.relative(process.cwd(), file)}`);
        callback();
      });
    },
  });
  smtp.listen(SMTP_PORT, "127.0.0.1", () => console.log(`✔ SMTP sink on 127.0.0.1:${SMTP_PORT} (emails saved to .dev-mail/)`));

  const stop = async () => {
    smtp.close();
    await mongo?.stop();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
