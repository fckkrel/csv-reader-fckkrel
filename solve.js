// A fast drop-in for csv-reader 1.0.0 (make.fun's own reference program).
//
// The oracle reads one character at a time and builds every field a
// character at a time, which is correct and slow. This module returns the
// same answer for every input, but reads a field as slices between the
// characters that can end it: for an unquoted field the next comma, LF or
// CR; for a quoted field the next quote, LF or CR. String.prototype.indexOf
// is the fast path in V8, and a field is usually one slice, so a record of
// many short fields costs a few native scans instead of a loop per byte.
//
// The semantics are csv-reader's own, restated so a reader can check this
// file against the oracle without running it:
//
//   - a U+FEFF at the very start of the text is dropped;
//   - a record ends at LF or CRLF, and a line left with no characters is
//     no record;
//   - outside a quoted field a CR not followed by LF is dropped, with a
//     stray_cr error;
//   - a field that opens with a quote runs to the next quote that is not
//     doubled, "" inside it is one quote, and each CRLF or lone CR inside
//     it is read as LF; what follows its closing quote, up to the next
//     comma or line break, is appended to it as it stands (quote_junk,
//     when the field ends); a quote that never closes is read as a literal
//     character and the text after it is read again as an unquoted field
//     (unterminated_quote);
//   - a quote inside an unquoted field is a literal character; fields stay
//     strings, never trimmed or converted;
//   - columns is the first record when header is true, else null; rows
//     holds the records after it (every record when header is false),
//     each padded with "" (short_row, with fields: its count) or cut
//     (long_row, with extra: the cut fields) to the first record's width;
//   - each error is {code, line, row}, in the order met, a record's
//     short_row or long_row when it ends: line the 1-based line its record
//     starts on, counting every LF, CRLF and lone CR inside quotes, and
//     row its record's index in rows, null for the header.
//
// Pure: no clock, no randomness, no locale, nothing kept from one call to
// the next. The only state is the call's own reading position and line.

const COMMA = 44;
const LF = 10;
const CR = 13;
const QUOTE = 34;

