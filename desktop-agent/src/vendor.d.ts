// Type declarations for vendor bundles

declare module '../../vendor/bundles/agent-core.esm.js' {
  export interface AgentMessage {
    id: string;
    role: 'user' | 'assistant' | 'system' | 'tool' | 'custom' | 'bashExecution';
    content: string | ContentBlock[];
    timestamp: number;
    excludeFromContext?: boolean;
  }

  export interface ContentBlock {
    type: string;
    text?: string;
    [key: string]: unknown;
  }

  export interface Session {
    getMetadata(): SessionMetadata;
    getLeafId(): string | null;
    getEntries(): Promise<SessionEntry[]>;
    getEntry(id: string): SessionEntry | undefined;
    findEntries(filter: (entry: SessionEntry) => boolean): SessionEntry[];
    recordEntry(entry: SessionEntry): void;
    createLeafEntry(leafId: string): SessionEntry;
    createEntryId(): string;
    appendEntry(entry: SessionEntry): Promise<void>;
    setLeafId(leafId: string): Promise<void>;
  }

  export interface SessionMetadata {
    type: string;
    version: number;
    id: string;
    timestamp: string;
    cwd?: string;
    parentSession?: string;
  }

  export interface SessionEntry {
    id: string;
    type: string;
    message?: AgentMessage;
    timestamp: number;
    leafId?: string;
    [key: string]: unknown;
  }

  export function agentLoop(
    prompts: AgentMessage[],
    context: { systemPrompt: string; messages: AgentMessage[] },
    config: { model: any; reasoning?: string },
    signal: AbortSignal | null,
    streamFn: any,
    runtime: { completeSimple: Function; streamSimple?: Function }
  ): AgentStream;

  // agentLoop returns an object with push/end/done + async iterator
  // It does NOT have subscribe() — that's a different pattern
  export interface AgentStream {
    push(event: any): void;
    end(result?: any): void;
    done: boolean;
    [Symbol.asyncIterator](): AsyncIterator<any>;
  }

  export function runAgentLoop(
    prompts: AgentMessage[],
    context: { systemPrompt: string; messages: AgentMessage[] },
    config: any,
    emit: (event: any) => Promise<void>,
    signal: AbortSignal | null,
    streamFn: any,
    runtime: any
  ): Promise<AgentMessage[]>;

  export class JsonlSessionStorage {
    static async open(fs: any, filePath: string): Promise<JsonlSessionStorage>;
    static async create(fs: any, filePath: string, options: { sessionId: string; cwd: string; parentSessionPath?: string }): Promise<JsonlSessionStorage>;
    appendEntry(entry: SessionEntry): Promise<void>;
    setLeafId(leafId: string): Promise<void>;
    getMetadata(): SessionMetadata;
    getLeafId(): string | null;
    getEntries(): Promise<SessionEntry[]>;
    getEntry(id: string): SessionEntry | undefined;
    findEntries(filter: (entry: SessionEntry) => boolean): SessionEntry[];
  }
  export function loadSkills(env: any, dirs: string | string[]): Promise<{ skills: any[]; diagnostics: any[] }>;
  export function convertToLlm(messages: AgentMessage[]): any[];
  export function resolveAgentCoreCompleteFn(runtime: any): Function;
  export function resolveAgentCoreStreamFn(runtime: any, streamFn: any): Function;
  export function asAgentMessage(msg: any): AgentMessage;
  export function uuidv7(): string;
}

declare module '../../vendor/bundles/llm-core.esm.js' {
  export class EventStream<T> {
    constructor(
      isComplete: (event: T) => boolean,
      extractResult: (event: T) => any
    );
    push(event: T): void;
    end(result?: any): void;
    [Symbol.asyncIterator](): AsyncIterator<T>;
    subscribe(observer: { next: (event: T) => void; error?: (err: any) => void; complete?: () => void }): void;
    get finalResultPromise(): Promise<any>;
  }

  export class AssistantMessageEventStream extends EventStream<any> {
    constructor();
  }

  export function createAssistantMessageEventStream(): AssistantMessageEventStream;
  export function validateToolArguments(validator: any, args: any): void;
  export function validateToolCall(validator: any, toolCall: any): void;
}