import { Injectable } from '@nestjs/common';
import { dirname } from 'node:path';
import {
  MAX_TASK_ROWS,
  type ReportBucket,
  type ReportData,
  TASK_TITLE_MAX,
  type ReportTotals,
} from '../domain/report';

/*
 * The PDF report (ADR-021, CONTRACT.md §27).
 *
 * A CONCRETE SERVICE, NOT A PORT. ADR-020 refuses a port with one implementation and no plausible
 * second, and there is none here: nothing in the product wants a second document format, and moving
 * to PDFKit would replace this file rather than run beside it. A fake renderer would only prove the
 * fake was called (A5).
 *
 * TWO PROPERTIES ARE STRUCTURAL RATHER THAN REMEMBERED:
 *
 *   1. IT CANNOT FETCH. `setUrlAccessPolicy` refuses every URL and `setLocalAccessPolicy` allows
 *      reads only from pdfmake's own package directory, which is where its fonts live. The brief's
 *      "must not depend on loading untrusted remote assets while rendering" is therefore enforced by
 *      the library, not by nobody having written a URL yet.
 *   2. IT CANNOT LEAK. The only argument is `ReportData`, and that shape holds no id, no token, no
 *      email address, no provider metadata and no other account's anything — by construction, in
 *      `domain/report.ts`. There is nothing in scope here to expose.
 *
 * The output is a Buffer and is never written to disk (A6, §26.4). `pdfmake` also offers `.write()`;
 * it is deliberately not used.
 */

/** Font weights map onto Roboto, which pdfmake ships. Nothing is downloaded. */
const FONT_FAMILY = 'Roboto';

/*
 * The two data-series colours, carried over from the palette validated for the proposal document:
 * blue for completed, orange for terminated. They differ in hue AND in lightness, so the chart is
 * still readable in greyscale and to a red-green colour-blind reader — and every bar prints its
 * value anyway, because §27 forbids encoding anything in colour alone.
 */
const COMPLETED_COLOR = '#2a78d6';
const TERMINATED_COLOR = '#eb6834';

const INK = '#1f2a22';
const MUTED = '#5b6b5f';
const RULE = '#d8e0d6';
const BRAND = '#2f5d3a';

/** Chart geometry, in PDF points. The content width of an A4 page at the margins §27 fixes. */
const CHART_WIDTH = 495;
const CHART_HEIGHT = 120;
const BAR_GAP = 4;

/** en-GB, fixed. There is no locale column and i18n is a §0.4 non-goal (P14). */
const LOCALE = 'en-GB';

/** The minimal surface of pdfmake this file uses, typed locally — the package ships no types. */
interface PdfMake {
  setFonts(fonts: Record<string, Record<string, string>>): void;
  setUrlAccessPolicy(callback: (url: string) => boolean): void;
  setLocalAccessPolicy(callback: (path: string) => boolean): void;
  createPdf(definition: unknown): { getBuffer(): Promise<Buffer> };
}

@Injectable()
export class ReportRendererService {
  private readonly pdfmake: PdfMake;

  constructor() {
    /*
     * `require` rather than an import: pdfmake 0.3 is CommonJS, ships no type declarations and no
     * `exports` map, and is a **singleton** whose fonts and access policies are process-global.
     * Configuring it once, here, in a constructor Nest calls once, is what guarantees no other code
     * path can end up with a renderer whose policies are off.
     *
     * The project compiles to CommonJS (tsconfig `module: nodenext`, `.js` output required by Nest),
     * so this is the ordinary interop path rather than a workaround.
     */
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    this.pdfmake = require('pdfmake') as PdfMake;

    const packageRoot = dirname(require.resolve('pdfmake/package.json'));

    this.pdfmake.setFonts({
      [FONT_FAMILY]: {
        normal: `${packageRoot}/fonts/Roboto/Roboto-Regular.ttf`,
        bold: `${packageRoot}/fonts/Roboto/Roboto-Medium.ttf`,
        italics: `${packageRoot}/fonts/Roboto/Roboto-Italic.ttf`,
        bolditalics: `${packageRoot}/fonts/Roboto/Roboto-MediumItalic.ttf`,
      },
    });

    // No URL is ever acceptable. Not a CDN, not an image host, not a font service.
    this.pdfmake.setUrlAccessPolicy(() => false);
    // The only readable path is pdfmake's own package, which is where the four fonts above live.
    this.pdfmake.setLocalAccessPolicy((path) => path.startsWith(packageRoot));
  }

