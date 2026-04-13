import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createClient } from "redis";
import type { Topic } from "./types";

export type CallStep = "intro" | "consent" | "conversation" | "finished";
export type ContactRole = "gatekeeper" | "decision-maker";

export interface CallState {
  callSid: string;
  leadId?: string;
  company: string;
  contactName?: string;
  topic: Topic;
  step: CallStep;
  consent: "yes" | "no";
  turn: number;
  transcript: string;
  contactRole: ContactRole;
  updatedAt: string;
}

const REDIS_PREFIX = "gloria:call-state:";
const FILE_PATH = path.join(process.cwd(), "data", "call-state.json");
const DEFAULT_TTL_SECONDS = 60 * 60 * 2;

let redisClient: ReturnType<typeof createClient> | undefined;
let redisInitPromise: Promise<ReturnType<typeof createClient> | undefined> | undefined;

async function getRedisClient() {
  if (!process.env.REDIS_URL?.trim()) {
    return undefined;
  }

  if (redisClient) {
    return redisClient;
  }

  if (!redisInitPromise) {
    redisInitPromise = (async () => {
      try {
        const client = createClient({ url: process.env.REDIS_URL as string });
        client.on("error", (error) => {
          console.error("Redis call-state error", error);
        });
        await client.connect();
        redisClient = client;
        return client;
      } catch (error) {
        console.error("Redis call-state connect failed", error);
        return undefined;
      }
    })();
  }

  return redisInitPromise;
}

async function readFileState(): Promise<Record<string, CallState>> {
  await mkdir(path.dirname(FILE_PATH), { recursive: true });

  try {
    const raw = await readFile(FILE_PATH, "utf8");
    return JSON.parse(raw) as Record<string, CallState>;
  } catch {
    return {};
  }
}

async function writeFileState(data: Record<string, CallState>) {
  await mkdir(path.dirname(FILE_PATH), { recursive: true });
  await writeFile(FILE_PATH, JSON.stringify(data, null, 2), "utf8");
}

export async function getCallState(callSid: string) {
  const key = `${REDIS_PREFIX}${callSid}`;
  const redis = await getRedisClient();

  if (redis) {
    const raw = await redis.get(key);
    if (!raw) {
      return undefined;
    }

    return JSON.parse(raw) as CallState;
  }

  const fileState = await readFileState();
  return fileState[callSid];
}

export async function saveCallState(callSid: string, state: CallState, ttlSeconds = DEFAULT_TTL_SECONDS) {
  const key = `${REDIS_PREFIX}${callSid}`;
  const redis = await getRedisClient();

  if (redis) {
    await redis.set(key, JSON.stringify(state), { EX: ttlSeconds });
    return;
  }

  const fileState = await readFileState();
  fileState[callSid] = state;
  await writeFileState(fileState);
}

export async function deleteCallState(callSid: string) {
  const key = `${REDIS_PREFIX}${callSid}`;
  const redis = await getRedisClient();

  if (redis) {
    await redis.del(key);
    return;
  }

  const fileState = await readFileState();
  delete fileState[callSid];
  await writeFileState(fileState);
}
