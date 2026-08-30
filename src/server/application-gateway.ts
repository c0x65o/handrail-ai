import type { ApplicationGateway } from "../transports/application-gateway.js";

export interface ExpressLikeRequest {
  readonly method: string;
  readonly originalUrl?: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly body?: unknown;
}

export interface ExpressLikeResponse {
  status(code: number): this;
  setHeader(name: string, value: string): void;
  write(chunk: Uint8Array): boolean;
  end(chunk?: Uint8Array): void;
  once?(event: "close" | "drain", listener: () => void): void;
}

export type ExpressLikeNext = (error?: unknown) => void;

/** Thin adapter for Express-compatible middleware; Express is not a dependency. */
export function createApplicationGatewayExpressMiddleware(gateway: ApplicationGateway, options: { readonly origin: string }) {
  const origin = new URL(options.origin).origin;
  return async (request: ExpressLikeRequest, response: ExpressLikeResponse, next: ExpressLikeNext): Promise<void> => {
    try {
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (typeof value === "string") headers.set(name, value);
        else if (value) for (const item of value) headers.append(name, item);
      }
      const method = request.method.toUpperCase();
      const body = method === "GET" || method === "HEAD" ? undefined : JSON.stringify(request.body ?? {});
      const gatewayResponse = await gateway.handle(new Request(new URL(request.originalUrl ?? request.url, origin), {
        method, headers, ...(body === undefined ? {} : { body }),
      }));
      response.status(gatewayResponse.status);
      gatewayResponse.headers.forEach((value, name) => response.setHeader(name, value));
      if (!gatewayResponse.body) { response.end(); return; }
      const reader = gatewayResponse.body.getReader();
      response.once?.("close", () => { void reader.cancel(); });
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        if (!response.write(item.value) && response.once) {
          await new Promise<void>((resolve) => response.once!("drain", resolve));
        }
      }
      response.end();
    } catch (error) { next(error); }
  };
}
