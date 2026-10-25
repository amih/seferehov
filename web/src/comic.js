// The comic at /comic: why Seferehov exists and how it works, in nine pictures.
// Shared by the app (views/comic.js) and the server's page for search engines (seo.js),
// so it uses no browser APIs. Speech bubbles are HTML, not part of the drawing: the
// text stays sharp, translatable and readable by a screen reader. Bubble positions
// are percentages of the picture, the same in both languages.

const ART = '/comic-art';

// Per panel: picture, bubbles [kind, css position], sound effect position. Text is in TEXT.
const PANELS = [
  { img: 'p1.v1', bubbles: [['think', 'right:3%;top:3%;max-width:36%']] },
  { img: 'p2.v1', bubbles: [['tail-l', 'right:3%;top:3%;max-width:38%']] },
  { img: 'p3.v1', bubbles: [['think', 'left:3%;top:5%;max-width:40%']] },
  { img: 'p4.v1', sfx: 'right:5%;top:6%' },
  { img: 'p5.v1', wide: true, bubbles: [['tail-r', 'left:3%;top:8%;max-width:32%']] },
  { img: 'p6.v1', bubbles: [['tail-r', 'left:3%;top:5%;max-width:40%']] },
  { img: 'p7.v1', sfx: 'right:5%;top:6%' },
  { img: 'p8.v1', bubbles: [['tail-r', 'left:3%;top:4%;max-width:32%']] },
  { img: 'p9.v1', bubbles: [['tail-r', 'left:30%;top:3%;max-width:36%']] },
];