/** csv-reader 1.0.0's answer for one case's input {text, header}. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  const n = text.length;
  let pos = 0;
  let line = 1;
  if (n > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and the index in rows it
  // takes (null: the header). The field readers read these as they stand,
  // so an error always names the record its field belongs to.
  let recordLine = 1;
  let recordRow = null;
  let outValue = '';
  let outEnded = 2;
  let outAdded = 0;

  // Reads an unquoted field from pos, starting from `init` ("" for a fresh
  // field, '"' for a quote that never closed, the quoted value for junk
  // after a closing quote). Sets outValue, outEnded (0 comma, 1 line break,
  // 2 end of text) and outAdded, how many characters were kept after
  // `init` — the count the quote_junk check reads, never the init itself.
  // A CR not followed by LF is dropped with a stray_cr error and the field
  // goes on; a quote here is a literal character, like every other byte.
  // One regex exec finds the next delimiter, so a field costs one native
  // scan and one slice instead of a loop per byte.
  const DELIM = /[,\r\n]/g;
  const SPECIAL = /["\r\n]/g;
  function readUnquoted(init) {
    let value = init;
    let added = 0;
    let seg = pos;
    while (pos < n) {
      DELIM.lastIndex = pos;
      const m = DELIM.exec(text);
      if (m === null) {
        if (n > seg) {
          const s = text.slice(seg, n);
          value = value === '' ? s : value + s;
          added += n - seg;
        }
        pos = n;
        outValue = value;
        outEnded = 2;
        outAdded = added;
        return;
      }
      const at = m.index;
      const c = m[0];
      if (c === ',') {
        if (at > seg) {
          const s = text.slice(seg, at);
          value = value === '' ? s : value + s;
          added += at - seg;
        }
        pos = at + 1;
        outValue = value;
        outEnded = 0;
        outAdded = added;
        return;
      }
      if (c === '\n') {
        if (at > seg) {
          const s = text.slice(seg, at);
          value = value === '' ? s : value + s;
          added += at - seg;
        }
        pos = at + 1;
        line += 1;
        outValue = value;
        outEnded = 1;
        outAdded = added;
        return;
      }
      if (at + 1 < n && text.charCodeAt(at + 1) === LF) {
        if (at > seg) {
          const s = text.slice(seg, at);
          value = value === '' ? s : value + s;
          added += at - seg;
        }
        pos = at + 2;
        line += 1;
        outValue = value;
        outEnded = 1;
        outAdded = added;
        return;
      }
      if (at > seg) {
        const s = text.slice(seg, at);
        value = value === '' ? s : value + s;
        added += at - seg;
      }
      errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
      pos = at + 1;
      seg = pos;
    }
    if (n > seg) {
      const s = text.slice(seg, n);
      value = value === '' ? s : value + s;
      added += n - seg;
    }
    pos = n;
    outValue = value;
    outEnded = 2;
    outAdded = added;
  }

  // Reads a quoted field whose opening quote is at pos. The scan jumps
  // from one special character to the next — a quote, a LF or a CR — and
  // slices the plain text between them, so a long quoted field costs a
  // few slices, not a loop per byte. A doubled quote is one quote in the
  // value; a CRLF or a lone CR inside the quotes is one LF, and the line
  // counts once for it.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    let value = '';
    let seg = pos + 1;
    pos += 1;
    let closed = false;
    while (pos < n) {
      SPECIAL.lastIndex = pos;
      const m = SPECIAL.exec(text);
      if (m === null) break;
      const next = m.index;
      const kind = m[0] === '"' ? 0 : m[0] === '\n' ? 1 : 2;
      if (kind === 0) {
        if (next > seg) value += text.slice(seg, next);
        if (next + 1 < n && text.charCodeAt(next + 1) === QUOTE) {
          value += '"';
          pos = next + 2;
          seg = pos;
          continue;
        }
        pos = next + 1;
        closed = true;
        break;
      }
      if (next > seg) value += text.slice(seg, next);
      value += '\n';
      line += 1;
      if (kind === 1) {
        pos = next + 1;
      } else {
        pos = next + 1 < n && text.charCodeAt(next + 1) === LF ? next + 2 : next + 1;
      }
      seg = pos;
    }
    if (!closed) {
      // The quote never closes: it is a literal character, and the text
      // after it is read again as unquoted, from the line the field
      // opened on, so the lines inside it are counted once, by the
      // unquoted read, not twice.
      pos = open + 1;
      line = openLine;
      errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
      readUnquoted('"');
      return;
    }
    if (pos >= n) {
      outValue = value;
      outEnded = 2;
      outAdded = 0;
      return;
    }
    const c = text.charCodeAt(pos);
    if (c === COMMA) {
      pos += 1;
      outValue = value;
      outEnded = 0;
      outAdded = 0;
      return;
    }
    if (c === LF) {
      pos += 1;
      line += 1;
      outValue = value;
      outEnded = 1;
      outAdded = 0;
      return;
    }
    if (c === CR && pos + 1 < n && text.charCodeAt(pos + 1) === LF) {
      pos += 2;
      line += 1;
      outValue = value;
      outEnded = 1;
      outAdded = 0;
      return;
    }
    // What follows the closing quote is appended as it stands, up to the
    // next comma or line break. Its stray CRs are reported as they are
    // met, inside the read, and the quote_junk error only after it.
    readUnquoted(value);
    if (outAdded > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
    return;
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === LF) {
        pos += 1;
        line += 1;
      } else if (c === CR && pos + 1 < n && text.charCodeAt(pos + 1) === LF) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let quoted;
    do {
      quoted = pos < n && text.charCodeAt(pos) === QUOTE;
      if (quoted) readQuoted();
      else readUnquoted('');
      fields.push(outValue);
    } while (outEnded === 0);

    // A line that held only stray CRs is left with no characters: no
    // record (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? columns ?? [] : null, rows, errors };
}
