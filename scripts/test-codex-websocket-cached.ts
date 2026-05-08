#!/usr/bin/env bun
const HOME = process.env.HOME ?? "";
const PI_AI_PROVIDER_PATH = process.env.PI_AI_OPENAI_CODEX_RESPONSES_PATH ?? `${HOME}/.bun/install/global/node_modules/@earendil-works/pi-ai/dist/providers/openai-codex-responses.js`;
const { streamOpenAICodexResponses, closeOpenAICodexWebSocketSessions } = await import(PI_AI_PROVIDER_PATH);

type AssistantMessage = any;
type Context = any;
type Model<T = any> = any;

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function fakeJwt(payload: Record<string, unknown>) {
  const b64 = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  return `${b64({ alg: "none", typ: "JWT" })}.${b64(payload)}.`;
}

async function freePort() {
  const server = Bun.serve({ port: 0, fetch: () => new Response("ok") });
  const port = server.port;
  server.stop(true);
  return port;
}

async function collect(stream: ReturnType<typeof streamOpenAICodexResponses>): Promise<AssistantMessage> {
  let message: AssistantMessage | undefined;
  for await (const event of stream) {
    if (event.type === "done") message = event.message;
    if (event.type === "error") throw new Error(event.error.errorMessage ?? "stream error");
  }
  if (!message) throw new Error("no done event");
  return message;
}

const port = await freePort();
const requests: any[] = [];
let responseSeq = 0;

const server = Bun.serve<{ id: number }>({
  host: "127.0.0.1",
  port,
  fetch(req, server) {
    const url = new URL(req.url);
    if (url.pathname === "/__requests") return Response.json(requests);
    if (url.pathname !== "/codex/responses") return new Response("not found", { status: 404 });
    if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("expected ws", { status: 426 });
    return server.upgrade(req, { data: { id: ++responseSeq } }) ? undefined : new Response("upgrade failed", { status: 400 });
  },
  websocket: {
    message(ws, msg) {
      const request = JSON.parse(String(msg));
      requests.push(request);
      const id = `resp_cached_${ws.data.id}`;
      const text = `cached-ok-${ws.data.id}`;
      ws.send(JSON.stringify({ type: "response.created", response: { id } }));
      ws.send(JSON.stringify({ type: "response.output_item.added", item: { id: `msg_${ws.data.id}`, type: "message", role: "assistant", content: [] } }));
      ws.send(JSON.stringify({ type: "response.content_part.added", part: { type: "output_text", text: "", annotations: [] } }));
      ws.send(JSON.stringify({ type: "response.output_text.delta", delta: text }));
      ws.send(JSON.stringify({ type: "response.output_item.done", item: { id: `msg_${ws.data.id}`, type: "message", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] } }));
      ws.send(JSON.stringify({ type: "response.completed", response: { id, status: "completed", usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12, input_tokens_details: { cached_tokens: 3 } } } }));
    },
  },
});

try {
  const apiKey = fakeJwt({ "https://api.openai.com/auth": { chatgpt_account_id: "cached-test-account" } });
  const model: Model<any> = {
    id: "gpt-5.3-codex",
    name: "cached test",
    api: "openai-codex-responses",
    provider: "openai",
    baseUrl: `http://127.0.0.1:${port}`,
    reasoning: false,
    input: ["text"],
    contextWindow: 128000,
    maxTokens: 4096,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };

  const sessionId = "cached-session-1";
  const context1: Context = {
    systemPrompt: "You are concise.",
    messages: [{ role: "user", content: [{ type: "text", text: "first" }], timestamp: Date.now() }],
    tools: [],
  };
  const msg1 = await collect(streamOpenAICodexResponses(model, context1, { apiKey, sessionId, transport: "websocket-cached" }));
  const context2: Context = {
    ...context1,
    messages: [...context1.messages, msg1, { role: "user", content: [{ type: "text", text: "second" }], timestamp: Date.now() }],
  };
  await collect(streamOpenAICodexResponses(model, context2, { apiKey, sessionId, transport: "websocket-cached" }));

  assert(requests.length === 2, `expected 2 WS response.create frames, got ${requests.length}`);
  assert(!requests[0].previous_response_id, "first request unexpectedly used previous_response_id");
  assert(requests[1].previous_response_id === "resp_cached_1", `second request did not use previous_response_id: ${requests[1].previous_response_id}`);
  assert((requests[1].input?.length ?? 0) < (requests[0].input?.length ?? 0) + 2, "second request did not look delta-sized");
  console.log(JSON.stringify({ ok: true, firstInputItems: requests[0].input?.length, secondInputItems: requests[1].input?.length, previous_response_id: requests[1].previous_response_id }, null, 2));
} finally {
  closeOpenAICodexWebSocketSessions?.();
  server.stop(true);
}
