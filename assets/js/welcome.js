// ── Config ────────────────────────────────────────
const API_BASE = 'https://api.cashbff.com';
const NAME_KEY = 'cbff_first_name';
const LAST_KEY = 'cbff_last_name';
const STATS_KEY = 'cbff_stats';

// ── Preserve phone through navigation ─────────────
const params = new URLSearchParams(location.search);
const phone = params.get('phone') || '';
const nextUrl = `home.html${phone ? '?phone=' + encodeURIComponent(phone) : ''}`;
document.getElementById('skip-link').href = nextUrl;

// ── Greet by name ─────────────────────────────────
const firstName = localStorage.getItem(NAME_KEY);
const lastName  = localStorage.getItem(LAST_KEY);
const nameTail = document.getElementById('name-tail');
if (firstName && firstName.trim()) {
  const safe = firstName.replace(/[<>&"]/g, '');
  nameTail.innerHTML = ', <span class="name">' + safe.toLowerCase() + '</span>.';
}

// Pre-fill form with known values
if (firstName) document.getElementById('first_name').value = firstName;
if (lastName)  document.getElementById('last_name').value  = lastName;

// ── Continuity stats ──────────────────────────────
function humanSince(iso) {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  const now = Date.now();
  const days = Math.max(1, Math.floor((now - then) / 86_400_000));
  if (days < 30) return `${days}d`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo`;
  const years = (days / 365).toFixed(1);
  return `${years}y`;
}

try {
  const raw = localStorage.getItem(STATS_KEY);
  if (raw) {
    const stats = JSON.parse(raw);
    const accts = Number(stats.accounts || 0);
    const txns  = Number(stats.txns || 0);
    const since = humanSince(stats.joined_at);
    if (accts > 0 || txns > 0 || since) {
      document.getElementById('stat-accts').textContent = accts.toLocaleString();
      document.getElementById('stat-txns').textContent  = txns.toLocaleString();
      document.getElementById('stat-since').textContent = since || '—';
      document.getElementById('stats').hidden = false;
    }
  }
} catch (_) { /* no stats — show the empty shell */ }

// ── Form submit ──────────────────────────────────
const form = document.getElementById('profile-form');
const btn = document.getElementById('submit-btn');
const err = document.getElementById('err');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  err.textContent = '';

  const body = {
    first_name: document.getElementById('first_name').value.trim(),
    last_name:  document.getElementById('last_name').value.trim(),
    email:      document.getElementById('email').value.trim().toLowerCase(),
    dob:        document.getElementById('dob').value,
  };

  // At least one field must have changed — keep it friendly, don't block.
  if (!body.first_name && !body.last_name && !body.email && !body.dob) {
    location.href = nextUrl;
    return;
  }

  btn.disabled = true;
  const originalLabel = btn.textContent;
  btn.textContent = 'saving…';

  try {
    const res = await fetch(`${API_BASE}/api/profile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      err.textContent = data.error || 'something went wrong. try again?';
      btn.disabled = false;
      btn.textContent = originalLabel;
      return;
    }

    // Update localStorage so home sees the latest name
    if (body.first_name) localStorage.setItem(NAME_KEY, body.first_name);
    if (body.last_name)  localStorage.setItem(LAST_KEY, body.last_name);

    location.href = nextUrl;
  } catch (_) {
    err.textContent = 'network hiccup. try again in a sec.';
    btn.disabled = false;
    btn.textContent = originalLabel;
  }
});