const TEXT = {
  he: {
    title: 'רותי מוצאת אוצר',
    title_html: 'רותי מוצאת <span>אוצר</span>',
    desc: 'קומיקס: למה יש ספרחוב ואיך משתמשים בו. מצלמים מדף ספרים ברחוב, וכל אחד יכול לחפש בו.',
    lead: 'למה בנינו מפה של ארונות ספרים ברחוב, ואיך תמונה אחת של מדף עוזרת לקורא הבא למצוא את הספר שהוא מחפש.',
    issue: ['גיליון', '1#', 'לקוראים'],
    panels: [
      { alt: 'אישה עם שיער ג׳ינג׳י מתולתל, משקפיים עגולים וקרדיגן חרדל הולכת ברחוב שקט של בנייני אבן לבנים, ועוברת ליד ארון ספרים קטן מעץ בצבע טורקיז.',
        bubbles: ['מה יש בארון היום?'],
        caption: '<b>רותי לא עוברת ליד ארון ספרים בלי להציץ.</b> בהרבה שכונות יש ארונות ומדפים שבהם שכנים משאירים ספרים לכל מי שרוצה.' },
      { alt: 'רותי עומדת ליד הארון, מחזיקה ספר ירוק פתוח ומחייכת בהתרגשות.',
        bubbles: ['חיפשתי אותו שנים!'],
        caption: '<b>לפעמים מוצאים אוצר.</b> אבל רק במקרה, ורק אם עוברים בדיוק שם, בדיוק בזמן.' },
      { alt: 'רותי יושבת על ספה בערב עם כוס תה, ומסתכלת מהחלון על אורות העיר ונראית מהורהרת.',
        bubbles: ['יש עשרות ארונות בעיר. באיזה מהם מחכה הספר שאני רוצה?'],
        caption: '<b>הבעיה: אי אפשר לדעת מה יש בארון בלי ללכת אליו.</b> וספר טוב נלקח מהר.' },
      { alt: 'רותי, מצוירת מאחור, עומדת מול ארון הספרים ומצלמת את המדפים בטלפון.',
        sfx: 'קליק!',
        caption: '<b>אז רותי מצלמת את המדף בטלפון.</b> היא פותחת את הדף של הארון בספרחוב ומצלמת. זה לוקח כמה שניות.' },
      { alt: 'רותי יושבת על ספסל בפארק ומחייכת אל הטלפון, וסמלים קטנים של ספרים זוהרים עולים מהמסך.',
        bubbles: ['הוא קרא את השמות של כל הספרים!'],
        caption: '<b>ספרחוב קורא את שמות הספרים מהתמונה</b> ומוצא אותם בקטלוג. רותי עוברת על הרשימה, מאשרת ספר אחרי ספר ומקבלת נקודות על כל אחד. מעכשיו כל אחד יכול לחפש את הספרים שבארון.',
        steps: [
          ['איך מוסיפים ספרים', ['ליד ארון ספרים: פותחים את הארון בספרחוב ומצלמים את המדף', 'ספרחוב קורא את שמות הספרים', 'מאשרים ספר אחרי ספר. אין ארון במפה? מוסיפים אותו עם תמונה']],
          ['איך מוצאים ספר', ['כותבים שם של ספר או סופר', 'בוחרים מרחק: עד 1, 5, 20 או 50 ק״מ, או בכל מקום', 'לא נמצא? מבקשים התראה, ומקבלים הודעה כשהספר מופיע']],
        ] },
      { alt: 'גבר צעיר עם זקן קצר, קפוצ׳ון כחול ותיק גב יושב באוטובוס ליד החלון ומחייך בהתרגשות אל הטלפון.',
        bubbles: ['„הנסיך הקטן”, קילומטר ממני!'],
        caption: '<b>באותו ערב יוני מחפש ספר.</b> הוא כותב את שם הספר, בוחר מרחק, ורואה באילו ארונות הספר נמצא עכשיו.' },
      { alt: 'יוני עומד ליד ארון ספרים ברחוב אחר, מחזיק ספר שמצא ומחייך.',
        sfx: 'מצאתי!',
        caption: '<b>יוני הולך לארון ולוקח את הספר.</b> אם הוא רוצה, הוא מסמן שלקח אותו, כדי שהקורא הבא לא יחפש לשווא.' },
      { alt: 'יוני מניח ספר אדום על המדף בארון ומחייך.',
        bubbles: ['ומי שיבוא אחריי ימצא את זה.'],
        caption: '<b>ומשאיר ספר משלו.</b> אין חובה להשאיר ספר כשלוקחים. יוני פשוט אוהב לתת. ספרים עוברים מיד ליד.' },
      { alt: 'שלושה שכנים ליד ארון הספרים ברחוב: איש מבוגר עם זקן לבן ומקל הליכה, ילדה שמחזיקה ספר מצויר פתוח, ואישה בשמלה ירוקה שנוגעת בארון ומחייכת.',
        bubbles: ['גם ליד הבית שלנו יש ארון. בואו נוסיף אותו!'],
        caption: '<b>כל מדף שמצלמים מצטרף לספרייה אחת גדולה</b> שכל אחד יכול לחפש בה. המדפים שייכים לשכונה. ספרחוב לא מנהל אותם ולא מוסיף להם כללים.' },
    ],
    facts: [
      ['למה', ['ארונות ספרים ברחוב מלאים בספרים טובים, אבל לא רואים מה יש בהם מהבית', 'מי שמחפש ספר מסוים לא יודע לאן ללכת', 'ספר שאף אחד לא מוצא נשאר על המדף']],
      ['איך', ['מצלמים מדף, וספרחוב קורא את שמות הספרים', 'מחפשים לפי שם ספר או סופר, קרוב לבית או בכל מקום', 'מקבלים התראה כשספר שמחכים לו מופיע']],
      ['כמה זה עולה', ['כלום. ספרחוב חינמי', 'אפשר לחפש בלי להירשם', 'כדי לצלם ולהוסיף ספרים נכנסים עם Google או עם מייל']],
    ],
    end: 'יש ארון ספרים ליד הבית שלכם?',
    cta_map: 'לפתוח את המפה',
    cta_search: 'לחפש ספר',
    note: 'רותי ויוני הם דמויות בדויות. הציורים נעשו בעזרת מודל ציור שרץ על השרת של ספרחוב.',
  },
  en: {
    title: 'Ruti finds a gem',
    title_html: 'Ruti finds <span>a gem</span>',
    desc: 'A comic: why Seferehov exists and how to use it. Photograph a street book shelf, and anyone can search it.',
    lead: 'Why we built a map of street book cabinets, and how one photo of a shelf helps the next reader find the book they are looking for.',
    issue: ['Issue', '#1', 'for readers'],
    panels: [
      { alt: 'A woman with curly auburn hair, round glasses and a mustard cardigan walks along a quiet street of white stone buildings, past a small teal wooden book cabinet.',
        bubbles: ['What is in the cabinet today?'],
        caption: '<b>Ruti never walks past a book cabinet without a look.</b> Many neighbourhoods have cabinets and shelves where neighbours leave books for anyone who wants them.' },
      { alt: 'Ruti stands by the cabinet holding an open green book, smiling with delight.',
        bubbles: ['I have looked for this one for years!'],
        caption: '<b>Sometimes you find a gem.</b> But only by chance, and only if you pass right there at the right time.' },
      { alt: 'Ruti sits on a sofa in the evening with a mug of tea, looking out of the window at the town lights, thinking.',
        bubbles: ['There are dozens of cabinets in town. Which one has the book I want?'],
        caption: '<b>The problem: you cannot know what is in a cabinet without going there.</b> And a good book is taken quickly.' },
      { alt: 'Ruti, seen from behind, stands at the book cabinet and photographs the shelves with her phone.',
        sfx: 'Click!',
        caption: '<b>So Ruti photographs the shelf with her phone.</b> She opens the cabinet’s page in Seferehov and takes the photo. It takes a few seconds.' },
      { alt: 'Ruti sits on a park bench smiling at her phone, small glowing book icons rising from the screen.',
        bubbles: ['It read the names of all the books!'],
        caption: '<b>Seferehov reads the book titles from the photo</b> and finds them in the catalogue. Ruti goes through the list, approves one book at a time and earns points for each. Now anyone can search the books in that cabinet.',
        steps: [
          ['How to add books', ['At a book cabinet: open it in Seferehov and photograph the shelf', 'Seferehov reads the book titles', 'Approve one book at a time. Cabinet not on the map? Add it with a photo']],
          ['How to find a book', ['Type a book title or an author', 'Choose a distance: up to 1, 5, 20 or 50 km, or anywhere', 'Not there? Ask for an alert, and hear when the book turns up']],
        ] },
      { alt: 'A young man with a short beard, a blue hoodie and a backpack sits by a bus window, smiling with excitement at his phone.',
        bubbles: ['“The Little Prince”, one kilometre from me!'],
        caption: '<b>That evening Yoni looks for a book.</b> He types the title, chooses a distance, and sees which cabinets have the book right now.' },
      { alt: 'Yoni stands by a book cabinet on another street, holding the book he found and smiling.',
        sfx: 'Found it!',
        caption: '<b>Yoni walks to the cabinet and takes the book.</b> If he likes, he marks it as taken, so the next reader does not look for it in vain.' },
      { alt: 'Yoni places a red book on the cabinet shelf, smiling.',
        bubbles: ['Whoever comes next will find this.'],
        caption: '<b>And he leaves one of his own.</b> You do not have to leave a book to take one. Yoni just likes to give. Books pass from hand to hand.' },
      { alt: 'Three neighbours by the street book cabinet: an old man with a white beard and a walking cane, a girl holding an open picture book, and a woman in a green dress who touches the cabinet and smiles.',
        bubbles: ['There is a cabinet near our home too. Let us add it!'],
        caption: '<b>Every shelf someone photographs joins one big library</b> that anyone can search. The shelves belong to the neighbourhood. Seferehov does not run them and adds no rules.' },
    ],
    facts: [
      ['Why', ['Street book cabinets are full of good books, but you cannot see them from home', 'Someone looking for a certain book does not know where to go', 'A book nobody finds stays on the shelf']],
      ['How', ['Photograph a shelf, and Seferehov reads the titles', 'Search by title or author, near home or anywhere', 'Get an alert when a book you wait for turns up']],
      ['What it costs', ['Nothing. Seferehov is free', 'You can search without signing up', 'To photograph and add books, sign in with Google or e-mail']],
    ],
    end: 'Is there a book cabinet near your home?',
    cta_map: 'Open the map',
    cta_search: 'Find a book',
    note: 'Ruti and Yoni are made up. The drawings were made with an image model running on the Seferehov server.',
  },
};

