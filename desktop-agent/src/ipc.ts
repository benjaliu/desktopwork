import * as readline from 'node:readline';
import type { Request, Response, StreamEvent } from './types.js';

export function errorResponse(id: string | null, code: number, message: string): Response {
  return {
    jsonrpc: "2.0",
    id,
    error: { code, message }
  };
}

export type StreamWriter = (event: StreamEvent) => void;

export async function startIpcLoop(
  handler: (req: Request, writeStream: StreamWriter) => Promise<Response>
): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false
  });

  const writeStream: StreamWriter = (event: StreamEvent) => {
    process.stdout.write(JSON.stringify(event) + '\n');
  };

  for await (const line of rl) {
    if (!line.trim()) continue;

    try {
      const req = JSON.parse(line) as Request;

      // Validate request
      if (req.jsonrpc !== "2.0" || !req.id || !req.method) {
        const resp = errorResponse(req.id ?? null, -32600, "Invalid Request");
        process.stdout.write(JSON.stringify(resp) + '\n');
        continue;
      }

      const response = await handler(req, writeStream);
      process.stdout.write(JSON.stringify(response) + '\n');
    } catch (e) {
      const resp = errorResponse(null, -32603, String(e));
      process.stdout.write(JSON.stringify(resp) + '\n');
    }
  }
}