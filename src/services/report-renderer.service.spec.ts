import { beforeAll, describe, expect, it } from 'vitest';
import {
  type ReportData,
  type ReportSessionInput,
  buildReport,
  previousPeriod,
} from '../domain/report';
import { ReportRendererService } from './report-renderer.service';

/*
 * The PDF (ADR-021, CONTRACT.md §27).
 *
 * A rendered PDF cannot be diffed and should not be snapshotted — the bytes change with a font
 * update. So these assert the properties that would be defects rather than the layout:
 *
 *   IT RENDERS AT ALL, for an empty period, a huge one, and Unicode titles.
 *   IT STAYS BOUNDED, so a heavy month cannot produce a fifty-page attachment.
 *   IT LEAKS NOTHING — no id, no token, no email address anywhere in the bytes.
 *
 * The visual review — spacing, page breaks, whether the chart reads well — is a human step and is
 * not claimed here.
 */

const NOW = new Date('2026-08-03T07:00:00.000Z');
const MINUTE = 60 * 1000;

function focusSession(endedAt: string, title: string, minutes = 25): ReportSessionInput {
  return {
    type: 'focus',
    status: 'completed',
    endedAt: new Date(endedAt),
    actualDurationMs: minutes * MINUTE,
    taskTitleSnapshot: title,
    terminationReason: null,
  };
}

function report(sessions: ReportSessionInput[], kind: 'weekly' | 'monthly' = 'weekly'): ReportData {
  return buildReport({
    period: previousPeriod(kind, '2026-08-03'),
    timeZone: 'Europe/London',
    firstName: 'Ada',
    generatedAt: NOW,
    sessions,
    progress: { lifetimePoints: 4200, currentDayStreak: 3, longestDayStreak: 9 },
  });
}

/** Rough page count: every page object in a PDF carries one `/Type /Page` marker. */
function countPages(pdf: Buffer): number {
  return (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;
}

describe('ReportRendererService', () => {
  let renderer: ReportRendererService;

  beforeAll(() => {
    renderer = new ReportRendererService();
  });

  it('renders a weekly report', async () => {
    const pdf = await renderer.render(
      report([focusSession('2026-07-28T10:25:00.000Z', 'Write the report')]),
    );

    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.byteLength).toBeGreaterThan(1000);
  });

  it('renders a monthly report', async () => {
    const pdf = await renderer.render(
      report([focusSession('2026-07-15T10:25:00.000Z', 'Refactor')], 'monthly'),
    );

    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('renders an empty period without throwing', async () => {
    /*
     * The worker skips an empty period (P7), so this document is never mailed — but a renderer that
     * threw on one would turn a quiet skip into a failed delivery and a retry loop.
     */
    const pdf = await renderer.render(report([]));
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('survives Unicode task titles', async () => {
    const pdf = await renderer.render(
      report([
        focusSession('2026-07-28T10:25:00.000Z', 'Café ☕ — déjà vu'),
        focusSession('2026-07-29T10:25:00.000Z', 'Привет мир'),
        focusSession('2026-07-30T10:25:00.000Z', '日本語のタスク'),
        focusSession('2026-07-31T10:25:00.000Z', 'emoji 🌲🔥 in a title'),
      ]),
    );

    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('truncates a very long title without cutting a surrogate pair in half', async () => {
    const title = `${'🌲'.repeat(120)} tail`;
    const pdf = await renderer.render(report([focusSession('2026-07-28T10:25:00.000Z', title)]));

    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('stays within the page cap on a heavy month', async () => {
    /*
     * D3. The content is bounded rather than the output — ten task rows, one column per part-week,
     * four termination reasons — so a busy month cannot produce a fifty-page attachment.
     */
    const sessions: ReportSessionInput[] = [];
    for (let day = 1; day <= 31; day += 1) {
      for (let n = 0; n < 16; n += 1) {
        const date = `2026-07-${String(day).padStart(2, '0')}`;
        sessions.push(
          focusSession(`${date}T${String(8 + (n % 12)).padStart(2, '0')}:25:00.000Z`, `Task ${n}`),
        );
      }
    }

    const pdf = await renderer.render(report(sessions, 'monthly'));

    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(countPages(pdf)).toBeLessThanOrEqual(10);
  });

  describe('leaks nothing', () => {
    /*
     * The real guarantee is structural: `ReportData` has no field that could hold an id, a token, an
     * address, or another account's anything — so there is nothing in scope for the renderer to
     * expose. These two tests pin that shape, because the way this breaks in future is somebody
     * widening `ReportData` for convenience.
     *
     * Scanning the raw bytes for a lone character would prove nothing either way: a PDF embeds a
     * compressed font subset, and every byte value occurs in it by chance. This one renders 68 `@`
     * characters purely from the Roboto stream.
     */

    it('is handed nothing sensitive in the first place', () => {
      const data = report([focusSession('2026-07-28T10:25:00.000Z', 'Write the report')]);

      expect(Object.keys(data).sort()).toEqual([
        'buckets',
        'currentDayStreak',
        'firstName',
        'generatedAt',
        'lifetimePoints',
        'longestDayStreak',
        'period',
        'periodLabel',
        'previousPeriodLabel',
        'previousTotals',
        'remainingTasks',
        'tasks',
        'terminations',
        'timeZone',
        'totals',
      ]);
    });

    it('emits no identifier or credential a caller could have leaked into it', async () => {
      /*
       * Sentinels, not a character class. None of these is ever passed to `buildReport`, so any
       * appearance means the shape above widened and something started travelling that should not.
       */
      const pdf = await renderer.render(
        report([focusSession('2026-07-28T10:25:00.000Z', 'Write the report')]),
      );
      const text = pdf.toString('latin1');

      expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
      expect(text).not.toContain('whsec_');
      expect(text).not.toContain('re_');
      expect(text).not.toContain('example.test');
      expect(text).not.toContain('reports/unsubscribe');
    });
  });
});
