import { AiError, LanguageModel } from "@effect/ai";
import { Data, Effect } from "effect";
import { z } from "zod";
import {
  DeckSchema,
  SLIDE_H,
  SLIDE_W,
  type ChartType,
  type Deck,
  type DeckTheme,
  type Slide,
  type SlideElement,
} from "./slide-schema.ts";

export type GenerateSlideDeckInput = {
  readonly prompt: string;
  readonly slideCount?: number | undefined;
  readonly audience?: string | undefined;
  readonly style?: string | undefined;
};

type NormalizedSlideDeckInput = {
  readonly prompt: string;
  readonly slideCount: number;
  readonly audience?: string | undefined;
  readonly style?: string | undefined;
};

export class SlideAgentParseError extends Data.TaggedError(
  "SlideAgentParseError",
)<{
  readonly reason: string;
  readonly raw: string;
  readonly issues: ReadonlyArray<string>;
}> {}

const DEFAULT_SLIDE_COUNT = 6;

const DEFAULT_THEME: DeckTheme = {
  background: "F7F9FC",
  surface: "FFFFFF",
  primary: "0B1F3A",
  secondary: "335C81",
  accent: "D4A24C",
  text: "1A2B45",
  muted: "6A7894",
};

const OutlineChartSchema = z
  .object({
    title: z.string().min(1).max(80).nullish(),
    type: z.enum(["bar", "line", "donut"]).catch("bar").nullish(),
    data: z
      .array(
        z.object({
          label: z.string().min(1).max(40),
          value: z.coerce.number().min(0).max(1_000_000),
        }),
      )
      .min(1)
      .max(6)
      .nullish(),
  })
  .nullish();

const OutlineTableSchema = z
  .object({
    columns: z.array(z.string().min(1).max(40)).min(2).max(4),
    rows: z
      .array(z.array(z.string().max(60)).min(2).max(4))
      .min(1)
      .max(5),
  })
  .nullish();

const OutlineSlideSchema = z.object({
  title: z.string().min(1).max(80),
  subtitle: z.string().max(220).optional().nullable(),
  bullets: z.array(z.string().min(1).max(180)).min(1).max(6),
  chart: OutlineChartSchema,
  table: OutlineTableSchema,
});

const OutlineSchema = z.object({
  title: z.string().min(1).max(90),
  description: z.string().max(1200).nullish(),
  theme: z
    .object({
      background: z.string().nullish(),
      surface: z.string().nullish(),
      primary: z.string().nullish(),
      secondary: z.string().nullish(),
      accent: z.string().nullish(),
      text: z.string().nullish(),
      muted: z.string().nullish(),
    })
    .nullish(),
  slides: z.array(OutlineSlideSchema).min(1).max(12),
});

type Outline = z.infer<typeof OutlineSchema>;
type OutlineSlide = z.infer<typeof OutlineSlideSchema>;

function normalizeInput(input: GenerateSlideDeckInput): NormalizedSlideDeckInput {
  const prompt = input.prompt.trim();
  const slideCount = Math.max(
    1,
    Math.min(12, Math.trunc(input.slideCount ?? DEFAULT_SLIDE_COUNT)),
  );

  return {
    prompt,
    slideCount,
    audience: input.audience?.trim() || undefined,
    style: input.style?.trim() || undefined,
  };
}

