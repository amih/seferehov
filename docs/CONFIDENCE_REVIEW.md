---
title: 'Seferehov: confidence vs. the reader''s decisions'
date: '10 November 2026'
---

The aim: books the server is sure of should be the ones the reader approves, so that they can be approved without the reader.

**The data:** every shelf-scan book that a reader approved or declined between 6 and 10 November 2026, about 560 decisions. Automatic approvals were left out. The analysis focuses on the 218 books the queue showed with high confidence (75–90). For each declined book, the spine cut-out, the whole photo, the catalogue record and the record's cover picture were compared by eye.

# 1. What went wrong in the high-confidence group

Before the change, 183 of the 218 high-confidence books were approved and 35 declined, an **84% agreement**.

The 35 declined books fall into these groups:

| Group | Books | What happened | Example |
|---|---|---|---|
| Record by another author | 7 | A book with the same or a similar title, by someone else | "אל תלכי לשם" by הדסה בן-עתו matched "אל תלכי: חמישה סיפורים…" by רותי טננולד |
| Record names no author | 9 | Nothing to check the author against; several were another book | "הקיץ של אביה / גילה אלמגור" matched a record titled "גילה אלמגור" |
| Index correction replaced the author | 2 | The title index chose an entry whose author is unlike the one read | "אל, אדם, עולם / אלישבע זלצר" became "על אדם עם אדם / אלי אילון" |
| No author read on the spine | 4 | The match rests on the title alone | "גוונים", "מרקים" |
| Whole-shelf reading only | 3 | No cut-out of the spine, so nothing to check | "The Millionaire Next Door", "3rd Degree" |
| Cut-out shows another book | 1 | The model read one spine, and the cut-out is of the book next to it | "Call It Sleep" (the cut-out shows "סין, סיפור אהבה") |
| **Right book, declined anyway** | 9 | Reading, record, author and cover all match the photo | "משחקי הרעב", "Deep Work", "The Indoctrinated Brain", "אני הורג", "מכתב שנשכח" |

The last group matters most. As far as the photos show, these were the right books. They were not duplicates of books already listed, and the catalogue covers match the copies on the shelf. Nothing the server can see separates them from approved books. Either they were declined for a reason outside the data (not your book, not there any more, a slip), or there is a rule I haven't guessed.

# 2. What separates approved from declined

The strongest signal is **whether the catalogue record is by the author read on the spine**:

| The record's author vs. the spine | Approved | Declined | Agreement |
|---|---|---|---|
| Agrees | 171 | 15 | 92% |
| The record names no author | 6 | 10 | 38% |
| Another author | 4 | 6 | 40% |
| No author was read | 3 | 4 | 43% |

Other signals:

- **Index corrections:** when the index also replaced the author by an unlike name (likeness under 0.75), 7 were approved and 6 declined. With a close name, 13 were approved and 2 declined.
- **Seen in two photos or more:** of the books that pass the author check, 96% were approved when seen in two photos or more, against about 89% when seen in one.
- **No help:** the catalogue source, the script (Hebrew or Latin), whether there was a cover picture, and whether the record's title had a subtitle.

In the low group (40, an OCR-confirmed reading that no catalogue knows), **a web search that found nothing** is the signal. Those were approved 20% of the time (14 of 70), against 61% (19 of 31) for readings still waiting for their web search.

# 3. The new rules

Changed in `server/src/confidence.js`:

| Confidence | When |
|---|---|
| **92 sure** | found in a catalogue, reading confirmed by OCR, the spine's author agrees with the record, the title read is the record's main title, seen in 2+ photos |
| 90 | the same, seen in one photo |
| 75 | corrected, then found in a catalogue by the corrected author |
| 70 | found, but no author was read, or the spine's author is unlike the record's, or the cut-out is short and wide (section 5) |
| 60 | found, but the record names no author; or an index correction replaced the author by an unlike name |
| 50 | found, but the record is by another author |
| 30 | OCR-confirmed reading, and the web search found nothing (was 40) |

The rest is unchanged. The same author checks now apply when the background web queue finds a book later.

