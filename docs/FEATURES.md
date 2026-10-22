---
title: "ספרחוב · Seferehov — features, hardware and capacity"
date: "Updated 2026-10-21"
---

# What it is

Seferehov (ספרחוב, Hebrew for "street books") is a web app, installable on any phone, where books pass from hand to hand. It has three parts:

- a shared map of free street libraries (book boxes, little free libraries, shelves in lobbies and parks) and the books on their shelves now;
- readers' own home libraries, catalogued from photos;
- books readers offer from home, for sale or to give away.

It runs at https://seferehov.com. Hebrew is the default (right to left); English is one tap away. All the AI runs locally on one home server, so there is no per-use AI cost and no photos are sent to an AI company.

# Features

## Map and street libraries

- **Map** of about 48,000 street libraries worldwide, seeded from OpenStreetMap (`amenity=public_bookcase`). About 70 of them are in Israel. When zoomed out, libraries are grouped into number bubbles.
- **Library page**: photo, hint for finding it, the books seen there lately, books taken or gone in the last 90 days, and spines read from photos that no catalogue knew yet (so the next visitor can photograph their covers).
- **Add a library**: GPS position, a photo and a hint. A double tap does not create two libraries.
- **Suggest changes**: new name, hint, photo, position, or "it's gone". New libraries and changes wait for a reviewer, and admins get an e-mail digest.
- **Duplicate libraries** within 20 m are listed for merging; old links redirect to the kept one.
- **Printable sign** (A5 with a QR code) for each library.
- **Private-info check**: names, hints and notes are checked for door codes, phone numbers and e-mails (patterns plus the local AI model) before they are published.
- **Town pages and country pages** for search engines, with the libraries and books in each town (towns come from GeoNames and OpenStreetMap boundaries).

## Adding books — four ways

1. **Automatic shelf photos** (main way): the reader moves the phone slowly along the shelves and stops for a moment at each group of books. The phone keeps the sharpest, stillest frame of each pause at full camera resolution and skips frames taken while moving or of the same place. It sends 8 photos at a time. Works at a library or at home.
2. **Photos from the camera app**: up to 8 photos at a time.
3. **Front and back covers**, book after book. The live camera takes each picture by itself when the book is held steady (it accepts more shake the longer it waits, so a photo comes within 1–2 seconds), shows the book turning over between sides, and looks for the barcode the whole time. If none was seen, it asks for a 4-second close-up of the barcode.
   - **Many books at once**: the books lie in a row; all the front covers are taken one after another, then every book is turned over in place and the backs are taken in the same order (the matching front is shown in the corner while each back is taken). A photo is taken only when the camera pauses (about half a second) on a book: four straight edges closing a box with print inside, about the size of the books before. So aiming at the first book, moving between books or pointing away after the last takes nothing, and a hint says when no book is seen. A wrong photo can be removed from the strip. At the end each book is shown with both covers; neighbouring backs can be swapped, all reversed, or a book removed, before saving. Stopping with photos not yet saved asks whether to save them, go on, or delete them. A short animated comic explains it first. (Measured on 42 book photos and 30 photos of rooms, floors and tables: 33 books detected; 8 of the 30 others also pass, mostly busy rooms, which the pause and size checks then filter.)
   - "Held steady" is judged from the camera picture itself (movement between frames and sharpness), not the phone's motion sensors: the book moves in the hand too, which the sensors cannot see.
4. **Barcode scanning** (library page): the camera keeps scanning, each ISBN goes to the queue.

Photos and scans taken without signal are saved on the phone and sent later.

## Reading the photos (on the server)

