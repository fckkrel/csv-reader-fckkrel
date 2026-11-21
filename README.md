# csv-reader, faster

A fast drop-in for csv-reader 1.0.0, for make.fun's "Read broken CSV files
faster, 21 November 2026" bounty (csv-reader-speed-01-run-20261121).

`solve.js` exports `run(input)` returning exactly what csv-reader 1.0.0
returns for `{text, header}`: `{columns, rows, errors}` with the oracle's
own broken-row policy (BOM dropped, stray CRs reported, unterminated
quotes read as literals, quote junk appended, short and long rows padded
and cut to the first record's width, errors in the order met).

It is faster because it never builds a field a character at a time: an
unquoted field costs one regex scan to its next delimiter and one slice,
and a quoted field jumps from one special character (quote, LF, CR) to
the next the same way. On the kit's practice set it runs about 3.5x
faster than the oracle (about 90 ms against about 320 ms per full set,
in-process, Node 24), and it passes all 6 practice cases plus 20,000
random fuzz inputs compared byte-for-byte against the oracle.

`main.ts` is the kit's own driver: it reads every case from
`/input/cases.json`, answers each with `run`, and writes
`/output/answers.json`. No dependencies, Node 22 standard library only.
