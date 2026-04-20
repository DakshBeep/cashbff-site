// home-bloom.js — dummy review page. Size varies inversely with balance.
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

  // Sort ascending by balance — smallest first (biggest on screen).
  const sorted = MOCK_CARDS.slice().sort((a, b) => a.balance - b.balance);

  const container = document.getElementById('bloom');
  if (!container) return;

  sorted.forEach((card, rank) => {
    const el = document.createElement('button');
    el.type = 'button';
    const sizeClass = SIZE_CLASSES[rank] || 'size-tiny';
    el.className = `seed ${sizeClass}`;
    el.dataset.slot = String(rank);
    el.setAttribute('aria-label', `${cleanText(card.institution)} card ending in ${card.mask}`);

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