export const comicText = (lng) => TEXT[lng] ?? TEXT.he;

// `link(path)` lets the server add ?lang=en to links; the app passes paths through.
export function comicHtml(lng, link = (p) => p) {
  const c = comicText(lng);
  const panel = (p, i) => {
    const x = c.panels[i];
    return `<article class="panel${p.wide ? ' wide' : ''}">
      <span class="num">${i + 1}</span>
      <div class="art">
        <img src="${ART}/${p.img}.webp" ${i > 1 ? 'loading="lazy" ' : ''}width="960" height="657" alt="${x.alt}">
        ${(p.bubbles ?? []).map(([kind, pos], j) => `<div class="bubble ${kind}" style="${pos}">${x.bubbles[j]}</div>`).join('')}
        ${p.sfx ? `<div class="sfx" style="${p.sfx}">${x.sfx}</div>` : ''}
      </div>
      ${x.steps ? `<div class="routes">${x.steps.map(([h, li]) => `<div class="route"><h3>${h}</h3><ol>${li.map((s) => `<li>${s}</li>`).join('')}</ol></div>`).join('')}</div>` : ''}
      <p class="caption">${x.caption}</p>
    </article>`;
  };
  return `<div class="comic-page">
    <header class="masthead">
      <div><h1>${c.title_html}</h1><p>${c.lead}</p></div>
      <div class="issue">${c.issue[0]}<b>${c.issue[1]}</b>${c.issue[2]}</div>
    </header>
    <div class="strip">${PANELS.map(panel).join('')}</div>
    <section class="facts">${c.facts.map(([h, li]) => `<div class="fact"><h2>${h}</h2><ul>${li.map((s) => `<li>${s}</li>`).join('')}</ul></div>`).join('')}</section>
    <section class="endcta"><p>${c.end}</p>
      <a class="cta" href="${link('/')}">${c.cta_map}</a> <a class="cta alt" href="${link('/search')}">${c.cta_search}</a></section>
    <p class="small muted">${c.note}</p>
  </div>`;
}
