import net from 'net';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

export interface IpcRequest {
  id: string;
  command: string;
  channelId: string;
  guildId?: string;
  args: Record<string, any>;
}

export interface IpcResponse {
  id: string;
  success: boolean;
  data?: any;
  error?: string;
}

export class IpcClient {
  async sendRequest(targetAgent: string, command: string, channelId: string, guildId: string | undefined, args: Record<string, any>, timeoutMs = 15000): Promise<IpcResponse> {
    const id = randomUUID();
    const socketPath = path.resolve('.kaede', targetAgent, 'ipc.sock');

    return new Promise((resolve, reject) => {
      const socket = net.createConnection(socketPath);

      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`IPC Request timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      let buf = '';
      socket.on('data', (chunk) => {
        buf += chunk.toString();
        const newline = buf.indexOf('\n');
        if (newline === -1) return;
        const line = buf.slice(0, newline).trim();
        clearTimeout(timer);
        socket.destroy();
        try {
          resolve(JSON.parse(line) as IpcResponse);
        } catch (e) {
          reject(new Error(`IPC response parse error: ${e}`));
        }
      });

      socket.on('error', (err) => {
        clearTimeout(timer);
        reject(new Error(`IPC connection failed: ${err.message}`));
      });

      socket.on('connect', () => {
        const req: IpcRequest = { id, command, channelId, guildId, args };
        socket.write(JSON.stringify(req) + '\n');
      });
    });
  }
}

export class IpcServer {
  private readonly socketPath: string;
  private server?: net.Server;
  private readonly pendingSockets = new Map<string, net.Socket>();

  constructor(configDir: string) {
    this.socketPath = path.join(configDir, 'ipc.sock');
  }

  async ensureReady(): Promise<void> {
    try { fs.unlinkSync(this.socketPath); } catch {}
  }

  async sendResponse(requestId: string, response: IpcResponse): Promise<void> {
    const socket = this.pendingSockets.get(requestId);
    if (!socket) return;
    this.pendingSockets.delete(requestId);
    try {
      socket.write(JSON.stringify(response) + '\n');
      socket.end();
    } catch (err) {
      console.error(`[IPC] Failed to send response for ${requestId}:`, err);
    }
  }

  listen(handler: (req: IpcRequest) => Promise<void>): void {
    this.server = net.createServer((socket) => {
      let buf = '';
      socket.on('data', (chunk) => {
        buf += chunk.toString();
        const newline = buf.indexOf('\n');
        if (newline === -1) return;
        const line = buf.slice(0, newline).trim();
        buf = buf.slice(newline + 1);
        if (!line) return;
        try {
          const req = JSON.parse(line) as IpcRequest;
          this.pendingSockets.set(req.id, socket);
          handler(req).catch((err) => {
            console.error('[IPC] handler error:', err);
            this.sendResponse(req.id, { id: req.id, success: false, error: String(err) });
          });
        } catch {
          // Ignore malformed requests
        }
      });
      socket.on('error', () => {});
    });
    this.server.listen(this.socketPath);
  }

  close(): void {
    this.server?.close();
    try { fs.unlinkSync(this.socketPath); } catch {}
  }
}
