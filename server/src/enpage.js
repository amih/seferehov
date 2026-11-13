// /en: an English page on how Seferehov works under the hood, for developers and teams
// thinking about running AI on their own hardware. A plain page outside the app
// (the service worker leaves /en alone), linked from the YouTube videos and amiheines.com.
import { config } from './config.js';

const TITLE = 'Seferehov: reading bookshelves with AI on one 8 GB graphics card';
const DESC = 'How Seferehov reads Hebrew and English book spines from phone photos with local AI models on a 2016 GTX 1080: the pipeline, the measured accuracy, and how it was built with Claude Code.';
const IMG = '/en/strips-tiles.v1.jpg';

const page = () => `<!DOCTYPE html>
<html lang="en" dir="ltr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${TITLE}</title>
<meta name="description" content="${DESC}">
<link rel="canonical" href="${config.baseUrl}/en">
<meta property="og:type" content="article">
<meta property="og:title" content="${TITLE}">
<meta property="og:description" content="${DESC}">
<meta property="og:url" content="${config.baseUrl}/en">
<meta property="og:image" content="${config.baseUrl}${IMG}">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="/favicon-v2.ico">
<style>
body{font:17px/1.65 system-ui,-apple-system,sans-serif;max-width:44rem;margin:0 auto;padding:1.5rem 1.1rem 4rem;color:#1d2420;background:#fbfcfa}
h1{font-size:1.9rem;line-height:1.2;margin:1.2rem 0 .6rem}h2{font-size:1.3rem;margin:2.4rem 0 .6rem}
a{color:#1f6b3a}.lead{font-size:1.1rem}.small{font-size:.9rem;color:#555}
img{max-width:100%;height:auto;border-radius:6px;border:1px solid #dde3dd}figure{margin:1.4rem 0}img.tall{max-height:560px;width:auto;display:block}figcaption{font-size:.9rem;color:#555;margin-top:.3rem}
table{border-collapse:collapse;width:100%;font-size:.95rem}th,td{border-bottom:1px solid #dde3dd;padding:.4rem .5rem;text-align:left}th{background:#eef3ee}
ol li,ul li{margin:.35rem 0}.cta{display:flex;flex-wrap:wrap;gap:.7rem;margin:1.2rem 0}
.btn{display:inline-block;padding:.6rem 1.1rem;border:1.5px solid #1f6b3a;border-radius:6px;text-decoration:none;font-weight:600}
.btn.main{background:#1f6b3a;color:#fff}header{display:flex;align-items:center;gap:.6rem;font-weight:700}
header img{width:36px;height:36px;border:0;border-radius:50%}
</style>
<script type="application/ld+json">${JSON.stringify({
  '@context': 'https://schema.org', '@type': 'TechArticle', headline: TITLE, description: DESC, inLanguage: 'en',
  url: `${config.baseUrl}/en`, image: config.baseUrl + IMG,
  author: { '@type': 'Person', name: 'Ami Heines', url: 'https://amiheines.com/' },
}).replace(/</g, '\\u003c')}</script>
</head><body>
<header><img src="/icons/icon-v2-192.png" alt=""> Seferehov</header>

<h1>Reading bookshelves with AI, on one 8 GB graphics card</h1>
<p class="lead">Seferehov is a free map of street libraries: the public book cabinets on streets, in parks and in building lobbies.
Anyone can photograph a shelf, and the app works out which books are on it. Then anyone can search for a book by title and distance.</p>
<p>All the AI runs on one GTX 1080 from 2016, in a server in my home. There is no per-request bill, and no photo is sent to a cloud model.
This page is about how that works. It is written for developers, and for teams wondering whether they could run their own AI the same way.</p>
<div class="cta"><a class="btn main" href="/?lang=en">Open the app (English)</a><a class="btn" href="/comic?lang=en">The comic: how it works in 9 panels</a></div>

<figure><img class="tall" src="${IMG}" width="676" height="1200" alt="A street library shelf read in strips, with each book the app found outlined in green">
<figcaption>From a night experiment: one shelf read in strips, 16 of its 17 books found (green; red = missed).</figcaption></figure>

<h2>The hardware</h2>
<ul>
<li><b>GPU:</b> one NVIDIA GTX 1080 with 8 GB, from 2016. Models of about 8 billion parameters fit entirely on it.</li>
<li><b>Server:</b> an AMD Threadripper 3960X (24 cores) with 251 GB of RAM. Text recognition runs on the CPU, so the GPU is left for the vision model.</li>
<li><b>One queue for the GPU:</b> several of my apps share the card, so every GPU job goes through one priority queue. A reader waiting for a shelf comes before a background job.</li>
</ul>

<h2>From a shelf photo to a list of books</h2>
<ol>
<li><b>On the phone:</b> a 4 MB image model, trained for this app, decides whether a book is in view. The camera takes the photo only when the phone is steady enough, and uploads work offline and are sent later.</li>
<li><b>Finding the spines:</b> a vision model (Qwen3-VL 8B, through Ollama) draws a box around every spine. Leaning books are measured, and the photo is turned so each group stands upright.</li>
<li><b>Cutting each spine out:</b> each spine is cut at its own angle, along its real edges, so the next step reads one book at a time.</li>
<li><b>Reading it twice:</b> the vision model and a separate OCR model (Surya) read each cut-out, both ways up, because Hebrew spines are printed in either direction. A reading is kept where the two agree.</li>
<li><b>Fixing Hebrew:</b> most Hebrew mistakes are look-alike letters. A Hebrew spell-checker (hspell) fixes many of them.</li>
<li><b>Matching a catalogue:</b> the text is matched against a local copy of Open Library (38.6 million books) and the National Library of Israel, so the reader gets a real book, not a guess.</li>
<li><b>A person decides:</b> every book gets a confidence score, and the reader approves it in a queue, one book at a time. Every step is saved in a trace, so when a book is missed I can see exactly which step lost it.</li>
</ol>

<figure><img src="/en/spines-upright.v1.jpg" width="1200" height="258" alt="Three Hebrew book spines cut out and turned the right way up">
<figcaption>Three spines after cutting and turning the right way up.</figcaption></figure>

<h2>Measured, not guessed</h2>
<p>Word accuracy on 60 Hebrew back covers with known text:</p>
<table>
<tr><th>Reader</th><th>Clean</th><th>Like a phone photo</th><th>Tilted, blurred, noisy</th></tr>
<tr><td>Surya OCR</td><td>98%</td><td>97%</td><td>98%</td></tr>
<tr><td>Vision model (Qwen3-VL 8B)</td><td>92%</td><td>76%</td><td>77%</td></tr>
<tr><td>Tesseract</td><td>72%</td><td>73%</td><td>28%</td></tr>
</table>
<p>On real photos, the title was found on 71% of Hebrew spines by the vision model alone, and on 93–100% of English covers.
When the app marks a book as "sure", readers approved it 96% of the time.</p>
<p>The choice of models came from these tests. Some models that look good in demos made up titles that are not on the shelf, so they were dropped.</p>

<h2>Built with Claude Code</h2>
<p>I built Seferehov with Claude Code, and changes to the reading pipeline are measured on a fixed test set of real photos.
Claude Code also has a night shift: while I sleep it runs experiments on the server as a user that can read the data but not change anything.
The first night's experiment found 59 of 68 books on the test shelves, against 47 with the method that is live. It is not live yet, because it doubles the GPU time per photo.</p>
<p>The weekly write-ups, with the numbers and the dead ends, are on <a href="https://amiheines.com/blog/">amiheines.com</a>:</p>
<ul>
<li><a href="https://amiheines.com/blog/seferehov-local-ai-8gb-gpu-claude-code/">Local AI on an 8 GB GPU, built with Claude Code</a></li>
<li><a href="https://amiheines.com/blog/seferehov-ten-days-later-measured/">Ten days later, measured</a></li>
<li><a href="https://amiheines.com/blog/seferehov-night-shift-shaky-hands/">A night shift for Claude Code, and a camera for shaky hands</a></li>
</ul>

<h2>Want the same for your product?</h2>
<p>I'm Ami Heines. I help software teams run AI on their own GPU, or on a rented one, with no per-request bill.
If you have an AI feature in mind, I can tell you in 30 minutes whether a local model can do it and roughly which card it needs.</p>
<div class="cta"><a class="btn main" href="https://amiheines.com/pilot/">The Local AI Pilot</a><a class="btn" href="https://amiheines.com/">amiheines.com</a></div>
<p class="small">Seferehov is free and has no ads. Contact: <a href="mailto:ami@seferehov.com">ami@seferehov.com</a> · <a href="/">ספרחוב בעברית</a></p>
</body></html>`;

export default async function enPage(app) {
  const send = async (req, reply) => reply.header('Cache-Control', 'no-cache').type('text/html; charset=utf-8').send(page());
  app.get('/en', send);
  app.get('/en/', async (req, reply) => reply.redirect('/en', 301));
}
