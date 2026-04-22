// Strukturiertes JSON-Logging für Gloria.
//
// Vercel parst JSON auf stdout automatisch und macht Felder filterbar.
// Zweck: Korrelation per callSid, Latenzmessung, Fehlerklassifizierung.

type Level = "debug" | "info" | "warn" | "error";

export interface LogContext {
  callSid?: string;
  userId?: string;
  leadId?: string;
  topic?: string;
  turn?: number;
  step?: string;
  role?: string;
  event?: string;
  latencyMs?: number;
  status?: number | string;
  reason?: string;
  [key: string]: unknown;
}

function emit(level: Level, message: string, ctx?: LogContext) {
  const payload = {
    level,
    message,
    timestamp: new Date().toISOString(),
    ...ctx,
  };

  const line = JSON.stringify(payload, (_key, value) => {
    if (value instanceof Error) {
      return { name: value.name, message: value.message };
    }
    return value;
  });

  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export const log = {
  debug(message: string, ctx?: LogContext) {
    if ((process.env.LOG_LEVEL || "info") === "debug") emit("debug", message, ctx);
  },
  info(message: string, ctx?: LogContext) {
    emit("info", message, ctx);
  },
  warn(message: string, ctx?: LogContext) {
    emit("warn", message, ctx);
  },
  error(message: string, ctx?: LogContext) {
    emit("error", message, ctx);
  },
};

/** Misst die Dauer einer async-Operation und loggt Start+Ende automatisch. */
export async function timed<T>(
  event: string,
  fn: () => Promise<T>,
  ctx?: LogContext,
): Promise<T> {
  const started = Date.now();
  try {
    const result = await fn();
    log.info(`${event}.ok`, { ...ctx, event, latencyMs: Date.now() - started });
    return result;
  } catch (error) {
    log.error(`${event}.fail`, {
      ...ctx,
      event,
      latencyMs: Date.now() - started,
      reason: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
