// How sure the server is of a book from a shelf scan, 0–100, and the main reason; the
// approval queue shows the surest first. From the evidence gathered for it:
//   barcode + catalogue 95 · sure 92 (see below) · catalogue, reading confirmed by OCR 90 ·
//   catalogue 85 · corrected (index / web / other frame) then found in a catalogue 75 ·
//   catalogue record by nobody / not by the author on the spine 70–50 · known to the local
//   index only 65 · corrected by the web only 55 · catalogue match from the whole shelf
//   photo only 45 · OCR-confirmed reading 40 · the same, but the web search found nothing 30 ·
//   the vision model alone 25 · low-quality reading 15
//
// Calibrated on 218 approval decisions (6–10 Nov 2026, docs/CONFIDENCE_REVIEW.md):
// - The record must be by the author read off the spine. Where it agreed, 92% were approved;
//   where the record named no author 38%, another author 40%, no author was read 43%.
// - An index correction that also replaced the author by a name unlike the one read
//   (author likeness under 0.75) was approved 54% of the time ("אל, אדם, עולם / אלישבע זלצר"
//   became "על אדם עם אדם / אלי אילון").
// - "Sure" (92): OCR-confirmed, the spine's own author agrees with the record, the title
//   read is the record's main title, and the book was seen in two photos or more. 96% of
//   these were approved, and the declined ones were the right book.
import { authorsAgree, titleSimilarity } from './vision.js';

const mainTitle = (s) => String(s ?? '').split(/\s*[:;/]\s*|\s+\.\.\./)[0];

// The author read off the spine itself, before any correction replaced it.
function spineAuthor(item, ev) {
  const read = ev.find((e) => e.stage === 'read');
  return read ? read.detail?.author ?? null : item.author ?? null;
}

// An index correction whose chosen entry's author is unlike the one read.
function weakIndexFix(ev) {
  return ev.some((e) => {
    if (e.stage !== 'correct' || !String(e.source).startsWith('index') || e.outcome !== 'corrected') return false;
    const pick = (e.detail?.candidates ?? []).find((c) => c.ok);
    return pick?.as != null && pick.as < 0.75;
  });
}

// cropShape (scans.js): long side / short side of the spine's cut-out. A spine standing in
// a row is cut 5–16 times as long as it is high; under 4, 4 of 8 were declined, and "sure"
// went from 47 of 49 to 46 of 46 (Nov 2026).
const WIDE_CROP = 4;
const wideCrop = (item) => item.cropShape?.ratio != null && item.cropShape.ratio < WIDE_CROP;

const frameCount =(item, ev) => item.frames?.size
  ?? ev.find((e) => e.stage === 'read')?.detail?.frames?.length ?? 1;

export function confidenceOf(item, book) {
  const ev = item.evidence ?? [];
  const corrected = ev.some((e) => e.stage === 'correct' && e.outcome === 'corrected');
  const known = (prefix) => ev.some((e) => e.stage === 'correct' && e.source.startsWith(prefix) && ['corrected', 'confirmed'].includes(e.outcome));
  if (book && item.via === 'barcode') return [95, 'barcode'];
  // Read only from the whole shelf, no cut-out of its own spine: the reading cannot be seen to
  // match, and such matches went wrong ("The Millionaire Next Door", "3rd Degree", Nov 2026).
  if (book && item.via === 'vision' && !item.crop) return [45, 'catalogue_whole'];
  if (book) {
    const authors = (book.authors ?? []).filter(Boolean);
    const final = item.author ?? null;
    if (!authors.length) return [60, 'catalogue_no_author'];
    if (final && !authorsAgree(authors, [final])) return [50, 'catalogue_other_author'];
    if (corrected) return weakIndexFix(ev) ? [60, 'corrected_weak_author'] : [75, 'corrected_catalogue'];
    const spine = spineAuthor(item, ev);
    if (!spine) return [70, 'catalogue_no_author_read'];
    if (!authorsAgree(authors, [spine])) return [70, 'catalogue_author_unsure'];
    // A short, wide cut-out is a stack of books lying flat, or two spines in one: the book
    // is usually right but the picture is not, and readers declined it (Nov 2026).
    if (wideCrop(item)) return [70, 'crop_wide'];
    if (item.verified && frameCount(item, ev) >= 2 && titleSimilarity(item.title ?? '', mainTitle(book.title)) >= 0.9) return [92, 'sure'];
    return item.verified ? [90, 'catalogue_ocr'] : [85, 'catalogue'];
  }
  if (known('index:')) return [65, 'index'];
  if (known('web')) return [55, 'web'];
  if (item.quality === 'low') return [15, 'low'];
  // The web was searched for it and knew nothing: 8–26% approved, against 61% for readings
  // still waiting for their web search (Nov 2026).
  if (item.verified && ev.some((e) => e.stage === 'correct' && e.source === 'web' && e.outcome === 'unknown')) return [30, 'ocr_not_found'];
  if (item.verified) return [40, 'ocr'];
  return [25, 'read'];
}