- **Shelf photos**: the local vision model (Qwen3-VL 8B) finds each spine, straightens the photo by the spines' lean, cuts out each spine, and reads it. A second reader (Surya OCR) reads the same cut-out. A reading is kept when the two agree. Readings of the same spine in different photos are merged by similarity, and the most frequent spelling wins.
- **Covers**: the cover is cut out and straightened, then read. Hebrew text is read by Surya OCR and corrected with the hspell dictionary; Latin text by the vision model. Hebrew the model writes back to front is turned round.
- **Codes**: barcodes, ISBNs printed on the back (check digit verified) and Danacodes (trusted only when the catalogue title matches the front cover).
- **Catalogue lookup**: a local copy of Open Library (38.6 million books, refreshed monthly), then the National Library of Israel, Google Books and Open Library online. Covers and descriptions for book pages come from the National Library of Israel, Simania, Open Library and Amazon.

## The approval queue

- Every book found, from any photo or barcode, waits in one queue per reader (`/queue`), one book at a time with a big picture: approve, later, or wrong. The title and author can be fixed before approving.
- Duplicates from several photos are merged. Decisions can be undone for 14 days.
- A reader who closed the app gets an e-mail when the results are ready.
- While photos are still being read, the queue page says how many and about how long until they are done.

## Reading order (when many readers scan at once)

- Book covers go first: a cover sent while a long shelf batch is being read is read between two of its photos, within a few minutes.
- Readers take turns: everyone's first shelf scan before anyone's second, so one big home library does not hold up everyone else.
- The expected wait comes from the last 30 days of measured reading times.

## My books (home library)

- Books scanned at home stay private. Shelf photos or covers taken from My books become the reader's own books.
- **"I left it in a library"**: one tap reports the book as added to that library.
- Books of friends, or borrowed from friends, can be kept apart from the reader's own.
- With more than 5 books, the list can be filtered by words, genre and language, and sorted by when added, title, author or year.

## Books for sale or to give away

- Any book in My books can be offered: free or for sale (price in ₪), its condition, the town and a note.
- Only the offered book is public, with the town and the reader's screen name. The address, e-mail and the rest of the home library are never shown. Phone numbers and e-mails in the note are refused.
- A buyer writes through the app. The message is e-mailed to the owner, with the buyer's address to reply to (the buyer is told before sending). Limits: 10 messages an hour, 20 a day.
- Offers appear on the public book page (with schema.org `Offer` data, so search engines can show price and condition) and on `/offers`, filtered by town and by free or for sale.

## Finding books

- **Search** by title or author: within 1, 5, 20 or 50 km of the reader or of a town, or anywhere. With no words it lists all books in the area ("Browse all books" lists every book on a shelf).
- **Filters and sorting** on the results: genre, language, period published (before 1950, 1950–79, 1980–99, 2000s, 2010s, 2020 on) and when last scanned (week, month, year). Each choice shows how many of the books found it would leave. Sort by best match, scanned lately, nearest, most copies, newest or oldest, or title. Each book shows its genre, language and year, on how many shelves it is now, how many times readers scanned it, and when it was last seen.
- **Genres** (23, from novel and poetry to Judaism, cooking and reference) are seldom given by catalogues, and never for most Hebrew books, so the local model picks one from the title, authors, publisher and description, in the background when the GPU is idle (about a second a book). A missing language is taken from the script of the title, or from common English words, else guessed by the model. Readers can correct both in "Fix a mistake", and the book page links them to the matching search.
- **Alerts** (watches) for a book, an author or words, near a place or anywhere, by e-mail or push notification.
- **Public book pages** (`/b/<id>`): covers, cover text, ISBN and Danacode, where the book is now, offers, reviews, and links to Open Library, Google Books, WorldCat and Simania.
- **Reader pages** (`/r/<id>`): what a reader read and recommends. Home libraries are not shown.

## Reviews, fixes, points

- **Reviews**: "I read it", stars, and four guided questions. Copied text and contact details are refused; admins can hide a review.
- **Book fixes**: anyone can fix a book's title, author, description and so on. Trusted readers' fixes go live at once; others are voted on. Every change has a history and can be undone.
- **Points and levels** for approved reports, with a daily cap. New readers' reports are reviewed first; after a few good ones they publish directly. Reports made far from the library always go to review.

## App and updates

