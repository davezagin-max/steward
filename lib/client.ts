/**
 * Browser-side helpers for calling this app's own API routes.
 * The key travels only in a request header to our own origin.
 */
import type { ApiMeta, ApiResponse, ErrorKind, StreamFrame } from "./api";

const KEY_HEADER = "x-anthropic-key";

function headers(apiKey: string | null): HeadersInit {
  return {
    "content-type": "application/json",
    ...(apiKey ? { [KEY_HEADER]: apiKey } : {}),
  };
}

const NETWORK_ERROR = { kind: "server" as ErrorKind, message: "Network error. Check your connection." };

export async function callApi<D>(
  path: string,
  body: unknown,
  apiKey: string | null,
  signal?: AbortSignal,
): Promise<ApiResponse<D>> {
  try {
    const res = await fetch(path, {
      method: "POST",
      headers: headers(apiKey),
      body: JSON.stringify(body),
      signal,
    });
    return (await res.json()) as ApiResponse<D>;
  } catch {
    return { ok: false, error: NETWORK_ERROR };
  }
}

export interface StreamHandlers<E> {
  onMeta?: (meta: Pick<ApiMeta, "mode" | "placeholder" | "recordedAt">) => void;
  onEvent: (event: E) => void;
}

/** Reads a `streamRoute` response and resolves with the final result. */
export async function streamApi<D, E>(
  path: string,
  body: unknown,
  apiKey: string | null,
  handlers: StreamHandlers<E>,
  signal?: AbortSignal,
): Promise<ApiResponse<D>> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: "POST",
      headers: headers(apiKey),
      body: JSON.stringify(body),
      signal,
    });
  } catch {
    return { ok: false, error: NETWORK_ERROR };
  }
  if (!res.ok || !res.body) {
    try {
      return (await res.json()) as ApiResponse<D>;
    } catch {
      return { ok: false, error: { kind: "server", message: "Request failed." } };
    }
  }

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  let final: ApiResponse<D> | null = null;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      let split: number;
      while ((split = buffer.indexOf("\n\n")) !== -1) {
        const chunk = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        if (!chunk.startsWith("data: ")) continue;
        const frame = JSON.parse(chunk.slice(6)) as StreamFrame<D, E>;
        if (frame.type === "meta") handlers.onMeta?.(frame.meta);
        else if (frame.type === "event") handlers.onEvent(frame.event);
        else if (frame.type === "done") final = { ok: true, data: frame.data, meta: frame.meta };
        else final = { ok: false, error: frame.error, meta: frame.meta };
      }
    }
  } catch {
    return { ok: false, error: { kind: "server", message: "The stream was interrupted." } };
  }
  return final ?? { ok: false, error: { kind: "server", message: "The stream ended early." } };
}
