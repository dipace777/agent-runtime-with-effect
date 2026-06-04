import { AiError, LanguageModel } from "@effect/ai";
import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai";
import { NodeHttpClient } from "@effect/platform-node";
import { Config, Effect, ExecutionPlan, Layer, Schedule } from "effect";

const generateDadJoke = LanguageModel.generateText({
  prompt: "Tell me one short dad joke.",
});

const shouldRetry = (error: AiError.AiError) =>
  error._tag === "HttpRequestError" ||
  (error._tag === "HttpResponseError" &&
    (error.response.status === 408 ||
      error.response.status === 409 ||
      error.response.status === 429 ||
      error.response.status >= 500));

const DadJokePlan = ExecutionPlan.make({
  provide: OpenAiLanguageModel.model("gpt-4o"),
  attempts: 3,
  schedule: Schedule.exponential("100 millis", 1.5),
  while: shouldRetry,
});

const main = Effect.gen(function* () {
  const response = yield* generateDadJoke;
  console.log(response.text);
}).pipe(Effect.withExecutionPlan(DadJokePlan));

const OpenAi = OpenAiClient.layerConfig({
  apiKey: Config.redacted("OPENAI_API_KEY"),
}).pipe(Layer.provide(NodeHttpClient.layerUndici));

main.pipe(Effect.provide([OpenAi]), Effect.runPromise);