- Installable from the browser (PWA), works offline, Hebrew and English.
- Updates install in the background and switch in between screens, never during an upload or on the camera, queue or review screens. No version numbers to bump.

## For the admin

- `/admin`: activity, readers, search pages, cover texts waiting for approval, reviews, statistics.
- `/admin/trace`: every AI stage of every scan, step by step: the video and the frames chosen, each cut-out spine, what each model was asked and answered, and why each book was kept or dropped. Test uploads run the full pipeline without saving anything.
- `server/scripts/eval.js`: a fixed test set for measuring reading accuracy (see below).
- Search statistics: which catalogue answered each search and whether the reader kept the match.

## Measured accuracy (2026-10-21)

On 60 synthetic Hebrew back covers with known text, word accuracy was:

| Reader | Clean | Like a phone photo | Hard (tilted, blurred, noisy) |
|---|---|---|---|
| Surya OCR | 98% | 97% | 98% |
| Surya + hspell | 97% | 96% | 97% |
| Vision model | 92% | 76% | 77% |
| Tesseract | 72% | 73% | 28% |

On real photos, the title was found in:

- Hebrew spines: 71% of spines by the vision model alone, 63% by the full pipeline;
- Hebrew covers: 63% by the vision model, 49% by Surya;
- Latin covers: 93–100%.

Real Hebrew covers are harder than synthetic ones, so a word-accuracy figure for them needs a hand-labelled set.

# Hardware

Everything runs on one home server:

| Part | |
|---|---|
| CPU | 48 threads (AMD Threadripper) |
| Memory | 251 GB |
| GPU | NVIDIA GeForce GTX 1080, 8 GB (from 2016) |
| Disks | 1.8 TB NVMe (1.5 TB free) for the app; a separate hard disk for the nightly backup |
| Software | Node 22 + Fastify API, PostgreSQL 16 + PostGIS (Docker), nginx, Ollama (vision model on the GPU), Surya OCR (on the CPU), hspell |

The same server also runs other services. The GPU is shared with other occasional jobs.

# Capacity: how many scans the GPU can handle

The GPU reads one scan at a time; others wait in a queue (covers first, then readers in turn; see *Reading order*). Measured times:

| Scan | Time on the GPU |
|---|---|
| One book's front and back covers | about 1 minute |
| One shelf photo | about 3.5–7 minutes (each spine is cut out and read twice) |
| One batch of 8 automatic shelf photos | about 30–55 minutes |
| A short video (no longer offered) | about 35–50 minutes |

So in 24 hours of non-stop work the GPU can read about **1,400 books by their covers**, or about **200–400 shelf photos**. That is roughly 2,500–5,000 books from shelf photos (at 10–15 books per photo).

A home library of 300 books, photographed shelf by shelf, is about 25 photos, which is 2–3 hours of GPU time. In practice:

- one or two readers scanning at the same time: results within minutes to an hour;
- five readers each scanning a home library at the same time: the last one waits 10 hours or more;
- a reader with one book's covers waits only for the shelf photo being read now (a few minutes), not the whole batch.

The bottleneck is the GPU, not the CPU, memory or disk.

## Ways to grow, in order

1. **Smarter queue (code only, free). Done.** Covers before shelf batches, readers in turn, and an estimated wait shown in the app. This removes the worst waits but not the total: five home libraries at once still take 10+ hours in all.
2. **Faster pipeline (code only).** Each spine is read four times now (two orientations, two readers); reading the likely orientation first and skipping the second read when both agree would cut the time considerably.
3. **A better GPU at home.** A used RTX 3090 (24 GB) costs about $700–900 and is roughly 3 times faster for this kind of model (its memory is about 3 times faster). The power supply has to be checked (the card draws up to 350 W). This keeps the "no per-use cost" property.
4. **A rented GPU for overflow.** The worker takes jobs from the database, and the model address is a setting, so a second worker on a rented GPU server can take jobs only when the queue is long. Approximate on-demand prices (October 2026, check before buying):

