/**
 * Minimal RFC 4180 CSV parser (quoted fields, escaped quotes, CRLF/LF, BOM).
 * Bounded: throws when the input exceeds `maxRows` or a field is unterminated.
 */
export function parseCsv(input: string, maxRows = 5001, maxFieldLength = 5000): string[][] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = 0;
  const pushField = () => {
    if (field.length > maxFieldLength) throw new Error(`A value in row ${rows.length + 1} is too long.`);
    row.push(field);
    field = "";
  };
  const pushRow = () => {
    pushField();
    if (!(row.length === 1 && row[0] === "")) rows.push(row);
    if (rows.length > maxRows) throw new Error(`The file has more than ${maxRows - 1} data rows.`);
    row = [];
  };
  while (i < text.length) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"' && field === "") {
      quoted = true;
      i++;
    } else if (c === ",") {
      pushField();
      i++;
    } else if (c === "\n" || c === "\r") {
      pushRow();
      i += c === "\r" && text[i + 1] === "\n" ? 2 : 1;
    } else {
      field += c;
      i++;
    }
  }
  if (quoted) throw new Error("The file has an unterminated quoted value.");
  if (field !== "" || row.length) pushRow();
  return rows;
}