# 4. Results on the same decisions

`server/scripts/backtest-confidence.js` re-scores every decided book from its saved evidence:

| Confidence | Approved | Declined | Agreement |
|---|---|---|---|
| 92 sure | 47 | 2 | 96% |
| 90 catalogue + OCR | 51 | 7 | 88% |
| 75 corrected then found | 64 | 1 | 98% |
| 70 author not read / unlike | 4 | 4 | 50% |
| 65 index only | 18 | 2 | 90% |
| 60 no author / weak index fix | 13 | 11 | 54% |
| 55 web only | 14 | 8 | 64% |
| 50 another author | 5 | 7 | 42% |
| 45 whole photo only | 0 | 5 | 0% |
| 40 OCR reading | 19 | 12 | 61% |
| 30 web found nothing | 14 | 56 | 20% |

- **75 and up:** 172 books, 94% agreement (was 218 books, 84%). It keeps 162 of the 183 approvals and drops 25 of the 35 declines.
- **Sure (92):** 49 books, 96% agreement. Both declined "sure" books ("מכתב שנשכח", "אני הורג") are in the "right book, declined anyway" group.
- **Of the 10 declines still at 75 and up,** 9 are in that group. The tenth is the "Call It Sleep" cut-out of the wrong book.

**Caveat:** the rules were found on these same decisions, so the next batches are the real test. Running `backtest-confidence.js` after each batch shows whether "sure" stays near 96%.

# 5. Why the right books were declined

The reader's answers for the 9 "right book, declined anyway" books:

| Book | Reason |
|---|---|
| מה לאכול, הדודה מיכל, מכתב שנשכח, האיש שצפה בנשים, אני הורג | Right book, bad cut-out (four of them lie flat in a stack) |
| משחקי הרעב | Two books in one cut-out; it should have been cut into two |
| Deep Work | Barely in view, half hidden: a thin sliver of a cut-out |
| The Indoctrinated Brain | Right book, cut-out turned upside down |
| אבוא בם אודה-יה | Declined by mistake (it was in one scan only, so not a duplicate) |

So the reader also judges the picture, not only the book. Two changes follow:

- **Short, wide cut-outs** (under 4 times as long as high) are flat stacks or two spines. They now score 70 (`crop_wide`), and never "sure". With this rule, 164 books score 75 or more with **96% agreement**, and **all 46 "sure" books were approved**. Moving the line to 5 or 6 keeps "sure" at 100% but moves more approved books down.
- **The upside-down cut-out** was a bug. Both ways up were read alike, so Tesseract decided. Its garbage from the upright strip ("Semmens (one HW.)…") matched the author "Nehls" 0.4 by chance, and the strip was turned over. Now Tesseract turns a strip only when its text fits the title or author 0.5 or more. In the traces, every right turn fitted 0.55 or more, and the 3 wrong-looking ones 0.22–0.4.

Not caught yet: a cut-out that runs off the end of the spine (מה לאכול) or a thin sliver (Deep Work). Both are still 90.

# 6. Auto-approval

Books scored "sure" can be approved without the reader: set `AUTO_APPROVE_SURE=1` in `.env`. It is **off** for now.

- **What it would have done:** approved 49 of the last 218 high-confidence books, all of them the right book, as far as the photos show.
- **Undoing:** auto-approved books appear in "Recent decisions" and can be undone for 14 days.
- **Statistics:** an undone auto approval is cleared (`auto = false`), so the statistics count the reader's own decision.

# 7. Next steps

1. After the next batch of approvals, run the backtest again. If "sure" stays at 95% or more, turn on auto-approval.
2. Possibly later: also auto-approve "corrected, then found" (75). It was 98% here, but it rests on corrections, so it needs more data first.
3. The wrong cut-out ("Call It Sleep") comes from a book that the whole-photo reading found and the spine search then located. Checking the cut-out's OCR against the record would catch it.
4. Books lying flat are read right but cut badly. Cutting flat stacks one book at a time, and splitting two spines in one cut-out, would let them be approved.