| Provider | GPU | Per hour | 24/7 for a month |
|---|---|---|---|
| AWS EC2 g4dn.xlarge | T4, 16 GB (about as fast as the GTX 1080) | $0.53 | $384 |
| AWS EC2 g5.xlarge | A10G, 24 GB | $1.01 | $734 |
| OVHcloud | L4, 24 GB | about $1.00 | about $730 |
| RunPod community cloud | RTX 3090 / 4090 | $0.19–0.39 | $140–280 |

Run only when needed (for example 2 hours a day), a rented GPU costs tens of dollars a month. Running one all the time costs hundreds, more than buying a faster card. A rented server is still a machine the operator controls: photos go to it, not to an AI company, and they are not used to train anyone's model.

# Disk space

Measured per item:

| Kept | Size | How long |
|---|---|---|
| Book cover photos (front + back, re-encoded) | about 0.6 MB per book | permanent |
| Shelf photo for the queue + spine cut-outs | about 0.3 MB per photo + 40 KB per book | permanent |
| Full-size copy of each photo, without location data (for reading again with a better model) | about 1.5 MB per photo | 30 days |
| Trace of each scan (admin view) | 0.3 MB per cover, 1.6 MB per shelf photo, 25 MB per video | 30 days |
| Database: Open Library catalogue | 14 GB | rebuilt monthly from the public dump |
| Database: readers' data | a few MB so far | permanent |

The 30-day files are capped by the GPU: at most about 400 photos a day can be read, so they never exceed about 40 GB. Permanent growth is small. For example, 1,000 home libraries of 300 books photographed by shelf come to about 20 GB, and 100,000 books scanned by their covers to about 60 GB. With 1.5 TB free, disk space is not a concern for years.

# Backups

**Now:** every night at 04:00 the server copies the app files to a second disk in the same machine and dumps the database (the last 7 dumps are kept). Files that were replaced or deleted are kept for 60 days. A failed backup sends an e-mail.

This protects against a failed disk, but not against anything that hits the whole machine or house: theft, fire, a power surge, or a mistake or attack that reaches both disks.

**Recommended:**

- **Dump the readers' data without the Open Library catalogue.** The catalogue can be downloaded again, and without it the nightly dump shrinks from gigabytes to megabytes.
- **A second machine on the home network: a Raspberry Pi with a USB disk works well.** A Pi 4 or 5 with a 1–2 TB USB SSD or hard disk is enough. Use the wired network if possible; Wi-Fi is fine too, because the nightly change is small (megabytes).
  - Let the Pi **pull** the backup over SSH with a read-only key, so a compromised server cannot delete the backups.
  - Keep dated snapshots (for example with borg or restic), not a single mirror.
- **One copy outside the house**, encrypted (borg or restic to a rented server or cloud storage). The important data is under a few GB, so this costs cents to a few dollars a month.
- **Test a restore** once in a while.

# Future plans

**Waiting and speed**

- Faster shelf reading (read the likely orientation first; skip the second reader when the first is sure).
- Overflow worker on a rented GPU when the queue is long; or a faster GPU at home.

**Home libraries and offers**

- Alerts to readers watching a book when someone offers it.
- Offered books in search results.
- A "wanted" list: readers post books they are looking for, matched against offers and (with the owner's consent) home libraries.
- Marking an offered book as sold or given, with a thank-you to the other reader.

**Second-hand bookshops**

- Shop mode: photograph the shelves to get an inventory that can be searched and priced, with no typing.
- Photograph again later: sold books drop off the list.
- Export of the stock to the shop's own website or to classified-ad sites; a page for shops with measured numbers from a pilot.

**Accuracy**

- Harder synthetic test covers (large decorative titles, text over pictures) and a small hand-labelled set, so accuracy on real covers can be measured and published.
- A public "try it" page that shows each AI stage on an uploaded image.

**Operations**

- Off-machine and off-site backups (above).
- Search Console verification and sitemap submission.

# Keeping this document current

This file (`docs/FEATURES.md`) is updated with every feature change. The PDF is built from it with `docs/build-pdf.sh`.