  /** Renders one report. The Buffer is the whole artefact — nothing is written anywhere. */
  async render(data: ReportData): Promise<Buffer> {
    const kind = data.period.kind === 'monthly' ? 'Monthly report' : 'Weekly report';
    const generated = formatTimestamp(data.generatedAt, data.timeZone);

    const document = this.pdfmake.createPdf({
      pageSize: 'A4',
      pageMargins: [48, 46, 48, 52],
      info: {
        // Metadata a reader can see in their viewer. Deliberately impersonal: no account id, no
        // email, nothing that would out the recipient if the file were forwarded.
        title: `Evergrove ${kind} — ${data.periodLabel}`,
        author: 'Evergrove',
        subject: 'Focus summary',
      },
      defaultStyle: { font: FONT_FAMILY, fontSize: 9.5, color: INK, lineHeight: 1.35 },
      styles: {
        h1: { fontSize: 16, bold: true, color: BRAND },
        h2: { fontSize: 10, bold: true, color: MUTED, characterSpacing: 0.6 },
        muted: { color: MUTED, fontSize: 8.5 },
        statValue: { fontSize: 17, bold: true, color: INK },
        statLabel: { fontSize: 7.5, color: MUTED, characterSpacing: 0.4 },
      },

      footer: (currentPage: number, pageCount: number) => ({
        margin: [48, 12, 48, 0],
        columns: [
          { text: `Evergrove · ${data.periodLabel}`, style: 'muted' },
          {
            text: `Generated ${generated} · page ${currentPage} of ${pageCount}`,
            style: 'muted',
            alignment: 'right',
          },
        ],
      }),

      content: [
        ...this.header(kind, data),
        ...this.summary(data),
        ...this.chart(data),
        ...this.tasks(data),
        ...this.terminations(data),
        ...this.cutOffNote(generated),
      ],
    });

    return document.getBuffer();
  }

  /** A compact header, not a cover page — a cover on a two-page document is a page to get past. */
  private header(kind: string, data: ReportData): unknown[] {
    return [
      {
        columns: [
          { text: 'Evergrove', style: 'h1' },
          { text: kind.toUpperCase(), style: 'h2', alignment: 'right', margin: [0, 5, 0, 0] },
        ],
      },
      {
        text: data.periodLabel,
        fontSize: 13,
        bold: true,
        margin: [0, 10, 0, 0],
      },
      {
        // The timezone is stated, always. Every date in this document is expressed in it, and a
        // reader who travels needs to know which one it was (§27).
        text: `${data.firstName} · all times ${data.timeZone}`,
        style: 'muted',
        margin: [0, 2, 0, 14],
      },
      { canvas: [rule(0, 0, CHART_WIDTH)], margin: [0, 0, 0, 14] },
    ];
  }

  /** Six figures, each against the same figure last period (§27). */
  private summary(data: ReportData): unknown[] {
    const cells = [
      stat(
        'SESSIONS COMPLETED',
        String(data.totals.completedSessions),
        delta(data.totals.completedSessions, data.previousTotals.completedSessions),
      ),
      stat(
        'SESSIONS STOPPED EARLY',
        String(data.totals.terminatedSessions),
        delta(data.totals.terminatedSessions, data.previousTotals.terminatedSessions),
      ),
      stat(
        'TIME FOCUSED',
        formatMinutes(data.totals.focusMinutes),
        delta(data.totals.focusMinutes, data.previousTotals.focusMinutes, 'min'),
      ),
      stat(
        'COMPLETION RATE',
        `${data.totals.completionRate}%`,
        delta(data.totals.completionRate, data.previousTotals.completionRate, 'pp'),
      ),
      stat('LIFETIME POINTS', formatNumber(data.lifetimePoints), null),
      stat(
        'CURRENT STREAK',
        `${data.currentDayStreak} ${data.currentDayStreak === 1 ? 'day' : 'days'}`,
        `best ${data.longestDayStreak}`,
      ),
    ];

    return [
      { columns: cells.slice(0, 3), columnGap: 14 },
      { columns: cells.slice(3, 6), columnGap: 14, margin: [0, 12, 0, 0] },
      {
        text: `Compared with ${data.previousPeriodLabel}.`,
        style: 'muted',
        margin: [0, 10, 0, 16],
      },
    ];
  }

