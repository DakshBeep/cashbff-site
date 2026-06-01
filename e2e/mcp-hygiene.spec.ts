// MCP / old-stack hygiene tripwire.
//
// cashbff's product channel is WhatsApp. The old Claude/MCP "connector" stack
// is being stripped from the marketing site (Phase-1 rebuild). This spec is the
// regression guard: it fails if any indexable shipped marketing page leaks the
// retired old-stack vocabulary into its served HTML.
//
// Banned patterns (case-insensitive), per the rebuild brief:
//   - mcp
//   - model context protocol
//   - agentic
//   - "open in claude"
//   - "talk to your money in claude"
//
// We read the shipped .html files straight off disk (no server, no network) so
// the check is fast + deterministic and runs without JWT_SECRET. The scan is on
// RAW HTML, so it also catches leaks hiding in comments, <script> JSON-LD, meta
// tags, and inline JS — anywhere a crawler or a curious user could see them.
//
// Scope:
//   • SHIPPED_PAGES — the indexable marketing pages this rebuild owns. These
//     MUST be clean; this block fails the build if they regress.
//   • home.html is intentionally EXCLUDED: it's the logged-in dashboard and
//     ships <meta name="robots" content="noindex"> (not a marketing page).
//   • LEGAL_PAGES (privacy.html, terms.html) are owned by the separate legal
//     rewrite branch and still contain MCP connector language at the time of
//     writing. They get their own block below that is expected to stay RED
//     until that branch merges — a deliberate tripwire so we don't forget to
//     finish the job. Flip `EXPECT_LEGAL_CLEAN` to true once it lands.

import { test, expect } from '@playwright/test';
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename_local = fileURLToPath(import.meta.url);
const __dirname_local = dirname(__filename_local);
const REPO_ROOT = resolve(__dirname_local, '..');

// Indexable marketing pages owned by the Phase-1 rebuild. Must be clean.
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
];

// Legal docs owned by the legal-rewrite branch. Still carry MCP language until
// that merges. Tripwire stays red on purpose; flip this when legal lands.
const LEGAL_PAGES = ['privacy.html', 'terms.html'];
const EXPECT_LEGAL_CLEAN = false;

// One regex, case-insensitive. \bmcp\b avoids matching substrings inside other
// words; the multi-word phrases are matched literally.
const BANNED = /\bmcp\b|model context protocol|agentic|open in claude|talk to your money in claude/i;

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

  // Legal docs: red until the legal-rewrite branch merges. When it does, set
  // EXPECT_LEGAL_CLEAN = true (or fold these into SHIPPED_PAGES and delete this
  // block). Until then we ASSERT they're still dirty so this test passes today
  // AND loudly reminds us the moment legal goes clean (it'll start failing,
  // prompting the flip).
  for (const page of LEGAL_PAGES) {
    test(`${page} legal doc — MCP-strip status (gated on legal branch)`, async () => {
      const html = readPage(page);
      const hits = findBanned(html);
      if (EXPECT_LEGAL_CLEAN) {
        expect(hits, `${page} should be clean now:\n  ${hits.join('\n  ')}`).toEqual([]);
      } else {
        // Still expected to contain MCP language. If this assertion fails, the
        // legal rewrite has landed — flip EXPECT_LEGAL_CLEAN to true.
        expect(
          hits.length,
          `${page} is now clean — flip EXPECT_LEGAL_CLEAN to true (or move it into SHIPPED_PAGES).`,
        ).toBeGreaterThan(0);
      }
    });
  }
});
