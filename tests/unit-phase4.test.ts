import { describe, expect, it } from "vitest";
import { parseCsv } from "@/lib/domain/csv-parse";
import { redact, redactString } from "@/lib/security/redact";
import { safeFileName, sniffType } from "@/modules/attachments/service";

describe("CSV parser", () => {
  it("handles quotes, escaped quotes, CRLF, BOM and blank lines", () => {
    const rows = parseCsv('\uFEFFa,b,c\r\n"x, y","he said ""hi""",\r\n\r\n1,"multi\nline",3\n');
    expect(rows).toEqual([
      ["a", "b", "c"],
      ["x, y", 'he said "hi"', ""],
      ["1", "multi\nline", "3"],
    ]);
  });
  it("rejects unterminated quotes and too many rows", () => {
    expect(() => parseCsv('a\n"open')).toThrow(/unterminated/);
    expect(() => parseCsv("h\n1\n2\n3", 2)).toThrow(/more than/);
  });
});

describe("log redaction", () => {
  it("removes credentials and masks personal data", () => {
    const s = redactString("smtp://user:pw@mail.example mongodb+srv://u:p@cluster +14165550123 4111 1111 1111 1111 jane.doe@example.com 2026-10-15");
    expect(s).not.toMatch(/user:pw|u:p@|4165550123|4111 1111|jane\.doe/);
    expect(s).toContain("2026-10-15");
    expect(redact({ password: "x", token: "y", nested: { authorization: "Bearer z", ok: 1 }, signature: "sig" })).toEqual({ password: "[redacted]", token: "[redacted]", nested: { authorization: "[redacted]", ok: 1 }, signature: "[redacted]" });
  });
});

describe("upload content checks", () => {
  it("identifies real file signatures, not extensions", () => {
    expect(sniffType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe("image/png");
    expect(sniffType(Buffer.from("RIFF\0\0\0\0WEBPVP8 "))).toBe("image/webp");
    expect(sniffType(Buffer.from("%PDF-1.7"))).toBe("application/pdf");
    expect(sniffType(Buffer.from("<svg xmlns="))).toBeNull();
    expect(sniffType(Buffer.from("MZ\x90\0"))).toBeNull();
  });
  it("produces safe display names", () => {
    expect(safeFileName("../../etc/passwd", "pdf")).toBe("passwd.pdf");
    expect(safeFileName('C:\\Users\\x\\"evil".exe', "jpg")).toBe("evil.jpg");
    expect(safeFileName("Front porch (2).HEIC", "jpg")).toBe("Front porch (2).jpg");
    expect(safeFileName("", "png")).toBe("file.png");
  });
});
