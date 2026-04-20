// home-drift.js — dummy review page. No auth, no fetch. Hardcoded mock cards.
(function () {
  const MOCK_CARDS = [
    { institution: "Capital One",     mask: "4471", balance: 847.22,  limit: 2500 },
    { institution: "Credit One",      mask: "0192", balance: 2430.05, limit: 3000 },
    { institution: "Discover",        mask: "8834", balance: 17.05,   limit: 5000 },
    { institution: "Chase",           mask: "6501", balance: 1205.18, limit: 4500 },
    { institution: "Bank of America", mask: "2208", balance: 63.40,   limit: 8000 }
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

  function renderCard(card, slot) {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'card';
    el.dataset.slot = String(slot);
    el.setAttribute('aria-label', `${cleanText(card.institution)} card ending in ${card.mask}`);

    const { dollars, cents } = formatMoney(Number(card.balance) || 0);
    const institution = cleanText(card.institution) || 'card';
    const maskBit = card.mask ? `…${card.mask}` : '';

    const inner = document.createElement('span');
    inner.className = 'card__inner';
    inner.innerHTML = `
      <span class="card__top">${institution}</span>
      <span class="card__balance">${dollars}<span class="cents">${cents}</span></span>
      <span class="card__bottom">${maskBit}</span>
    `;
    el.appendChild(inner);

    el.addEventListener('click', () => {
      el.classList.add('is-tapped');
      setTimeout(() => el.classList.remove('is-tapped'), 260);
    });

    return el;
  }

  const container = document.getElementById('drift');
  if (container) {
    MOCK_CARDS.slice(0, 5).forEach((c, i) => container.appendChild(renderCard(c, i)));
  }
})();
