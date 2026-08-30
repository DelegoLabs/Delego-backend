/**
 * Type declarations for Node.js built-in modules
 */
declare module "node:http" {
  export function createServer(
    requestListener?: (req: IncomingMessage, res: ServerResponse) => void
  ): Server;
  export class IncomingMessage {
    constructor(socket: Socket);
    aborted: boolean;
    httpVersion: string;
    headers: IncomingMessageHeaders;
    rawHeaders: string[];
    trailers: {};
    rawTrailers: string[];
    setTimeout(msecs: number, callback?: () => void): this;
    method?: string;
    url?: string;
    read(): Buffer | string | null;
    destroy(error?: Error): void;
    socket: Socket;
  }
  export interface Server extends EventEmitter {
    listen(port?: number, hostname?: string, backlog?: number, callback?: () => void): Server;
    listen(port?: number, hostname?: string, callback?: () => void): Server;
    listen(port?: number, callback?: () => void): Server;
    listen(options: { port: number; host?: string; backlog?: number }, callback?: () => void): Server;
    listen(path: string, backlog?: number, callback?: () => void): Server;
    listen(path: string, callback?: () => void): Server;
    close(callback?: () => void): Server;
    address(): AddressInfo | null;
    getHeader(name: string): string | undefined;
    setHeader(name: string, value: string | string[]): Server;
    removeHeader(name: string): Server;
    timeout: number;
    headersTimeout: number;
    requestTimeout: number;
  }
  export interface ServerResponse {
    statusCode: number;
    statusMessage: string;
    write(chunk: string | Buffer, callback?: () => void): boolean;
    write(chunk: string | Buffer, encoding?: string, callback?: () => void): boolean;
    writeContinue(): void;
    writeHead(statusCode: number, statusMessage?: string, headers?: OutgoingHttpHeaders): ServerResponse;
    writeHead(statusCode: number, headers?: OutgoingHttpHeaders): ServerResponse;
    setHeader(name: string, value: string | string[]): ServerResponse;
    getHeader(name: string): string | undefined;
    removeHeader(name: string): ServerResponse;
    addTrailers(trailers: OutgoingHttpHeaders): void;
    end(callback?: () => void): void;
    end(chunk: string | Buffer, callback?: () => void): void;
    end(chunk: string | Buffer, encoding?: string, callback?: () => void): void;
    finished(res: ServerResponse): void;
    socket: Socket;
  }
}
