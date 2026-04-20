// home-bloom-v3.js — orbit / gravity. Hero at center, satellites circling.
(function () {
  const MOCK_CARDS = [
    { institution: "Capital One",     mask: "4471", balance: 847.22,  limit: 2500 },
    { institution: "Credit One",      mask: "0192", balance: 2430.05, limit: 3000 },
    { institution: "Discover",        mask: "8834", balance: 17.05,   limit: 5000 },
    { institution: "Chase",           mask: "6501", balance: 1205.18, limit: 4500 },
    { institution: "Bank of America", mask: "2208", balance: 63.40,   limit: 8000 }
  ];

  // Rank 0 is smallest balance → hero. Ranks 1..4 are satellites, descending priority.
  const SAT_CLASSES = [null, 'sat-large', 'sat-med', 'sat-small', 'sat-tiny'];
  const TAGS = [
    'closest to zero',
    'almost there',
    'chip away',
    'the big one',
    'patient work',
  ];

  // Orbit params per satellite rank: closer + faster for lower balances.
  // rx/ry in rem; duration in seconds; start angle offsets prevent clumping.
  const isMobile = window.matchMedia('(max-width: 720px)').matches;
  const ORBITS = isMobile ? [
    null,
    { rx: '9rem',  ry: '5.5rem', dur: '26s', start: '10deg',  delay: '-4s'  },
    { rx: '11rem', ry: '7rem',   dur: '34s', start: '120deg', delay: '-10s' },
    { rx: '12.5rem', ry: '8rem', dur: '44s', start: '220deg', delay: '-18s' },
    { rx: '13.5rem', ry: '9rem', dur: '58s', start: '310deg', delay: '-26s' },
  ] : [
    null,
    { rx: '13rem', ry: '8rem',  dur: '28s', start: '15deg',  delay: '-5s'  },
    { rx: '16rem', ry: '10rem', dur: '38s', start: '130deg', delay: '-12s' },
    { rx: '19rem', ry: '12rem', dur: '50s', start: '230deg', delay: '-22s' },
    { rx: '21rem', ry: '13rem', dur: '66s', start: '320deg', delay: '-30s' },
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

  const container = document.getElementById('cosmos');
  if (!container) return;

  sorted.forEach((card, rank) => {
    const el = document.createElement('button');
    el.type = 'button';
    const { dollars, cents } = formatMoney(card.balance);
    const institution = cleanText(card.institution);
    const tag = TAGS[rank] || '';

    if (rank === 0) {
      el.className = 'seed hero';
    } else {
      const satClass = SAT_CLASSES[rank] || 'sat-tiny';
      el.className = `seed satellite ${satClass}`;
      const o = ORBITS[rank];
      el.style.setProperty('--rx', o.rx);
      el.style.setProperty('--ry', o.ry);
      el.style.setProperty('--start', o.start);
      el.style.setProperty('--orbit-dur', o.dur);
      el.style.setProperty('--orbit-delay', o.delay);
    }

    el.setAttribute('aria-label', `${institution} card ending in ${card.mask}`);
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
