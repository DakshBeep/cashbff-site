// home-wallet.js — dummy review page. Click a card → it slides forward, others recede.
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
    const institution = cleanText(card.institution);

    el.innerHTML = `
      <span class="card__top">${institution}</span>
      <span class="card__balance">${dollars}<span class="cents">${cents}</span></span>
      <span class="card__bottom">
        <span>…${card.mask}</span>
        <span class="card__limit">of $${Number(card.limit).toLocaleString('en-US')}</span>
      </span>
    `;

    return el;
  }

  const wallet = document.getElementById('wallet');
  const hand = document.getElementById('hand');
  if (!wallet || !hand) return;

  const cardEls = MOCK_CARDS.slice(0, 5).map((c, i) => {
    const el = renderCard(c, i);
    hand.appendChild(el);
    return el;
  });

  let picked = null;
  function pick(el) {
    if (picked === el) {
      // tapping the picked card un-picks it
      picked.classList.remove('is-picked');
      wallet.classList.remove('has-picked');
      picked = null;
      return;
    }
    if (picked) picked.classList.remove('is-picked');
    picked = el;
    picked.classList.add('is-picked');
    wallet.classList.add('has-picked');
  }
  cardEls.forEach((el) => el.addEventListener('click', () => pick(el)));

  // Auto-pick the middle card for an inviting initial state
  setTimeout(() => { if (!picked && cardEls[2]) pick(cardEls[2]); }, 600);
})();
