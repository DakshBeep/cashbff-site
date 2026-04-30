// add-goal.js. modal state machine for the goal-tile intention-setting flow.
//
// Exposes window.CashBFFGoal.{open, close} (merging with the shell that
// home.js sets up, which already provides .render/.save/.current).
//
// Behavior:
//   - "G" keyboard shortcut and clicks on the goal tile both call open().
//   - Opening a filled goal pre-populates the textarea for editing.
//   - Submit fires POST /api/goals (new) or PATCH /api/goals/:id (edit).
//     On 2xx: close modal, tile morphs to "your intention." state.
//     On network / 404 / non-2xx: fall back to localStorage (cbff_goals),
//     same pattern as manual cards. User never sees a dead end.
//   - Close button is a tertiary text link; backdrop click also closes.
(function () {
  'use strict';

  var API_BASE = 'https://api.cashbff.com';
  var MAX_LEN = 120;

  var modal, panel, form, textarea, countEl, errEl, submitBtn, closeBtn, title, subtitle;
  var lastFocus = null;
  var isOpen = false;
  var editingId = null;

  function $(id) { return document.getElementById(id); }

  function updateCount() {
    if (!countEl || !textarea) return;
    countEl.textContent = String((textarea.value || '').length);
  }

  function showTitleForMode() {
    if (!title || !subtitle) return;
    var current = (window.CashBFFGoal && window.CashBFFGoal.current && window.CashBFFGoal.current()) || null;
    if (current && current.text) {
      title.textContent = 'your intention.';
      subtitle.textContent = 'tweak it. no judgment.';
    } else {
      title.textContent = 'add goal here.';
      subtitle.textContent = "what\u2019s your first intention?";
    }
  }

  function open() {
    if (!modal || isOpen) return;
    lastFocus = document.activeElement;

    // Pre-populate from the current goal if one exists.
    var current = (window.CashBFFGoal && window.CashBFFGoal.current && window.CashBFFGoal.current()) || null;
    if (current && current.text) {
      if (textarea) textarea.value = current.text;
      editingId = current.id || null;
    } else {
      if (textarea) textarea.value = '';
      editingId = null;
    }
    if (errEl) errEl.textContent = '';
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.innerHTML = 'set intention &rarr;';
    }
    updateCount();
    showTitleForMode();

    modal.hidden = false;
    requestAnimationFrame(function () { modal.classList.add('is-open'); });
    isOpen = true;
    // Focus into the textarea so the user can type immediately.
    setTimeout(function () { if (textarea) textarea.focus(); }, 80);
    document.addEventListener('keydown', onKey);
  }

  function close() {
    if (!modal || !isOpen) return;
    modal.classList.remove('is-open');
    setTimeout(function () {
      modal.hidden = true;
      if (lastFocus && typeof lastFocus.focus === 'function') {
        try { lastFocus.focus(); } catch (_) {}
      }
    }, 200);
    isOpen = false;
    document.removeEventListener('keydown', onKey);
  }

  function onKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      // Cmd/Ctrl+Enter submits (plain Enter inserts a newline in a textarea).
      e.preventDefault();
      submit();
    }
  }

  function persistLocal(goal) {
    if (window.CashBFFGoal && window.CashBFFGoal.save) {
      window.CashBFFGoal.save(goal);
    }
  }

  function submit(ev) {
    if (ev) ev.preventDefault();
    if (!textarea) return;
    if (errEl) errEl.textContent = '';

    var text = (textarea.value || '').trim();
    if (!text) {
      if (errEl) errEl.textContent = 'write a few words.';
      textarea.focus();
      return;
    }
    if (text.length > MAX_LEN) {
      text = text.slice(0, MAX_LEN);
    }

    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = 'setting\u2026';
    }

    var isEdit = !!editingId;
    var url = isEdit
      ? API_BASE + '/api/goals/' + encodeURIComponent(editingId)
      : API_BASE + '/api/goals';
    var method = isEdit ? 'PATCH' : 'POST';

    fetch(url, {
      method: method,
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ text: text })
    }).then(function (res) {
      if (res.status === 401) {
        location.replace('/');
        return new Promise(function () {});
      }
      if (!res.ok) throw new Error('bad response ' + res.status);
      return res.json().catch(function () { return {}; });
    }).then(function (data) {
      // Accept either { goal: {...} } or the bare goal object.
      var saved = (data && data.goal) || data || {};
      var next = {
        id: saved.id || editingId || null,
        text: saved.text || text
      };
      persistLocal(next);
      close();
    }).catch(function () {
      // Backend not deployed or offline. keep the user moving.
      var next = {
        id: editingId || null,
        text: text
      };
      persistLocal(next);
      close();
    }).then(function () {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.innerHTML = 'set intention &rarr;';
      }
    });
  }

  function wireBackdropClose() {
    if (!modal) return;
    modal.addEventListener('click', function (e) {
      if (e.target === modal) close();
    });
  }

  function init() {
    modal     = $('goal-modal');
    panel     = $('goal-modal-panel');
    title     = $('goal-modal-title');
    subtitle  = $('goal-modal-subtitle');
    form      = $('goal-form');
    textarea  = $('goal-text');
    countEl   = $('goal-count');
    errEl     = $('goal-error');
    submitBtn = $('goal-submit');
    closeBtn  = $('goal-close');

    if (!modal) return;

    if (closeBtn) closeBtn.addEventListener('click', close);
    if (form)     form.addEventListener('submit', submit);
    if (textarea) {
      textarea.addEventListener('input', function () {
        if ((textarea.value || '').length > MAX_LEN) {
          textarea.value = textarea.value.slice(0, MAX_LEN);
        }
        updateCount();
      });
      // Clamp on paste too.
      textarea.addEventListener('paste', function () {
        setTimeout(function () {
          if ((textarea.value || '').length > MAX_LEN) {
            textarea.value = textarea.value.slice(0, MAX_LEN);
          }
          updateCount();
        }, 0);
      });
    }
    wireBackdropClose();
  }

  // Merge into the shell that home.js already set up so render/save/current
  // (installed there) stay available alongside our open/close.
  window.CashBFFGoal = window.CashBFFGoal || {};
  window.CashBFFGoal.open = function () { open(); };
  window.CashBFFGoal.close = function () { close(); };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