  /**
   * The breakdown, drawn as vector primitives in the document definition.
   *
   * No image is fetched, generated, or rasterised — the bars are rectangles and the labels are text,
   * which is why the chart costs nothing at render time and cannot be a network dependency.
   *
   * Every bar prints its own total above it. §27 forbids relying on colour alone, and a printed
   * report is also the one place a reader cannot hover for a tooltip.
   */
  private chart(data: ReportData): unknown[] {
    const buckets = data.buckets;
    if (buckets.length === 0) return [];

    const peak = Math.max(1, ...buckets.map((bucket) => bucket.completed + bucket.terminated));
    const slot = CHART_WIDTH / buckets.length;
    const barWidth = Math.max(3, slot - BAR_GAP);

    const shapes: unknown[] = [rule(0, CHART_HEIGHT, CHART_WIDTH)];
    const labels: unknown[] = [];

    buckets.forEach((bucket, index) => {
      const x = index * slot + BAR_GAP / 2;
      const completedHeight = (bucket.completed / peak) * (CHART_HEIGHT - 14);
      const terminatedHeight = (bucket.terminated / peak) * (CHART_HEIGHT - 14);

      if (terminatedHeight > 0) {
        shapes.push(
          bar(x, CHART_HEIGHT - terminatedHeight, barWidth, terminatedHeight, TERMINATED_COLOR),
        );
      }
      if (completedHeight > 0) {
        shapes.push(
          bar(
            x,
            CHART_HEIGHT - terminatedHeight - completedHeight,
            barWidth,
            completedHeight,
            COMPLETED_COLOR,
          ),
        );
      }

      labels.push({
        text: [
          { text: `${total(bucket)}\n`, fontSize: 7.5, color: INK },
          { text: bucket.label, fontSize: 7, color: MUTED },
        ],
        width: slot,
        alignment: 'center',
      });
    });

    return [
      { text: 'SESSIONS', style: 'h2', margin: [0, 0, 0, 6] },
      { canvas: shapes },
      { columns: labels, margin: [0, 3, 0, 8] },
      {
        columns: [
          swatch(COMPLETED_COLOR, 'Completed'),
          swatch(TERMINATED_COLOR, 'Stopped early'),
          { text: '', width: '*' },
        ],
        columnGap: 12,
        margin: [0, 0, 0, 18],
      },
    ];
  }

  /** Up to ten rows by focus time, then a count of the rest (P12). */
  private tasks(data: ReportData): unknown[] {
    if (data.tasks.length === 0) {
      return [
        { text: 'TASKS', style: 'h2', margin: [0, 0, 0, 6] },
        {
          text: 'No focus sessions were recorded in this period.',
          style: 'muted',
          margin: [0, 0, 0, 16],
        },
      ];
    }

    const body = [
      [
        { text: 'Task', style: 'statLabel' },
        { text: 'Sessions', style: 'statLabel', alignment: 'right' },
        { text: 'Focused', style: 'statLabel', alignment: 'right' },
      ],
      ...data.tasks.map((task) => [
        // Truncated for layout. The title is user-authored free text and enters as a TEXT NODE in a
        // document definition — never concatenated into markup — so there is no injection surface
        // to sanitise against, only a column width to respect (§26.4).
        { text: truncate(task.title, TASK_TITLE_MAX) },
        { text: String(task.sessions), alignment: 'right' },
        { text: formatMinutes(task.focusMinutes), alignment: 'right' },
      ]),
    ];

    return [
      { text: 'TASKS', style: 'h2', margin: [0, 0, 0, 6] },
      {
        table: { headerRows: 1, widths: ['*', 52, 62], body },
        layout: {
          hLineWidth: (index: number) => (index === 1 ? 0.7 : 0.4),
          vLineWidth: () => 0,
          hLineColor: () => RULE,
          paddingTop: () => 4,
          paddingBottom: () => 4,
          paddingLeft: () => 0,
          paddingRight: () => 0,
        },
      },
      ...(data.remainingTasks > 0
        ? [
            {
              text: `+${data.remainingTasks} more ${data.remainingTasks === 1 ? 'task' : 'tasks'} in this period.`,
              style: 'muted',
              margin: [0, 6, 0, 0],
            },
          ]
        : []),
      { text: '', margin: [0, 0, 0, 16] },
    ];
  }