function buildOutlinePrompt(input: NormalizedSlideDeckInput): string {
  const audience = input.audience
    ? `Audience: ${input.audience}`
    : "Audience: general professional audience";
  const style = input.style
    ? `Visual style: ${input.style}`
    : "Visual style: clean, modern, professional SaaS pitch deck";

  return `
You are an expert presentation strategist.

Create a concise slide deck outline as JSON.

User request:
${input.prompt}

${audience}
${style}
Slide count: exactly ${input.slideCount}

Return only valid JSON. Do not use markdown.

Use this exact JSON shape:
{
  "title": "Deck title",
  "description": "One-sentence deck description",
  "theme": {
    "background": "F7F9FC",
    "surface": "FFFFFF",
    "primary": "0B1F3A",
    "secondary": "335C81",
    "accent": "D4A24C",
    "text": "1A2B45",
    "muted": "6A7894"
  },
  "slides": [
    {
      "title": "Slide headline",
      "subtitle": "Optional short supporting sentence",
      "bullets": ["3 to 5 concise bullets"],
      "chart": {
        "title": "Optional chart title",
        "type": "bar",
        "data": [{ "label": "Before", "value": 10 }, { "label": "After", "value": 30 }]
      },
      "table": {
        "columns": ["Metric", "Value"],
        "rows": [["Speed", "2x"]]
      }
    }
  ]
}

Rules:
- slides must contain exactly ${input.slideCount} items.
- Every slide must have title and bullets.
- Include chart on 1-2 slides when numbers are helpful, otherwise use null or omit it.
- Include table only when comparison is useful, otherwise use null or omit it.
- Use only 6-digit hex colors without "#".
- Keep bullets specific, business-useful, and short.
`.trim();
}

function buildRepairPrompt(
  input: NormalizedSlideDeckInput,
  raw: string,
  error: SlideAgentParseError,
): string {
  return `
Repair this slide deck outline JSON.

Original request:
${input.prompt}

Required slide count: exactly ${input.slideCount}

Validation issues:
${error.issues.map((issue) => `- ${issue}`).join("\n") || `- ${error.reason}`}

Return only corrected JSON matching the outline shape. Do not use markdown.

Invalid output:
${raw}
`.trim();
}

function extractJsonObject(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1] ?? raw;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");

  if (start < 0 || end < start) {
    throw new SlideAgentParseError({
      reason: "Model output did not contain a JSON object.",
      raw,
      issues: [],
    });
  }

  return candidate.slice(start, end + 1);
}

function parseOutline(
  raw: string,
): Effect.Effect<Outline, SlideAgentParseError> {
  return Effect.try({
    try: () => {
      const json = extractJsonObject(raw);
      const decoded = JSON.parse(json) as unknown;
      const parsed = OutlineSchema.safeParse(decoded);

      if (!parsed.success) {
        throw new SlideAgentParseError({
          reason: "Model output did not match the slide outline schema.",
          raw,
          issues: parsed.error.issues.map((issue) => {
            const path = issue.path.length ? issue.path.join(".") : "<root>";
            return `${path}: ${issue.message}`;
          }),
        });
      }

      return parsed.data;
    },
    catch: (cause) =>
      cause instanceof SlideAgentParseError
        ? cause
        : new SlideAgentParseError({
            reason:
              cause instanceof Error
                ? cause.message
                : "Failed to parse model output.",
            raw,
            issues: [],
          }),
  });
}

export function parseSlideDeck(
  raw: string,
): Effect.Effect<Deck, SlideAgentParseError> {
  return Effect.try({
    try: () => {
      const json = extractJsonObject(raw);
      const decoded = JSON.parse(json) as unknown;
      const parsed = DeckSchema.safeParse(decoded);

      if (!parsed.success) {
        throw new SlideAgentParseError({
          reason: "Model output did not match the slide deck schema.",
          raw,
          issues: parsed.error.issues.map((issue) => {
            const path = issue.path.length ? issue.path.join(".") : "<root>";
            return `${path}: ${issue.message}`;
          }),
        });
      }

      return parsed.data;
    },
    catch: (cause) =>
      cause instanceof SlideAgentParseError
        ? cause
        : new SlideAgentParseError({
            reason:
              cause instanceof Error
                ? cause.message
                : "Failed to parse model output.",
            raw,
            issues: [],
          }),
  });
}

