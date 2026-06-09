// IPC Request/Response types
export interface Request {
  jsonrpc: "2.0";
  id: string;
  method: string;
  params?: unknown;
}

export interface Response {
  jsonrpc: "2.0";
  id: string | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
  };
}

export interface StreamEvent {
  jsonrpc: "2.0";
  id: string;
  method: "stream";
  params: {
    delta?: string;
    error?: string;
    done: boolean;
  };
}

export interface ChatParams {
  message: string;
  sessionKey: string;
}

export interface StatusResult {
  ok: true;
  version: string;
  memoryReady: boolean;
  skillsLoaded: number;
  sessionCount?: number;
}