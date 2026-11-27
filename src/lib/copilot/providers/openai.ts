import OpenAI, { AzureOpenAI } from "openai";
import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions";
import type { Connection, ProviderAdapter, ToolCall, Turn, TurnOutcome, TurnRequest } from "@/lib/copilot/types";
import { jsonHider, textToolCalls } from "@/lib/copilot/providers/text-tool-calls";

/**
 * OpenAI's Chat Completions, through its official SDK — from OpenAI, an Azure OpenAI resource (the model
 * named is the deployment), or any server that speaks the same API: vLLM, Ollama, Deskzo's own GPU. A
 * streamed turn with our tools as functions. Arguments arrive as a JSON string; they are parsed here and
 * checked against the tool's schema before anything runs (src/lib/copilot/tools.ts), like every provider's.
 */

export function messagesFor(system: string, history: Turn[]): ChatCompletionMessageParam[] {
  const out: ChatCompletionMessageParam[] = [{ role: "system", content: system }];
  for (const turn of history) {
    if (turn.role === "user") {
      const files = turn.files ?? [];
      out.push({
        role: "user",
        content: files.length
          ? [
              ...files.map((f) =>
                f.mediaType === "application/pdf"
                  ? { type: "file" as const, file: { filename: f.name, file_data: `data:application/pdf;base64,${f.data}` } }
                  : { type: "image_url" as const, image_url: { url: `data:${f.mediaType};base64,${f.data}` } },
              ),
              { type: "text" as const, text: turn.text },
            ]
          : turn.text,
      });
    }
    else if (turn.role === "note") out.push({ role: "user", content: `(From the app, not typed by the user) ${turn.text}` });
    else if (turn.role === "tool") {
      for (const r of turn.results) out.push({ role: "tool", tool_call_id: r.id, content: r.isError ? `Error: ${r.output}` : r.output });
    } else {
      out.push({
        role: "assistant",
        content: turn.text || null,
        ...(turn.toolCalls.length
          ? {
              tool_calls: turn.toolCalls.map((c) => ({
                id: c.id,
                type: "function" as const,
                function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) },
              })),
            }
          : {}),
      });
    }
  }
  return out;
}

function parseArguments(raw: string): unknown {
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    // Handed to the schema check as-is, which refuses it and tells the model why.
    return { __unparseable: raw };
  }
}

/** The temperature a self-hosted model (an OpenAI-compatible account) answers at. */
export const LOCAL_TEMPERATURE = 0.2;

export function openaiClient(connection: Connection): OpenAI {
  switch (connection.kind) {
    case "OPENAI":
      return new OpenAI({ apiKey: connection.apiKey, maxRetries: 2 });
    case "AZURE_OPENAI":
      return new AzureOpenAI({ endpoint: connection.endpoint, apiKey: connection.apiKey, apiVersion: connection.apiVersion, maxRetries: 2 });
    case "OPENAI_COMPATIBLE":
      // The SDK wants a key; a server that takes none ignores the header.
      return new OpenAI({ baseURL: connection.baseURL, apiKey: connection.apiKey ?? "none", maxRetries: 2 });
    default:
      throw new Error(`A ${connection.kind} account doesn't speak OpenAI's API.`);
  }
}

async function runTurn(request: TurnRequest): Promise<TurnOutcome> {
  const client = openaiClient(request.connection);
  const tools: ChatCompletionTool[] = request.tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));

  const stream = client.chat.completions.stream(
    {
      model: request.model,
      messages: messagesFor(request.system, request.history),
      // None offered (a "Hi" on a self-hosted model, an account's test): no tools field at all — OpenAI refuses an empty list.
      ...(tools.length ? { tools } : {}),
      max_completion_tokens: request.maxTokens ?? 16000,
      // A small self-hosted model at Ollama's default (0.8) picks tools and references loosely — a "Hi" became a look-up
      // of COM-000123. Low, it keeps to what it was given (owner, 23 Nov 2026). Hosted models keep their own default.
      ...(request.connection.kind === "OPENAI_COMPATIBLE" ? { temperature: LOCAL_TEMPERATURE } : {}),
      stream_options: { include_usage: true },
    },
    { signal: request.signal },
  );
  // A call written out as JSON never reaches the screen (./text-tool-calls.ts).
  const shown = jsonHider(request.onText);
  stream.on("content.delta", ({ delta }) => shown.push(delta));
  const completion = await stream.finalChatCompletion();
  shown.end();

  const choice = completion.choices[0];
  let toolCalls: ToolCall[] = (choice?.message.tool_calls ?? [])
    .filter((c) => c.type === "function")
    .map((c) => ({ id: c.id, name: c.function.name, input: parseArguments(c.function.arguments) }));
  let text = choice?.message.content ?? "";
  // …and is made, as the call it meant to be.
  const written = textToolCalls(text, request.tools);
  if (!toolCalls.length && written.calls.length) toolCalls = written.calls;
  if (written.calls.length) text = written.text;
  const u = completion.usage;
  const cached = u?.prompt_tokens_details?.cached_tokens ?? 0;
  const usage = { input: (u?.prompt_tokens ?? 0) - cached + Math.ceil(cached / 10), output: u?.completion_tokens ?? 0 };
  const stop: TurnOutcome["stop"] =
    choice?.finish_reason === "length"
      ? "truncated"
      : choice?.finish_reason === "content_filter" || choice?.message.refusal
        ? "refused"
        : toolCalls.length > 0
          ? "tools"
          : "done";
  return {
    text,
    toolCalls: stop === "tools" ? toolCalls : [],
    native: null,
    usage,
    stop,
    model: completion.model,
  };
}

export const openai: ProviderAdapter = { runTurn };
