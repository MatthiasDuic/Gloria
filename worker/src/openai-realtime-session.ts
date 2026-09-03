import WebSocket from "ws";

export type RealtimeServerEvent = {
  type?: string;
  item_id?: string;
  delta?: string;
  transcript?: string;
  text?: string;
  name?: string;
  call_id?: string;
  arguments?: string;
  error?: { message?: string };
  response?: {
    status?: string;
    output?: Array<{
      type?: string;
      name?: string;
      call_id?: string;
      arguments?: string;
    }>;
  };
};

export type RealtimeSocket = {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "open", listener: () => void): void;
  on(event: "message", listener: (data: { toString(): string }) => void): void;
  on(event: "close", listener: (code: number, reason: { toString(): string }) => void): void;
  on(event: "error", listener: (error: Error) => void): void;
};

export type OpenAiRealtimeSessionOptions = {
  apiKey: string;
  model: string;
  onOpen?: () => void;
  onEvent: (event: RealtimeServerEvent) => void;
  onClose?: (code: number, reason: string) => void;
  onError?: (error: Error) => void;
  maxQueuedAudio?: number;
  socketFactory?: (url: string, headers: Record<string, string>) => RealtimeSocket;
};

export class OpenAiRealtimeSession {
  private readonly options: OpenAiRealtimeSessionOptions;
  private readonly queuedAudio: string[] = [];
  private socket: RealtimeSocket | null = null;
  private ready = false;
  private deliberatelyClosed = false;
  private reconnectAttempts = 0;
  private static readonly MAX_RECONNECT_ATTEMPTS = 3;
  private static readonly RECONNECT_BASE_MS = 500;

  constructor(options: OpenAiRealtimeSessionOptions) {
    this.options = options;
  }

  connect(): void {
    if (this.socket) return;
    const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(this.options.model)}`;
    const factory = this.options.socketFactory ?? ((socketUrl, headers) => new WebSocket(socketUrl, { headers }) as RealtimeSocket);
    this.socket = factory(url, { Authorization: `Bearer ${this.options.apiKey}` });
    this.socket.on("open", () => {
      this.reconnectAttempts = 0;
      this.ready = true;
      this.options.onOpen?.();
      for (const audio of this.queuedAudio.splice(0)) this.send({ type: "input_audio_buffer.append", audio });
    });
    this.socket.on("message", (data) => {
      try {
        this.options.onEvent(JSON.parse(data.toString()) as RealtimeServerEvent);
      } catch {
        // Ignore malformed server frames; the socket remains usable.
      }
    });
    this.socket.on("close", (code, reason) => {
      this.ready = false;
      this.socket = null;
      if (this.deliberatelyClosed) {
        this.options.onClose?.(code, reason.toString());
        return;
      }
      if (this.reconnectAttempts < OpenAiRealtimeSession.MAX_RECONNECT_ATTEMPTS) {
        const delay = OpenAiRealtimeSession.RECONNECT_BASE_MS * (2 ** this.reconnectAttempts);
        this.reconnectAttempts += 1;
        this.options.onError?.(
          new Error(`openai_ws_dropped code=${code}; reconnect ${this.reconnectAttempts}/${OpenAiRealtimeSession.MAX_RECONNECT_ATTEMPTS} in ${delay}ms`),
        );
        setTimeout(() => {
          if (!this.deliberatelyClosed) this.connect();
        }, delay);
      } else {
        this.options.onClose?.(code, reason.toString());
      }
    });
    this.socket.on("error", (error) => this.options.onError?.(error));
  }

  isReady(): boolean {
    return this.ready;
  }

  send(event: Record<string, unknown>): boolean {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
    try {
      this.socket.send(JSON.stringify(event));
      return true;
    } catch (error) {
      this.options.onError?.(error instanceof Error ? error : new Error(String(error)));
      return false;
    }
  }

  appendInputAudio(audio: string): void {
    if (this.isReady()) {
      this.send({ type: "input_audio_buffer.append", audio });
      return;
    }
    this.queuedAudio.push(audio);
    const limit = this.options.maxQueuedAudio ?? 500;
    if (this.queuedAudio.length > limit) this.queuedAudio.shift();
  }

  close(code = 1000, reason = "session_closed"): void {
    this.deliberatelyClosed = true;
    this.ready = false;
    this.queuedAudio.length = 0;
    this.socket?.close(code, reason);
  }
}