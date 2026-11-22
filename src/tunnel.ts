// HTTP over the data channel to a game's control server (schlarpc/sculk's
// docs/REMOTE.md, "Tunnel"; the game's side is Tunnel.java). fetch() here
// gives real Response objects, bodies streamed as the game writes them, so
// the game's UI uses them as it would fetch's, server-sent events included.
//
// Every message is stream (u32) || type (u8) || data. Each request is a new
// stream; several run at once.
//
// Requests ask for gzip, and gzipped bodies are decoded here, as they arrive
// (the game flushes its event streams as it writes them), so the game's UI
// sees plain responses while the data channel carries a fraction of the bytes.

const REQUEST = 1, REQUEST_BODY = 2, REQUEST_END = 3, CANCEL = 7;
const RESPONSE = 4, RESPONSE_BODY = 5, RESPONSE_END = 6, ERROR = 8;
const CHUNK = 16 * 1024;
/** Statuses whose responses have no body, which Response refuses one for. */
const NULL_BODY = new Set([101, 103, 204, 205, 304]);

/** Where tunnel messages go and come from: a data channel, or a MessagePort to one. */
export interface Pipe {
  send(message: Uint8Array): void;
  onMessage(handler: (message: Uint8Array) => void): void;
}

interface Stream {
  resolve: (r: Response) => void;
  reject: (e: Error) => void;
  body?: ReadableStreamDefaultController<Uint8Array>;
}

function message(stream: number, type: number, data: Uint8Array = new Uint8Array(0)): Uint8Array {
  const out = new Uint8Array(5 + data.length);
  new DataView(out.buffer).setUint32(0, stream, false);
  out[4] = type;
  out.set(data, 5);
  return out;
}

export class TunnelClient {
  private next = 1;
  private readonly streams = new Map<number, Stream>();

  constructor(private readonly pipe: Pipe) {
    pipe.onMessage((m) => this.receive(m));
  }

  /** As fetch, for paths on the game's control server ("/", "/api/status", ...). */
  fetch(path: string, init: RequestInit = {}): Promise<Response> {
    const id = this.next++;
    const signal = init.signal ?? undefined;
    if (signal?.aborted) return Promise.reject(new DOMException("aborted", "AbortError"));
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => (headers[k] = v));
    headers["accept-encoding"] ??= "gzip";
    const body =
      init.body === undefined || init.body === null
        ? new Uint8Array(0)
        : typeof init.body === "string"
          ? new TextEncoder().encode(init.body)
          : new Uint8Array(init.body as ArrayBuffer);
    return new Promise<Response>((resolve, reject) => {
      this.streams.set(id, { resolve, reject });
      signal?.addEventListener("abort", () => this.cancel(id, new DOMException("aborted", "AbortError")));
      const head = { method: (init.method ?? "GET").toUpperCase(), path, headers };
      this.pipe.send(message(id, REQUEST, new TextEncoder().encode(JSON.stringify(head))));
      for (let at = 0; at < body.length; at += CHUNK) this.pipe.send(message(id, REQUEST_BODY, body.subarray(at, at + CHUNK)));
      this.pipe.send(message(id, REQUEST_END));
    });
  }

  private cancel(id: number, why: Error): void {
    const s = this.streams.get(id);
    if (!s) return;
    this.streams.delete(id);
    this.pipe.send(message(id, CANCEL));
    s.reject(why);
    try {
      s.body?.error(why);
    } catch {
      // already closed
    }
  }

  private receive(m: Uint8Array): void {
    if (m.length < 5) return;
    const id = new DataView(m.buffer, m.byteOffset, m.byteLength).getUint32(0, false);
    const type = m[4];
    const data = m.slice(5);
    const s = this.streams.get(id);
    if (!s) return;
    switch (type) {
      case RESPONSE: {
        const head = JSON.parse(new TextDecoder().decode(data)) as { status: number; headers?: Record<string, string> };
        const headers = new Headers(head.headers ?? {});
        const raw = NULL_BODY.has(head.status)
          ? null
          : new ReadableStream<Uint8Array>({
              start: (c) => {
                s.body = c;
              },
              cancel: () => {
                if (this.streams.delete(id)) this.pipe.send(message(id, CANCEL));
              },
            });
        let body: ReadableStream<Uint8Array> | null = raw;
        if (raw && headers.get("content-encoding") === "gzip") {
          body = raw.pipeThrough(new DecompressionStream("gzip") as ReadableWritablePair<Uint8Array, Uint8Array>);
          headers.delete("content-encoding");
        }
        s.resolve(new Response(body, { status: head.status, headers }));
        return;
      }
      case RESPONSE_BODY:
        s.body?.enqueue(data);
        return;
      case RESPONSE_END:
        this.streams.delete(id);
        s.body?.close();
        return;
      case ERROR: {
        this.streams.delete(id);
        const e = new TypeError(new TextDecoder().decode(data)); // as fetch fails
        s.reject(e);
        s.body?.error(e);
        return;
      }
    }
  }

  /** The connection is gone: fail everything in flight. */
  close(): void {
    for (const id of [...this.streams.keys()]) this.cancel(id, new TypeError("the connection to the game closed"));
  }
}
