enum Colors {
  RED = "\x1b[31m",
  GREEN = "\x1b[32m",
  YELLOW = "\x1b[33m",
  BLUE = "\x1b[34m",
  MAGENTA = "\x1b[35m",
  CYAN = "\x1b[36m",
  WHITE = "\x1b[37m",
  RESET = "\x1b[0m",
}

const log = (message: unknown, color?: Colors) => {
  if (color) {
    console.log(color, message, Colors.RESET);
  } else {
    console.log(message, Colors.RESET);
  }
};

/**
 * An axios error serializes `error.config.headers` — exactly where an API key header (X-MBX-APIKEY,
 * x-changenow-api-key, Authorization) lives. Strip request headers and anything matching a key pattern before
 * any value with a real credential can reach a log line. Must be applied before any real trading key exists.
 */
const SENSITIVE_KEY_PATTERN = /auth|apikey|api-key|secret|token|private/i;

const redactDeep = (value: unknown, depth = 0): unknown => {
  if (depth > 4 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SENSITIVE_KEY_PATTERN.test(key) ? "[redacted]" : redactDeep(val, depth + 1);
  }
  return out;
};

export const sanitizeError = (error: unknown): unknown => {
  if (!(error instanceof Error)) return redactDeep(error);

  const axiosLike = error as Error & {
    config?: { method?: string; url?: string };
    response?: { status?: number; data?: unknown };
  };
  const safe: Record<string, unknown> = { name: error.name, message: error.message };
  if (axiosLike.config) safe.request = { method: axiosLike.config.method, url: axiosLike.config.url };
  if (axiosLike.response) safe.response = { status: axiosLike.response.status, data: redactDeep(axiosLike.response.data) };
  return safe;
};

/** Logs a message and its error with credentials stripped. Use instead of `log(error, Colors.RED)`. */
const logError = (message: string, error: unknown): void => {
  log(message, Colors.RED);
  log(sanitizeError(error), Colors.RED);
};

function getRandomEnumValue<T extends object>(enumObj: T): T[keyof T] {
  const enumValues = Object.values(enumObj).filter((value) => typeof value === "string");
  const randomIndex = Math.floor(Math.random() * enumValues.length);
  return enumValues[randomIndex] as T[keyof T];
}

/** Logger that prefixes every message with a tag, e.g. "[dvol] loaded 8760 rows". */
const createLogger =
  (tag: string) =>
  (message: unknown, color?: Colors): void =>
    log(`[${tag}] ${message}`, color);

export { log, createLogger, Colors, getRandomEnumValue, logError };