  /** Counts only, and only when there were any (P10). Never an interpretation — that is N1. */
  private terminations(data: ReportData): unknown[] {
    if (data.terminations.length === 0) return [];

    return [
      { text: 'WHY SESSIONS ENDED EARLY', style: 'h2', margin: [0, 0, 0, 6] },
      {
        columns: data.terminations.map((row) => ({
          text: [
            { text: `${row.count}\n`, fontSize: 12, bold: true },
            { text: REASON_LABELS[row.reason] ?? row.reason, style: 'muted' },
          ],
          width: 'auto',
        })),
        columnGap: 22,
        margin: [0, 0, 0, 16],
      },
    ];
  }

  /**
   * The cut-off sentence (§24.3).
   *
   * The period is frozen when the report is generated, and a session flushed from a week-old outbox
   * afterwards will make the app disagree with this document. The honest answer is to say so rather
   * than to imply the figures are final.
   */
  private cutOffNote(generated: string): unknown[] {
    return [
      { canvas: [rule(0, 0, CHART_WIDTH)], margin: [0, 4, 0, 8] },
      {
        text: `Includes sessions recorded up to ${generated}. Anything synced after that will appear in Evergrove but not in this report.`,
        style: 'muted',
      },
    ];
  }
}

const REASON_LABELS: Record<string, string> = {
  interrupted: 'Interrupted',
  wrong_task: 'Wrong task',
  finished_early: 'Finished early',
  out_of_energy: 'Out of energy',
};

function total(bucket: ReportBucket): number {
  return bucket.completed + bucket.terminated;
}

function bar(x: number, y: number, w: number, h: number, color: string): unknown {
  return { type: 'rect', x, y, w, h, color };
}

function rule(x: number, y: number, width: number): unknown {
  return { type: 'line', x1: x, y1: y, x2: x + width, y2: y, lineWidth: 0.7, lineColor: RULE };
}

function swatch(color: string, label: string): unknown {
  return {
    width: 'auto',
    columns: [
      { canvas: [{ type: 'rect', x: 0, y: 2, w: 8, h: 8, color }], width: 10 },
      { text: label, style: 'muted', width: 'auto' },
    ],
    columnGap: 4,
  };
}

function stat(label: string, value: string, note: string | null): unknown {
  return {
    width: '*',
    stack: [
      { text: label, style: 'statLabel' },
      { text: value, style: 'statValue', margin: [0, 1, 0, 0] },
      ...(note === null ? [] : [{ text: note, style: 'muted' }]),
    ],
  };
}

/** `+3 vs last period`, or `no change`. Signed, so the direction never has to be inferred. */
function delta(current: number, previous: number, unit = ''): string {
  const difference = current - previous;
  if (difference === 0) return 'no change';
  const suffix = unit ? ` ${unit}` : '';
  return `${difference > 0 ? '+' : '−'}${formatNumber(Math.abs(difference))}${suffix} vs last period`;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat(LOCALE).format(value);
}

/** `4h 12m`, `45m`, `0m` — never a bare minute count once it passes an hour. */
function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

/**
 * Every timestamp is formatted with an **explicit `timeZone`**, taken from the account's own row.
 * Never the server's, which is UTC and belongs to nobody (§27).
 */
function formatTimestamp(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat(LOCALE, {
    timeZone,
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(instant);
}

/**
 * Truncate on characters a reader would recognise, not on UTF-16 code units.
 *
 * `slice` would cut an emoji or a surrogate pair in half and emit a lone surrogate; spreading into
 * an array iterates by code point instead. Combining marks can still be separated from their base
 * character, which is a cosmetic edge this deliberately does not chase.
 */
function truncate(value: string, max: number): string {
  const points = [...value];
  return points.length <= max ? value : `${points.slice(0, max - 1).join('')}…`;
}

/** Re-exported so a test can assert the cap without reaching into the domain. */
export { MAX_TASK_ROWS };
export type { ReportTotals };
