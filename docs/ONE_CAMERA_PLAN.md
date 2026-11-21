# One camera from the map: plan (21 Nov 2026, for Ami's approval)

## Goal
The map stays the main page. One big camera button on the map opens the camera at once: no
question first ("a new library? this library's shelves? my books?"). The reader just photographs.
The app makes its best guess of the situation, sends the photos, and asks at most one or two short
questions later, in the approval step, each with the app's confidence, like the books.

## What the reader sees

**1. Map.** A round 📸 button at the bottom (thumb reach). The current ways in stay as they are (a
library's page → "Add books", My books → "Add", ➕ Add a library); they are just no longer needed.

**2. Camera.** Opens immediately (the same free-style camera, `capture.js`). A small line at the top
shows the guess as it forms, and can be tapped to change it, but never has to be:
- "📍 Near: Library on Herzl St. (40 m)", or
- "🏠 At home", or
- "📍 A library we don't know yet?"

**3. End of session** (Done, or the camera closes), after the last photo is sent:
> ✅ 18 photos sent. The server will read them now; this takes a few minutes per photo. We will
> email you, and show 🔔 here, when the books are ready for you to check.

If photos are still waiting to go (no signal), the line says so, as the outbox does today.

**4. Approval (the queue).** Above the books of a session, one card with the situation:

> 🏠 **Your books at home**  🟢 92%: on Wi-Fi, weak GPS, 600 m from the nearest library, evening
> [✓ Right]  [✗ No, it's…]

"✗ No, it's…" offers the other answers, each one tap:
- 📍 the public library on Herzl St. (and the 2 others nearest);
- ➕ a new public library here (point on the map, already placed where the photos were taken;
  name optional);
- 👥 a friend's books (name);
- 🏠 my books.

When the guess is sure (🟢, see "Confidence" below) the card shows without asking: one tap on the
card's ✗ changes it. When it is unsure (🟡/🔴) the card asks the question before the books. The
books themselves are approved as today (confidence per book, one by one or many at once).

A new public library is created only after this answer, and goes through the usual moderation.

## How the guess is made

Two steps: the phone collects hints while the camera is open and sends them with the photos;
the server decides, adding what it sees in the photos. The final word is the server's, because
the server sees the photos (the vision model can tell a street book box from a bookcase in a
room) and knows every library and the reader's history.

### Hints from the phone (no new permission prompts)

| Hint | How | What it says |
|---|---|---|
| Nearest known library | GPS position vs the map's libraries (the phone has them) | under ~40 m and outdoors: probably that library |
| GPS accuracy | `coords.accuracy` | indoors usually 20–100 m+, outdoors 3–10 m |
| Wi-Fi vs mobile data | `navigator.connection.type` (Android Chrome; missing on iPhone) | Wi-Fi: probably at home (or a café) |
| Near the reader's home | the GPS of past sessions the reader confirmed as "home", **kept on the phone only**; only "near home: yes/no" is sent | the strongest hint after a few sessions |
| Light | the camera's brightness and colour temperature (`track.getSettings()`: exposure time, ISO, colour temperature, where the phone gives them; else the picture's brightness and colour) | daylight outdoors is 10–100× brighter and bluer than a room |
| Time and day | the phone's clock | evenings/Shabbat: more often home |
| What is in the picture | the book model already on the phone (`bookai.js`) says "a cover fills the picture" | covers in the hand: probably home or a new book, not a whole library |
| Movement | walked > 100 m in the minutes before (GPS track while the app was open) | arriving on foot at a box in the street |

**Not used: sound.** The microphone needs a permission prompt, readers would rightly ask why a book
app listens, and the hints above are enough. **Ambient light sensor**: the browser API for it is
off by default in Chrome, so the camera's own exposure is used instead.

### The server's decision
A short rule-based score at first (each hint adds or removes points, written down in
`server/src/situation.js`), plus one vision-model question on the session's first photo: "Is this a
street book box or library cabinet, a bookcase in a home, books held in a hand, or other?" The
result: `{ kind: home | library | new_library | friend, location_id, confidence, why }`, stored on
the scan (`scans.guess`, jsonb). The books are read exactly as today; only where they go waits for
the reader's answer (or the sure guess).

### Confidence, like the books
- 🟢 75+: shown, not asked. 🟡 45–74: asked. 🔴 under 45: asked, with no answer preselected.
- The numbers start as the rule's points. **Every answer the reader gives is a label**: after a
  few weeks the rule's weights are refitted on the answers, and the confidence shown is measured
  ("of the guesses shown as 90%, 9 in 10 were right"), as was done for the books' confidence.

### A small model on the phone (later, phase 3)
Today the app has 6 photos of libraries and 16 home sessions: too few to train an image model that
tells a street library from a home bookcase. The plan collects them: every confirmed session gives
its first photo a label. When there are a few hundred, the lab trains a small layer on the phone's
existing MobileNet numbers (like `bookhead.json`, 4 MB model already on the phone, a few ms) to give
the live guess in the camera. Training photos: library scans and Ami's own only (lab rule), unless
readers are asked.

## Changes, by part

**Phone (web/src)**
- `views/map.js`: the 📸 button; opens the capture panel on the map page.
- `capture.js`: request without a library code; hints collected (`hints.js`, new, unit-tested
  like `steady.js`); the live guess line; the end-of-session message.
- My books, the library page, ➕ Add a library: unchanged (they pass a sure situation).
- `views/queue.js`: the situation card per session, with the question when unsure.
- i18n: Hebrew and English texts.

**Server**
- `scans.js`: accept uploads with no location; store hints and `guess`.
- `situation.js` (new): the score; the vision question on the first photo; unit tests from real
  sessions (the 56 library and 16 home sessions so far: the rule must get them right).
- Approvals: books of an unconfirmed session wait for the situation answer (sure guesses apply at
  once); a "new library" answer creates the location (pending moderation) and moves the session there.
- Emails and 🔔: the existing "ready to check" email links to the session's card.
- Migration: `scans.guess jsonb`, `scans.hints jsonb`; `scans.location_id` is already nullable.

**Docs**: FEATURES.md + PDF, as always.

## Phases and time
1. **Collect hints only** (half a day): the camera sends the hints with every session, nothing else
   changes. Two weeks of real sessions give the data to check the rule.
2. **One camera + situation card** (2–3 days): the button, the guess, the card and the questions,
   the end message. Rule weights from phase 1's data where there is some, else by hand.
3. **Phone image model** (a lab night, later): when there are a few hundred confirmed sessions.

## Ami's decisions (21 Nov 2026)
1. Both phases at once, with hand-set weights.
2. A sure guess (🟢) is applied without asking, with one tap to change it.
3. ➕ Add a library leaves the menu (and the map) once the map button works. Built the same day.

## Questions for Ami (answered above)
1. Start with phase 1 now (hints only, invisible), and phase 2 after a week or two of data? Or both
   at once, with hand-set weights?
2. A sure guess (🟢): apply without asking (one tap to change), as written? Or always ask once per
   session?
3. Keep the three old ways in (library page, My books, ➕ Add a library), or remove them from the
   menu once the map button works?
