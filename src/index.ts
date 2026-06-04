import { AiError } from "@effect/ai";
import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai";
import { NodeHttpClient } from "@effect/platform-node";
import { Config, Effect, ExecutionPlan, Layer, Schedule } from "effect";
import {
  generateSlideDeck,
  SlideAgentParseError,
  type GenerateSlideDeckInput,
} from "./slides-agent/index.ts";
import { generatePptx } from "./slides-agent/generate-pptx.ts";

type Stdin = {
  readonly isTTY?: boolean;
  setEncoding: (encoding: string) => void;
  on(event: "data", listener: (chunk: string) => void): Stdin;
  on(event: "end", listener: () => void): Stdin;
  resume: () => void;
};

type NodeProcess = {
  readonly argv: string[];
  readonly stdin: Stdin;
  exitCode?: number;
};

type CliInput = GenerateSlideDeckInput & {
  readonly help: boolean;
  readonly json: boolean;
  readonly output: string;
};

const nodeProcess = (
  globalThis as typeof globalThis & { readonly process?: NodeProcess }
).process;

const usage = `
Usage:
  pnpm run dev -- "Create a pitch deck for an AI meeting notes app"
  pnpm run dev -- --slides 8 --out investor-deck.pptx --audience "seed investors" --style "crisp SaaS" "Pitch our analytics product"

You can also pipe a prompt:
  echo "Teach product managers the basics of AI evals" | pnpm run dev
`.trim();

function parseCliArgs(argv: ReadonlyArray<string>): CliInput {
  const rest: string[] = [];
  let slideCount: number | undefined;
  let audience: string | undefined;
  let style: string | undefined;
  let output = "presentation.pptx";
  let json = false;
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) continue;

    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--slides") {
      const value = argv[index + 1];
      index += 1;
      slideCount = value ? Number(value) : undefined;
    } else if (arg.startsWith("--slides=")) {
      slideCount = Number(arg.slice("--slides=".length));
    } else if (arg === "--audience") {
      audience = argv[index + 1];
      index += 1;
    } else if (arg.startsWith("--audience=")) {
      audience = arg.slice("--audience=".length);
    } else if (arg === "--style") {
      style = argv[index + 1];
      index += 1;
    } else if (arg.startsWith("--style=")) {
      style = arg.slice("--style=".length);
    } else if (arg === "--out" || arg === "--output") {
      output = argv[index + 1] ?? output;
      index += 1;
    } else if (arg.startsWith("--out=")) {
      output = arg.slice("--out=".length);
    } else if (arg.startsWith("--output=")) {
      output = arg.slice("--output=".length);
    } else {
      rest.push(arg);
    }
  }

  return {
    prompt: rest.join(" ").trim(),
    slideCount: Number.isFinite(slideCount) ? slideCount : undefined,
    audience,
    style,
    output: normalizePptxPath(output),
    json,
    help,
  };
}

function normalizePptxPath(path: string): string {
  const trimmed = path.trim() || "presentation.pptx";
  return trimmed.toLowerCase().endsWith(".pptx") ? trimmed : `${trimmed}.pptx`;
}

function readStdin(stdin: Stdin): Promise<string> {
  if (stdin.isTTY) return Promise.resolve("");

  return new Promise((resolve) => {
    let value = "";
    stdin.setEncoding("utf8");
    stdin.on("data", (chunk) => {
      value += chunk;
    });
    stdin.on("end", () => resolve(value.trim()));
    stdin.resume();
  });
}

async function readCliInput(): Promise<CliInput> {
  if (!nodeProcess) {
    return { prompt: "", output: "presentation.pptx", json: false, help: true };
  }

  const parsed = parseCliArgs(nodeProcess.argv.slice(2));
  if (parsed.prompt || parsed.help) return parsed;

  return {
    ...parsed,
    prompt: await readStdin(nodeProcess.stdin),
  };
}

const isRetryableAiError = (error: AiError.AiError | SlideAgentParseError) =>
  error._tag === "HttpRequestError" ||
  (error._tag === "HttpResponseError" &&
    (error.response.status === 408 ||
      error.response.status === 409 ||
      error.response.status === 429 ||
      error.response.status >= 500));

const SlideAgentPlan = ExecutionPlan.make({
  provide: OpenAiLanguageModel.model("gpt-4o"),
  attempts: 3,
  schedule: Schedule.exponential("100 millis", 1.5),
  while: isRetryableAiError,
});

const OpenAi = OpenAiClient.layerConfig({
  apiKey: Config.redacted("OPENAI_API_KEY"),
}).pipe(Layer.provide(NodeHttpClient.layerUndici));

function reportSlideAgentParseError(error: SlideAgentParseError): void {
  console.error(error.reason);
  for (const issue of error.issues.slice(0, 12)) {
    console.error(`- ${issue}`);
  }

  if (error.issues.length > 12) {
    console.error(`- ...and ${error.issues.length - 12} more issues`);
  }

  if (error.raw.trim()) {
    console.error("\nRaw model output preview:");
    console.error(error.raw.slice(0, 1200));
  }
}

const main = Effect.gen(function* () {
  const input = yield* Effect.promise(readCliInput);

  if (input.help || !input.prompt.trim()) {
    console.log(usage);
    return;
  }

  const deck = yield* generateSlideDeck(input);
  yield* Effect.promise(() => generatePptx(deck, input.output));

  if (input.json) {
    console.log(JSON.stringify(deck, null, 2));
  }

  console.log(`Wrote ${input.output}`);
}).pipe(
  Effect.withExecutionPlan(SlideAgentPlan),
  Effect.provide([OpenAi]),
  Effect.catchTag("SlideAgentParseError", (error) =>
    Effect.sync(() => {
      reportSlideAgentParseError(error);
      if (nodeProcess) nodeProcess.exitCode = 1;
    }),
  ),
);

Effect.runPromise(main).catch((error: unknown) => {
  console.error(error);
  if (nodeProcess) nodeProcess.exitCode = 1;
});
