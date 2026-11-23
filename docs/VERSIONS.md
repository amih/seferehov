# Versions

Major steps of Seferehov, each with a git tag (`v0.N`) on its last commit. The app also shows its build
version (date and commit, e.g. `2026.11.23.063605-c73b48a`) on the Settings page.

Shelf-reading numbers come from the lab's benchmark: the same 9 shelf photos with 58 approved books,
frozen on 23 Nov 2026 as **fixed-9** (lab `bench/fixed-9`). "s per book" = seconds per photo × 9 / books
found. Earlier runs used smaller sets (7 photos / 46 books, 8 / 53) and are marked as such.

| Version | Date | Name | What it brought | Shelf reading (lab benchmark) |
|---|---|---|---|---|
| v0.1 | 14 Oct | Street-library map | Map of free street libraries (OpenStreetMap), Google sign-in, Hebrew-first bilingual app | — |
| v0.2 | 15 Oct | Shelf reading | Shelf photos and videos read by a local vision model, spine by spine; local Open Library catalogue; National Library lookups; seferehov.com; pages for search engines | — |
| v0.3 | 17 Oct | Approval queue and book pages | One approval queue; book pages with covers and blurbs; My books at home; Danacode barcodes; cover photos straightened | — |
| v0.4 | 18 Oct | Covers and readers | Add books by their covers; Surya OCR for Hebrew cover text; reviews and stars; phone notifications; points and levels | — |
| v0.5 | 20 Oct | Both ways up | Every spine read both ways up by the vision model and Surya, kept the way they agree; anyone can fix a book's details | — |
| v0.6 | 21 Oct | Traces | Every AI step of a scan traced, with a viewer; a fixed test set (scripts/eval.js); shelf photos taken by themselves at each pause | — |
| v0.7 | 22 Oct | Many books at once | Priority queue; all fronts then all backs; an image model on the phone that sees when a book is in view; genres | — |
| v0.8 | 29 Oct | Store and forward | Every photo saved on the phone and sent from an outbox, no send button; camera reports | — |
| v0.9 | 4 Nov | One camera | One camera for all book photos, the server sorts shelves and covers and pairs fronts with backs; each spine cut at its own lean | — |
| v0.10 | 5 Nov | Web search and title index | Spines no catalogue knows searched on the web (throttled); local title/author index from Hebrew Wikipedia, Wikidata and publishers' sites; confidence per book, surest first | — |
| v0.11 | 6 Nov | Hebrew names | National Library through its catalogue (SRU); authors and titles in Hebrew from its records | — |
| v0.12 | 8 Nov | Where is it | Each book's outline on its shelf photo; covers corrected like spines; all GPU work through the GPU queue | — |
| v0.13 | 11 Nov | Confidence and tests | "Sure" tier and optional auto-approval; test suite (lint, unit, build, end-to-end) run before every push | 7 photos / 46 books: 36 found, 521 s per photo, 101 s per book (13 Nov) |
| v0.14 | 16 Nov | Outlines and shelf pages | Hand-drawn outlines for admins; shelf photo pages; "Approve, turned" and "Bad cut-out" in the queue; public home books and invites | 8 photos / 53 books: 42 found, 722 s per photo, 138 s per book (14 Nov, busy server) |
| v0.15 | 18 Nov | Spine cutter | The lab's YOLO model cuts every spine along its own lean, instead of the vision model finding the spines | 9 / 58: 46 → **49 found**, 486 → **337 s per photo**, 95 → **62 s per book** |
| v0.16 | 21 Nov | PaddleOCR first | Hebrew PaddleOCR checks each cut-out first, Surya only when it does not confirm; corrections only when close to what was read; one camera from the map | 9 / 58: **52 found**, 373 s per photo, 65 s per book |
| v0.17 | 23 Nov | Clean cuts | Spine-cutter cut-outs kept as cut (no diagonal or clipped cuts); different books never merged; Hebrew spines kept in Hebrew letters; back button one screen at a time; National Library credit | 9 / 58: **52 found, 354 s per photo, 61 s per book**, 9.3 Qwen calls per book |

From the first comparable version (v0.14, Qwen finds the spines) to v0.17: 6 more of the 58 books found,
27% less time per photo, 36% less time per book found, 16% fewer vision-model calls per book.
Details: lab report 067 (lab.amiheines.com/experiments/067-history).
