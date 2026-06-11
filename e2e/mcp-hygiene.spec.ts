// MCP / old-stack hygiene tripwire.
//
// cashbff's product channel is WhatsApp. The old Claude/MCP "connector" stack
// has been stripped from the site (Phase-1 rebuild). This spec is the
// regression guard: it fails if any served page leaks the retired old-stack
// vocabulary into its served HTML.
//
// Banned patterns (case-insensitive), per the rebuild brief:
//   - mcp
//   - model context protocol
//   - agentic
//   - "open in claude"
//   - "talk to your money in claude"
//   - claude.ai   (the old connector landing target)
//   - connector   (Claude/MCP connector UI language)
//
// We read the shipped files straight off disk (no server, no network) so
// the check is fast + deterministic and runs without JWT_SECRET. The scan is on
// RAW HTML, so it also catches leaks hiding in comments, <script> JSON-LD, meta
// tags, and inline JS — anywhere a crawler or a curious user could see them.
//
// Scope — ALL pages here MUST be clean (the build fails if any regress):
//   • the indexable marketing pages this rebuild owns;
//   • home.html — the logged-in dashboard. It's noindex (not a marketing
//     page), but a signed-in user sees it, so it's held to the same bar;
//   • privacy.html + terms.html — the site's own legal docs. The MCP/connector
//     language has been minimally stripped to the WhatsApp/Plaid reality so the
//     live docs are clean for the Ahrefs crawl. (The full legal rewrite is a
//     separate, deliberate publish; this only guards the MCP-strip.)

import { test, expect } from '@playwright/test';
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename_local = fileURLToPath(import.meta.url);
const __dirname_local = dirname(__filename_local);
const REPO_ROOT = resolve(__dirname_local, '..');

// Every served page that must stay free of old-stack vocabulary. Indexable
// marketing pages + the noindex dashboard + the site's own legal docs.
const SHIPPED_PAGES = [
  'index.html',
  'how-it-works.html',
  'faq.html',
  'is-cashbff-legit.html',
  'start.html',
  'pricing.html',
  'security.html',
  'about.html',
  'signup.html',
  'home.html',
  'privacy.html',
  'terms.html',
  // the dysmorphia-stance pages (2026-06-11): the pillar + the comparison set.
  // cashbff-vs-era.html describes a competitor whose product IS the old stack's
  // vocabulary, so it is the likeliest regression point — keep it guarded.
  'money-dysmorphia.html',
  'cashbff-vs-rocket-money.html',
  'cashbff-vs-cleo.html',
  'cashbff-vs-monarch-money.html',
  'cashbff-vs-era.html',
];

// One regex, case-insensitive. \bmcp\b avoids matching substrings inside other
// words; the multi-word phrases are matched literally. claude\.ai + connector
// catch the retired Claude-connector landing target and UI language.
const BANNED = /\bmcp\b|model context protocol|agentic|open in claude|talk to your money in claude|claude\.ai|connector/i;

function readPage(file: string): string {
  const p = resolve(REPO_ROOT, file);
  if (!existsSync(p)) throw new Error(`expected page not found: ${file}`);
  return readFileSync(p, 'utf-8');
}

/** Return the banned phrases found in a page, with surrounding context, so a
 *  failure message points straight at the offending line(s). */
function findBanned(html: string): string[] {
  const out: string[] = [];
  html.split(/\r?\n/).forEach((line, idx) => {
    const m = line.match(BANNED);
    if (m) out.push(`line ${idx + 1}: …${line.trim().slice(0, 120)}…  (matched: "${m[0]}")`);
  });
  return out;
}

test.describe('mcp / old-stack hygiene', () => {
  for (const page of SHIPPED_PAGES) {
    test(`${page} contains no MCP / old-stack vocabulary`, async () => {
      const html = readPage(page);
      const hits = findBanned(html);
      expect(hits, `${page} leaked old-stack copy:\n  ${hits.join('\n  ')}`).toEqual([]);
    });
  }
});
