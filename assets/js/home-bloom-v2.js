// home-bloom-v2.js. scatter / seedbed. Asymmetric absolute layout, breeze-bob.
(function () {
  const MOCK_CARDS = [
    { institution: "Capital One",     mask: "4471", balance: 847.22,  limit: 2500 },
    { institution: "Credit One",      mask: "0192", balance: 2430.05, limit: 3000 },
    { institution: "Discover",        mask: "8834", balance: 17.05,   limit: 5000 },
    { institution: "Chase",           mask: "6501", balance: 1205.18, limit: 4500 },
    { institution: "Bank of America", mask: "2208", balance: 63.40,   limit: 8000 }
  ];

  const SIZE_CLASSES = ['size-huge', 'size-large', 'size-med', 'size-small', 'size-tiny'];
  const TAGS = [
    'closest to zero',
    'almost there',
    'chip away',
    'the big one',
    'patient work',
  ];

  // Hand-tuned scatter positions (rank-indexed: 0 = smallest balance / biggest seed).
  // Each: x%, y%, width (rem), height (rem), rotation (deg), drift duration (s), delay (s).
  const DESKTOP_SCATTER = [
    { x: '6%',  y: '8%',   w: '19rem', h: '14rem', rot: '-4deg',  dur: '9.4s',  delay: '0.2s' },
    { x: '54%', y: '4%',   w: '15rem', h: '11.5rem', rot: '3deg',  dur: '8.1s',  delay: '0.8s' },
    { x: '38%', y: '48%',  w: '13rem', h: '9.5rem',  rot: '-5deg', dur: '10.2s', delay: '0.4s' },
    { x: '3%',  y: '60%',  w: '11.5rem', h: '8.5rem', rot: '6deg', dur: '7.6s',  delay: '1.1s' },
    { x: '68%', y: '55%',  w: '10.5rem', h: '7.8rem', rot: '-2deg', dur: '11.0s', delay: '0.55s' }
  ];

  const MOBILE_SCATTER = [
    { x: '4%',  y: '2%',   w: '16rem',   h: '13rem',   rot: '-3deg', dur: '9.4s',  delay: '0.2s' },
    { x: '40%', y: '22%',  w: '13rem',   h: '10rem',   rot: '4deg',  dur: '8.1s',  delay: '0.8s' },
    { x: '8%',  y: '42%',  w: '12rem',   h: '9rem',    rot: '-5deg', dur: '10.2s', delay: '0.4s' },
    { x: '46%', y: '58%',  w: '11rem',   h: '8.5rem',  rot: '5deg',  dur: '7.6s',  delay: '1.1s' },
    { x: '10%', y: '76%',  w: '10.5rem', h: '7.5rem',  rot: '-2deg', dur: '11.0s', delay: '0.55s' }
  ];

  function formatMoney(n) {
    const rounded = Math.round(n * 100) / 100;
    const dollars = Math.floor(rounded);
    const cents = Math.round((rounded - dollars) * 100);
    return {
      dollars: '$' + dollars.toLocaleString('en-US'),
      cents: '.' + String(cents).padStart(2, '0'),
    };
  }

  function cleanText(raw) {
    return String(raw || '').toLowerCase().trim().replace(/[<>&"]/g, '');
  }

  const sorted = MOCK_CARDS.slice().sort((a, b) => a.balance - b.balance);

  const container = document.getElementById('scatter');
  if (!container) return;

  const isMobile = window.matchMedia('(max-width: 720px)').matches;
  const positions = isMobile ? MOBILE_SCATTER : DESKTOP_SCATTER;

  sorted.forEach((card, rank) => {
    const pos = positions[rank] || positions[positions.length - 1];
    const el = document.createElement('button');
    el.type = 'button';
    const sizeClass = SIZE_CLASSES[rank] || 'size-tiny';
    el.className = `seed ${sizeClass}`;
    el.setAttribute('aria-label', `${cleanText(card.institution)} card ending in ${card.mask}`);
    el.style.setProperty('--x', pos.x);
    el.style.setProperty('--y', pos.y);
    el.style.setProperty('--w', pos.w);
    el.style.setProperty('--h', pos.h);
    el.style.setProperty('--rot', pos.rot);
    el.style.setProperty('--drift-dur', pos.dur);
    el.style.setProperty('--drift-delay', pos.delay);
    el.style.transform = `rotate(${pos.rot})`;

    const { dollars, cents } = formatMoney(card.balance);
    const institution = cleanText(card.institution);
    const tag = TAGS[rank] || '';

    el.innerHTML = `
      <span class="seed__top">${institution} · …${card.mask}</span>
      <span>
        <span class="seed__balance">${dollars}<span class="cents">${cents}</span></span>
        ${tag ? `<div class="seed__tag">${tag}</div>` : ''}
      </span>
      <span class="seed__bottom">limit $${Number(card.limit).toLocaleString('en-US')}</span>
    `;
    container.appendChild(el);
  });
})();
