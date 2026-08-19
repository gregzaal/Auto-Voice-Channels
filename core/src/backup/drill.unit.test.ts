import { describe, expect, it } from 'vitest';
import { parseRestoreToc } from './drill.js';

/**
 * The fixture is real `pg_restore --list` output, trimmed. Parsing this format
 * from imagination is how the `TABLE DATA` bug below gets written, so the
 * sample stays verbatim.
 */
const TOC = `;
; Archive created at 2026-08-19 03:00:12 UTC
;     dbname: avc
;     TOC Entries: 84
;     Compression: gzip
;     Dump Version: 1.15-0
;     Format: CUSTOM
;     Integer: 4 bytes
;     Offset: 8 bytes
;     Dumped from database version: 16.4
;     Dumped by pg_dump version: 16.4
;
;
; Selected TOC Entries:
;
6; 2615 16389 SCHEMA - drizzle postgres
215; 1259 16404 TABLE public guilds postgres
217; 1259 16418 TABLE public auto_channels postgres
219; 1259 16431 TABLE public secondary_channels postgres
221; 1259 16444 TABLE public subscriptions postgres
223; 1259 16455 TABLE drizzle __drizzle_migrations postgres
3521; 0 16404 TABLE DATA public guilds postgres
3523; 0 16418 TABLE DATA public auto_channels postgres
3390; 2606 16412 CONSTRAINT public guilds guilds_pkey postgres
3392; 1259 16417 INDEX public guilds_auth_status_idx postgres
`;

describe('parseRestoreToc', () => {
  it('names the tables in the archive', () => {
    expect(parseRestoreToc(TOC).tables).toEqual([
      '__drizzle_migrations',
      'auto_channels',
      'guilds',
      'secondary_channels',
      'subscriptions',
    ]);
  });

  /**
   * The bug this exists to prevent. `TABLE DATA public guilds` matched by a
   * pattern expecting `TABLE <schema> <name>` yields schema `DATA`, table
   * `public`, and a drill that reports every dump as full of tables called
   * `public` while finding none of the ones it was looking for.
   */
  it('does not read TABLE DATA entries as tables named public', () => {
    const parsed = parseRestoreToc(TOC);
    expect(parsed.tables).not.toContain('public');
    expect(parsed.withData).toEqual(['auto_channels', 'guilds']);
  });

  it('ignores the comment header rather than counting it', () => {
    // 10 non-comment lines in the fixture.
    expect(parseRestoreToc(TOC).entries).toBe(10);
  });

  it('reports nothing for an empty listing', () => {
    expect(parseRestoreToc('')).toEqual({ entries: 0, tables: [], withData: [] });
    expect(parseRestoreToc(';\n; Archive created\n;\n').entries).toBe(0);
  });

  it('survives Windows line endings', () => {
    expect(parseRestoreToc(TOC.replace(/\n/g, '\r\n')).tables).toContain('guilds');
  });

  /** Entries that are not tables still count, so an empty TOC is detectable. */
  it('counts non-table entries', () => {
    const parsed = parseRestoreToc(TOC);
    expect(parsed.entries).toBeGreaterThan(parsed.tables.length);
  });
});