function normalizeHex(value: string | null | undefined, fallback: string): string {
  const normalized = value?.replace(/^#/, "").trim().toUpperCase();
  return normalized && /^[0-9A-F]{6}$/.test(normalized) ? normalized : fallback;
}

function themeFromOutline(outline: Outline): DeckTheme {
  return {
    background: normalizeHex(outline.theme?.background, DEFAULT_THEME.background),
    surface: normalizeHex(outline.theme?.surface, DEFAULT_THEME.surface ?? "FFFFFF"),
    primary: normalizeHex(outline.theme?.primary, DEFAULT_THEME.primary),
    secondary: normalizeHex(outline.theme?.secondary, DEFAULT_THEME.secondary),
    accent: normalizeHex(outline.theme?.accent, DEFAULT_THEME.accent),
    text: normalizeHex(outline.theme?.text, DEFAULT_THEME.text),
    muted: normalizeHex(outline.theme?.muted, DEFAULT_THEME.muted ?? "6A7894"),
  };
}

function normalizeSlides(outline: Outline, input: NormalizedSlideDeckInput) {
  const slides = outline.slides.slice(0, input.slideCount);

  while (slides.length < input.slideCount) {
    slides.push({
      title:
        slides.length === input.slideCount - 1
          ? "Next Steps"
          : `Key Point ${slides.length + 1}`,
      subtitle: "A focused slide generated from the original request.",
      bullets: [
        "Clarify the core problem",
        "Show the proposed solution",
        "Connect the idea to measurable outcomes",
      ],
    });
  }

  return slides;
}

function textElement(
  text: string,
  x: number,
  y: number,
  width: number,
  height: number,
  font: {
    size: number;
    color: string;
    bold?: boolean;
    lineHeight?: number;
  },
): SlideElement {
  return {
    type: "text",
    position: { x, y },
    size: { width, height },
    alignment: { horizontal: "left", vertical: "top" },
    runs: [
      {
        text,
        font: {
          family: "Arial",
          size: font.size,
          color: font.color,
          bold: font.bold,
          lineHeight: font.lineHeight,
          wrap: "word",
        },
      },
    ],
  };
}

function textListElement(
  bullets: ReadonlyArray<string>,
  theme: DeckTheme,
  x: number,
  y: number,
  width: number,
  height: number,
): SlideElement {
  return {
    type: "text-list",
    position: { x, y },
    size: { width, height },
    font: {
      family: "Arial",
      size: 15,
      color: theme.text,
      lineHeight: 1.25,
      wrap: "word",
    },
    marker: "bullet",
    items: bullets.slice(0, 5).map((text) => ({ type: "text", text })),
  };
}

function chartElement(slide: OutlineSlide, theme: DeckTheme): SlideElement | null {
  const chart = slide.chart;
  if (!chart?.data?.length) return null;

  return {
    type: "chart",
    position: { x: 5.55, y: 1.48 },
    size: { width: 3.75, height: 2.8 },
    chartType: (chart.type ?? "bar") as ChartType,
    title: chart.title ?? slide.title,
    color: theme.accent,
    axisColor: theme.muted ?? "6A7894",
    labelColor: theme.text,
    showValues: true,
    data: chart.data.slice(0, 6).map((datum, index) => ({
      label: datum.label,
      value: datum.value,
      color:
        index % 3 === 0
          ? theme.accent
          : index % 3 === 1
            ? theme.secondary
            : theme.primary,
    })),
  };
}

function tableElement(slide: OutlineSlide, theme: DeckTheme): SlideElement | null {
  const table = slide.table;
  if (!table) return null;

  return {
    type: "table",
    position: { x: 5.45, y: 1.45 },
    size: { width: 3.9, height: 2.8 },
    font: {
      family: "Arial",
      size: 9,
      color: theme.text,
    },
    columns: table.columns.slice(0, 4).map((text) => ({
      text,
      fill: { color: theme.primary },
      font: { color: "FFFFFF", bold: true, size: 9 },
      stroke: { color: theme.primary, width: 0.5 },
    })),
    rows: table.rows.slice(0, 5).map((row) =>
      row.slice(0, 4).map((text) => ({
        text,
        fill: { color: theme.surface ?? "FFFFFF" },
        stroke: { color: "D9E2EF", width: 0.5 },
      })),
    ),
  };
}

function calloutElement(slide: OutlineSlide, theme: DeckTheme): SlideElement {
  const takeaway = slide.bullets[0] ?? slide.subtitle ?? slide.title;
  return {
    type: "container",
    position: { x: 5.55, y: 1.55 },
    size: { width: 3.7, height: 2.65 },
    fill: { color: theme.surface ?? "FFFFFF", opacity: 0.96 },
    stroke: { color: theme.accent, width: 1.1, opacity: 0.9 },
    borderRadius: { tl: 0.08, tr: 0.08, bl: 0.08, br: 0.08 },
    padding: { top: 0.16, right: 0.16, bottom: 0.16, left: 0.16 },
    child: textElement(takeaway, 5.75, 1.85, 3.25, 1.55, {
      size: 20,
      color: theme.primary,
      bold: true,
      lineHeight: 1.15,
    }),
  };
}

function slideFromOutline(
  outlineSlide: OutlineSlide,
  index: number,
  theme: DeckTheme,
): Slide {
  const elements: SlideElement[] = [
    {
      type: "rectangle",
      position: { x: 0, y: 0 },
      size: { width: SLIDE_W, height: 0.16 },
      fill: { color: index === 0 ? theme.accent : theme.primary },
      stroke: { color: index === 0 ? theme.accent : theme.primary, width: 0 },
    },
    textElement(outlineSlide.title, 0.55, 0.42, 8.85, 0.54, {
      size: index === 0 ? 28 : 23,
      color: theme.primary,
      bold: true,
      lineHeight: 1.05,
    }),
  ];

  if (outlineSlide.subtitle) {
    elements.push(
      textElement(outlineSlide.subtitle, 0.58, 1.02, 8.2, 0.36, {
        size: 12,
        color: theme.muted ?? "6A7894",
        lineHeight: 1.1,
      }),
    );
  }

  elements.push(
    textListElement(
      outlineSlide.bullets,
      theme,
      0.78,
      outlineSlide.subtitle ? 1.58 : 1.25,
      4.25,
      3.35,
    ),
  );

  elements.push(
    chartElement(outlineSlide, theme) ??
      tableElement(outlineSlide, theme) ??
      calloutElement(outlineSlide, theme),
  );

  elements.push(
    textElement(`${index + 1}`, 9.35, 5.22, 0.25, 0.18, {
      size: 7,
      color: theme.muted ?? "6A7894",
    }),
  );

  return {
    background: theme.background,
    title: outlineSlide.title,
    elements,
  };
}

function deckFromOutline(
  outline: Outline,
  input: NormalizedSlideDeckInput,
): Deck {
  const theme = themeFromOutline(outline);
  const deck: Deck = {
    title: outline.title,
    description: outline.description ?? input.prompt,
    theme,
    slides: normalizeSlides(outline, input).map((slide, index) =>
      slideFromOutline(slide, index, theme),
    ),
  };

  const parsed = DeckSchema.safeParse(deck);
  if (!parsed.success) {
    throw new SlideAgentParseError({
      reason: "Generated outline could not be rendered into a valid deck.",
      raw: JSON.stringify(deck),
      issues: parsed.error.issues.map((issue) => {
        const path = issue.path.length ? issue.path.join(".") : "<root>";
        return `${path}: ${issue.message}`;
      }),
    });
  }

  return parsed.data;
}

export function generateSlideDeck(
  input: GenerateSlideDeckInput,
): Effect.Effect<
  Deck,
  AiError.AiError | SlideAgentParseError,
  LanguageModel.LanguageModel
> {
  const normalized = normalizeInput(input);

  return Effect.gen(function* () {
    const response = yield* LanguageModel.generateText({
      prompt: buildOutlinePrompt(normalized),
      toolChoice: "none",
    });

    const outline = yield* parseOutline(response.text).pipe(
      Effect.catchTag("SlideAgentParseError", (error) =>
        LanguageModel.generateText({
          prompt: buildRepairPrompt(normalized, response.text, error),
          toolChoice: "none",
        }).pipe(Effect.flatMap((repair) => parseOutline(repair.text))),
      ),
    );

    return yield* Effect.try({
      try: () => deckFromOutline(outline, normalized),
      catch: (cause) =>
        cause instanceof SlideAgentParseError
          ? cause
          : new SlideAgentParseError({
              reason:
                cause instanceof Error
                  ? cause.message
                  : "Failed to render slide outline.",
              raw: response.text,
              issues: [],
            }),
    });
  });
}

export const SlidesAgent = {
  generateSlideDeck,
  parseSlideDeck,
} as const;
