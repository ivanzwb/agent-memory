import type { EmbeddingProvider } from '../types';
import { EmbeddingError } from '../errors';
import * as path from 'path';
import * as fs from 'fs';
import * as http from 'http';
import * as tls from 'tls';
import type * as net from 'net';

let proxyConfigured = false;

function configureProxy(): void {
  if (proxyConfigured) return;
  proxyConfigured = true;

  const proxyUrl =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy;
  if (!proxyUrl) return;

  const proxy = new URL(proxyUrl);
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async function proxyFetch(
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> {
    const url = new URL(
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );

    // Only intercept HTTPS requests
    if (url.protocol !== 'https:') {
      return originalFetch(input, init);
    }

    const targetPort = Number(url.port) || 443;

    // 1. Establish CONNECT tunnel through the proxy
    const tunnelSocket = await new Promise<net.Socket>((resolve, reject) => {
      const req = http.request({
        host: proxy.hostname,
        port: Number(proxy.port) || 80,
        method: 'CONNECT',
        path: `${url.hostname}:${targetPort}`,
      });
      req.on('connect', (res, socket) => {
        if (res.statusCode === 200) resolve(socket);
        else reject(new Error(`Proxy CONNECT failed: ${res.statusCode}`));
      });
      req.on('error', reject);
      req.end();
    });

    // 2. TLS handshake over the tunnel
    const tlsSocket = tls.connect({
      socket: tunnelSocket,
      servername: url.hostname,
    });
    await new Promise<void>((resolve, reject) => {
      tlsSocket.on('secureConnect', resolve);
      tlsSocket.on('error', reject);
    });

    // 3. HTTP request over the TLS tunnel
    return new Promise<Response>((resolve, reject) => {
      const reqHeaders: Record<string, string> = { Host: url.host };
      if (init?.headers) {
        const h =
          init.headers instanceof Headers
            ? Object.fromEntries(init.headers.entries())
            : Array.isArray(init.headers)
              ? Object.fromEntries(init.headers)
              : (init.headers as Record<string, string>);
        Object.assign(reqHeaders, h);
      }

      const req = http.request(
        {
          hostname: url.hostname,
          path: url.pathname + url.search,
          method: init?.method || 'GET',
          headers: reqHeaders,
          createConnection: () => tlsSocket as unknown as net.Socket,
        },
        (res) => {
          // Follow redirects
          if (
            [301, 302, 303, 307, 308].includes(res.statusCode!) &&
            res.headers.location
          ) {
            tlsSocket.destroy();
            // Resolve relative redirects against the original URL
            const redirectUrl = new URL(res.headers.location, url).href;
            resolve(proxyFetch(redirectUrl, init));
            return;
          }

          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            const body = Buffer.concat(chunks);
            const headers = new Headers();
            for (const [k, v] of Object.entries(res.headers)) {
              if (v != null)
                headers.set(k, Array.isArray(v) ? v.join(', ') : v);
            }
            resolve(
              new Response(body, {
                status: res.statusCode,
                statusText: res.statusMessage,
                headers,
              }),
            );
          });
          res.on('error', reject);
        },
      );
      req.on('error', reject);
      if (init?.body) req.write(init.body);
      req.end();
    });
  } as typeof globalThis.fetch;
}

/**
 * Built-in local embedding provider using @xenova/transformers.
 * Model: all-MiniLM-L6-v2 (384 dimensions, ~80MB).
 * Downloaded on first use and cached locally.
 */
export class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions = 384;
  private pipeline: unknown = null;
  private modelDir: string;
  private initPromise: Promise<void> | null = null;

  constructor(dataDir: string) {
    this.modelDir = path.join(dataDir, 'models');
    fs.mkdirSync(this.modelDir, { recursive: true });
  }

  async initialize(): Promise<void> {
    if (this.pipeline) return;
    if (this.initPromise) {
      await this.initPromise;
      return;
    }
    this.initPromise = this.doInit();
    await this.initPromise;
  }

  private async doInit(): Promise<void> {
    try {
      configureProxy();
      // Dynamic import to avoid issues if transformers is not available
      const { pipeline, env } = await import('@xenova/transformers');
      // Cache models in our data directory
      env.cacheDir = this.modelDir;
      env.allowLocalModels = true;
      this.pipeline = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
    } catch (err) {
      throw new EmbeddingError(
        `Failed to initialize local embedding model: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async embed(text: string): Promise<number[]> {
    await this.initialize();
    try {
      const extractor = this.pipeline as (text: string, options: Record<string, unknown>) => Promise<{ data: Float32Array }>;
      const output = await extractor(text, { pooling: 'mean', normalize: true });
      return Array.from(output.data);
    } catch (err) {
      throw new EmbeddingError(
        `Embedding generation failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
