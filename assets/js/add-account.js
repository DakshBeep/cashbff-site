// add-account.js. modal state machine for the "+ add account" flow.
//
// Exposes window.CashBFFAddAccount.{open, close} so home.js (and keyboard
// shortcuts) can trigger it without reaching into DOM internals.
//
// Behavior:
//   - Three choices: manual, plaid (routes to /connect), close.
//   - Manual opens an inline form inside the same modal.
//   - Submit POSTs to https://api.cashbff.com/api/accounts/manual.
//     On 2xx: close modal, render card via CashBFFHome.addServerCard.
//     On network / non-2xx: save to localStorage via CashBFFHome.addLocalCard
//     and render optimistically. Users shouldn't see a dead end.
(function () {
  'use strict';

  var API_BASE = 'https://api.cashbff.com';

  var modal, modalPanel, choices, form, title;
  var btnManual, btnPlaid, btnClose, btnBack, btnSubmit, errEl;
  var institutionInput, maskInput, balanceInput, limitInput, chipsRow;
  var lastFocus = null;
  var isOpen = false;
  var addBtn;

  function $(id) { return document.getElementById(id); }

  function resetForm() {
    if (!form) return;
    form.reset();
    if (errEl) errEl.textContent = '';
    if (chipsRow) {
      chipsRow.querySelectorAll('.quick-chip.is-active').forEach(function (c) {
        c.classList.remove('is-active');
      });
    }
  }

  function showChoices() {
    if (!choices || !form) return;
    choices.classList.remove('is-hidden');
    form.classList.remove('is-visible');
    if (title) title.textContent = 'add an account.';
  }

  function showManualForm() {
    if (!choices || !form) return;
    choices.classList.add('is-hidden');
    form.classList.add('is-visible');
    if (title) title.textContent = 'add manually.';
    // Focus the institution field for quick entry.
    setTimeout(function () {
      if (institutionInput) institutionInput.focus();
    }, 60);
  }

  function open() {
    if (!modal || isOpen) return;
    lastFocus = document.activeElement;
    modal.hidden = false;
    // Allow the browser to register "hidden" removed before transitioning.
    requestAnimationFrame(function () { modal.classList.add('is-open'); });
    showChoices();
    resetForm();
    isOpen = true;
    // Default focus: primary choice.
    setTimeout(function () { if (btnManual) btnManual.focus(); }, 80);
    document.addEventListener('keydown', onKey);
  }

  function close() {
    if (!modal || !isOpen) return;
    modal.classList.remove('is-open');
    // After the fade-out finishes, fully hide and restore focus.
    setTimeout(function () {
      modal.hidden = true;
      if (lastFocus && typeof lastFocus.focus === 'function') {
        try { lastFocus.focus(); } catch (_) {}
      } else if (addBtn) {
        addBtn.focus();
      }
    }, 200);
    isOpen = false;
    document.removeEventListener('keydown', onKey);
  }

  function onKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  }

  function parseMoney(raw) {
    if (!raw) return NaN;
    var cleaned = String(raw).replace(/[^0-9.\-]/g, '');
    if (!cleaned) return NaN;
    var n = parseFloat(cleaned);
    return isFinite(n) ? n : NaN;
  }

  function submitManual(ev) {
    if (ev) ev.preventDefault();
    if (!form || !institutionInput || !maskInput || !balanceInput) return;
    if (errEl) errEl.textContent = '';

    var institution = (institutionInput.value || '').trim();
    var mask = (maskInput.value || '').trim();
    var balance = parseMoney(balanceInput.value);
    var limit = parseMoney(limitInput && limitInput.value);

    if (!institution) { errEl.textContent = 'need an institution name.'; institutionInput.focus(); return; }
    if (!/^\d{4}$/.test(mask)) { errEl.textContent = 'last 4 needs to be 4 digits.'; maskInput.focus(); return; }
    if (!isFinite(balance) || balance < 0) { errEl.textContent = 'balance needs to be a number.'; balanceInput.focus(); return; }
    if (!isFinite(limit)) limit = 0;

    var payload = {
      institution: institution,
      mask: mask,
      balance: balance,
      limit: limit
    };

    if (btnSubmit) {
      btnSubmit.disabled = true;
      btnSubmit.textContent = 'adding…';
    }

    fetch(API_BASE + '/api/accounts/manual', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(payload)
    }).then(function (res) {
      if (res.status === 401) {
        // Session expired mid-flow. Bail out to login.
        location.replace('/');
        return new Promise(function () {});
      }
      if (!res.ok) throw new Error('bad response ' + res.status);
      return res.json().catch(function () { return {}; });
    }).then(function (data) {
      var newCard = (data && data.card) || payload;
      if (window.CashBFFHome && window.CashBFFHome.addServerCard) {
        window.CashBFFHome.addServerCard(newCard);
      }
      close();
    }).catch(function () {
      // Backend not ready (404) or network hiccup. fall back to localStorage
      // so the user still sees their card on the canvas.
      if (window.CashBFFHome && window.CashBFFHome.addLocalCard) {
        window.CashBFFHome.addLocalCard(payload);
      }
      close();
    }).then(function () {
      if (btnSubmit) {
        btnSubmit.disabled = false;
        btnSubmit.textContent = 'add it.';
      }
    });
  }

  function wireChips() {
    if (!chipsRow || !institutionInput) return;
    chipsRow.addEventListener('click', function (e) {
      var chip = e.target.closest('.quick-chip');
      if (!chip) return;
      chipsRow.querySelectorAll('.quick-chip.is-active').forEach(function (c) {
        c.classList.remove('is-active');
      });
      chip.classList.add('is-active');
      var val = chip.getAttribute('data-v') || chip.textContent || '';
      if (val && val.toLowerCase() !== 'other') {
        institutionInput.value = val;
      } else {
        institutionInput.value = '';
        institutionInput.focus();
      }
    });
  }

  function wireBackdropClose() {
    if (!modal) return;
    modal.addEventListener('click', function (e) {
      // Click outside the panel closes.
      if (e.target === modal) close();
    });
  }

  function init() {
    modal            = $('add-modal');
    modalPanel       = $('add-modal-panel');
    title            = $('add-modal-title');
    choices          = $('modal-choices');
    form             = $('manual-form');
    btnManual        = $('choice-manual');
    btnPlaid         = $('choice-plaid');
    btnClose         = $('choice-close');
    btnBack          = $('manual-back');
    btnSubmit        = $('manual-submit');
    errEl            = $('form-error');
    institutionInput = $('f-institution');
    maskInput        = $('f-mask');
    balanceInput     = $('f-balance');
    limitInput       = $('f-limit');
    chipsRow         = $('institution-chips');
    addBtn           = $('add-account-btn');

    if (!modal) return;

    if (btnManual) btnManual.addEventListener('click', showManualForm);
    if (btnPlaid)  btnPlaid.addEventListener('click', function () {
      // Modal-in-place Plaid Link is a follow-up. Route to /connect for now.
      location.href = '/connect';
    });
    if (btnClose)  btnClose.addEventListener('click', close);
    if (btnBack)   btnBack.addEventListener('click', showChoices);
    if (form)      form.addEventListener('submit', submitManual);

    // Mask input: restrict to digits, max 4.
    if (maskInput) {
      maskInput.addEventListener('input', function () {
        var v = (maskInput.value || '').replace(/\D/g, '').slice(0, 4);
        if (v !== maskInput.value) maskInput.value = v;
      });
    }
    // Balance + limit: allow digits, one dot, optional leading $.
    [balanceInput, limitInput].forEach(function (inp) {
      if (!inp) return;
      inp.addEventListener('input', function () {
        var v = (inp.value || '').replace(/[^0-9.]/g, '');
        var parts = v.split('.');
        if (parts.length > 2) v = parts[0] + '.' + parts.slice(1).join('');
        if (v !== inp.value) inp.value = v;
      });
    });

    wireChips();
    wireBackdropClose();
  }

  // Expose for home.js and keyboard shortcuts.
  window.CashBFFAddAccount = {
    open: function () { open(); },
    close: function () { close(); }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
