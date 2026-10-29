import { Controller, Get, Injectable, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { NestExpressApplication } from "@nestjs/platform-express";
import { createServer, Server } from "http";
import request from "supertest";
import { CompleteTraceEventNode } from "../interfaces/trace-events.interfaces.js";
import { createObserveModule } from "../observe.module.js";
import {
  CollectedSnapshots,
  collectSnapshots,
  freePort,
  testObserveOptions,
  waitForSnapshot,
} from "../testing/observe-harness.js";

const { ObserveModule, ObserveInstrument } = createObserveModule();

/** A model provider on a local port, which the module is told to read. */
let providerUrl = "";
/** The same server under a host the module is not told about. */
let otherUrl = "";
/** Set when the provider's streaming response is closed before it finished. */
let streamClosedEarly = false;

const COMPLETION = {
  id: "chatcmpl-1",
  model: "gpt-4o-mini-2024-07-18",
  choices: [{ message: { role: "assistant", content: "Paris." } }],
  usage: {
    prompt_tokens: 25,
    completion_tokens: 3,
    prompt_tokens_details: { cached_tokens: 10 },
  },
};

const STREAM_EVENTS = [
  `data: {"model":"gpt-4o-mini-2024-07-18","choices":[{"delta":{"content":"Pa"}}],"usage":null}\n\n`,
  `data: {"model":"gpt-4o-mini-2024-07-18","choices":[{"delta":{"content":"ris."}}],"usage":null}\n\n`,
  `data: {"model":"gpt-4o-mini-2024-07-18","choices":[],"usage":{"prompt_tokens":25,"completion_tokens":2}}\n\n`,
  `data: [DONE]\n\n`,
];

@Injectable()
class AssistantService {
  async ask() {
    const response = await fetch(`${providerUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o-mini", messages: [] }),
    });
    return response.json();
  }

  async stream() {
    const response = await fetch(`${providerUrl}/v1/chat/completions?stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o-mini", stream: true }),
    });
    return response.text();
  }

  /** Reads the first event, then walks away from the stream. */
  async abandon() {
    const response = await fetch(`${providerUrl}/v1/slow-stream`, {
      method: "POST",
      body: JSON.stringify({ model: "gpt-4o-mini", stream: true }),
    });
    const reader = response.body!.getReader();
    const first = await reader.read();
    await reader.cancel();
    return new TextDecoder().decode(first.value);
  }

  async refused() {
    const response = await fetch(`${providerUrl}/v1/refuse`, {
      method: "POST",
      body: JSON.stringify({ model: "gpt-4o-mini" }),
    });
    return { status: response.status, body: await response.json() };
  }

  async elsewhere() {
    const response = await fetch(`${otherUrl}/v1/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ model: "gpt-4o-mini" }),
    });
    return response.json();
  }
}

@Controller()
class AssistantController {
  constructor(private readonly assistant: AssistantService) {}

  @Get("ask")
  ask() {
    return this.assistant.ask();
  }

  @Get("stream")
  async stream() {
    return { text: await this.assistant.stream() };
  }

  @Get("abandon")
  async abandon() {
    return { first: await this.assistant.abandon() };
  }

  @Get("refused")
  refused() {
    return this.assistant.refused();
  }

  @Get("elsewhere")
  elsewhere() {
    return this.assistant.elsewhere();
  }
}

const httpSpans = (nodes: CompleteTraceEventNode[]): CompleteTraceEventNode[] =>
  nodes.flatMap((node) => [
    ...(node.className === "http" ? [node] : []),
    ...httpSpans(node.children ?? []),
  ]);

/**
 * Model calls, end to end: a real `fetch` to a server answering the way
 * OpenAI does, read as the response passes through to the application. What
 * is being proven is that the application gets exactly what it would have
 * got - the same bytes, the same streaming, a cancel that still reaches the
 * provider - and that the model and tokens land on the call's outbound span.
 */
describe("ObserveModule: model calls", () => {
  let app: NestExpressApplication;
  let collected: CollectedSnapshots;
  let provider: Server;

  beforeAll(async () => {
    provider = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        if (req.url === "/v1/chat/completions") {
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(COMPLETION));
          return;
        }
        if (req.url === "/v1/refuse") {
          res.statusCode = 429;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ error: { message: "Rate limit" } }));
          return;
        }
        res.setHeader("content-type", "text/event-stream");
        if (req.url === "/v1/slow-stream") {
          let sent = 0;
          const timer = setInterval(() => {
            res.write(STREAM_EVENTS[0]);
            sent += 1;
            if (sent === 40) {
              clearInterval(timer);
              res.end();
            }
          }, 25);
          res.on("close", () => {
            if (sent < 40) {
              streamClosedEarly = true;
            }
            clearInterval(timer);
          });
          return;
        }
        let index = 0;
        const next = () => {
          if (index === STREAM_EVENTS.length) {
            res.end();
            return;
          }
          res.write(STREAM_EVENTS[index++]);
          setTimeout(next, 10);
        };
        next();
      });
    });
    const port = await freePort();
    await new Promise<void>((resolve) =>
      provider.listen(port, "127.0.0.1", resolve),
    );
    providerUrl = `http://127.0.0.1:${port}`;
    otherUrl = `http://localhost:${port}`;

    @Module({
      imports: [
        ObserveModule.forRoot(
          testObserveOptions({
            outgoing: { llm: { hosts: [`127.0.0.1:${port}`] } },
          }),
        ),
      ],
      controllers: [AssistantController],
      providers: [AssistantService],
    })
    class LlmTestModule {}

    app = await NestFactory.create<NestExpressApplication>(LlmTestModule, {
      instrument: ObserveInstrument,
      logger: false,
    });
    collected = collectSnapshots(app);
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    provider.closeAllConnections();
    await new Promise((resolve) => provider.close(resolve));
  });

  beforeEach(() => collected.clear());

  it("reports a JSON completion's model and tokens, and hands the body over intact", async () => {
    const { body } = await request(app.getHttpServer()).get("/ask").expect(200);
    expect(body).toEqual(COMPLETION);

    const snapshot = await waitForSnapshot(
      collected,
      (item) => item.operationId === "/ask",
    );
    const [span] = httpSpans(snapshot.traces as CompleteTraceEventNode[]);
    expect(span.tags).toMatchObject({
      "http.method": "POST",
      "llm.provider": "custom",
      "llm.model": "gpt-4o-mini-2024-07-18",
      "llm.input_tokens": 25,
      "llm.output_tokens": 3,
      "llm.cached_input_tokens": 10,
    });
    expect(span.tags).not.toHaveProperty("llm.stream");
    expect(span.duration).toBeGreaterThan(0);
    expect(span.error).toBeUndefined();
    // Nothing the model said is reported.
    expect(JSON.stringify(snapshot)).not.toContain("Paris");
  });

  it("reads a stream's final usage while the application reads the stream", async () => {
    const { body } = await request(app.getHttpServer())
      .get("/stream")
      .expect(200);
    expect(body.text).toBe(STREAM_EVENTS.join(""));

    const snapshot = await waitForSnapshot(
      collected,
      (item) => item.operationId === "/stream",
    );
    const [span] = httpSpans(snapshot.traces as CompleteTraceEventNode[]);
    expect(span.tags).toMatchObject({
      "llm.provider": "custom",
      "llm.model": "gpt-4o-mini-2024-07-18",
      "llm.input_tokens": 25,
      "llm.output_tokens": 2,
      "llm.stream": true,
    });
    const firstToken = span.tags!["llm.time_to_first_token_ms"] as number;
    expect(firstToken).toBeGreaterThanOrEqual(0);
    // The span keeps the call's own duration, though it was held open while
    // the stream was read.
    expect(span.duration).toBeGreaterThan(0);
    expect(firstToken).toBeLessThanOrEqual(span.duration + 1);
  });

  it("cancels the provider's stream when the application cancels its own", async () => {
    streamClosedEarly = false;
    const { body } = await request(app.getHttpServer())
      .get("/abandon")
      .expect(200);
    expect(body.first).toBe(STREAM_EVENTS[0]);

    const snapshot = await waitForSnapshot(
      collected,
      (item) => item.operationId === "/abandon",
    );
    const [span] = httpSpans(snapshot.traces as CompleteTraceEventNode[]);
    expect(span.tags).toMatchObject({ "llm.provider": "custom" });
    await vi.waitFor(() => expect(streamClosedEarly).toBe(true), {
      timeout: 2000,
    });
  });

  it("tags a refused call with its model, and no usage", async () => {
    const { body } = await request(app.getHttpServer())
      .get("/refused")
      .expect(200);
    expect(body).toEqual({
      status: 429,
      body: { error: { message: "Rate limit" } },
    });

    const snapshot = await waitForSnapshot(
      collected,
      (item) => item.operationId === "/refused",
    );
    const [span] = httpSpans(snapshot.traces as CompleteTraceEventNode[]);
    // The model the request named, since the error response names none.
    expect(span.tags).toMatchObject({
      "llm.provider": "custom",
      "llm.model": "gpt-4o-mini",
    });
    expect(span.tags).not.toHaveProperty("llm.input_tokens");
  });

  it("leaves calls to any other host as plain outbound spans", async () => {
    await request(app.getHttpServer()).get("/elsewhere").expect(200);

    const snapshot = await waitForSnapshot(
      collected,
      (item) => item.operationId === "/elsewhere",
    );
    const [span] = httpSpans(snapshot.traces as CompleteTraceEventNode[]);
    expect(
      Object.keys(span.tags ?? {}).some((key) => key.startsWith("llm.")),
    ).toBe(false);
  });
});
