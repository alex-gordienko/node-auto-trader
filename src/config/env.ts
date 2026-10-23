/**
 * Secrets have no safe default. A committed placeholder (`process.env.X || "YOUR_PRIVATE"`) lets the process boot
 * with a misconfigured environment and fail much later — mid-swap, or with an opaque library error such as
 * ethers' "invalid BytesLike value" — instead of saying which variable is missing.
 *
 * `requireEnv` is read through a getter on the config objects, so it throws when a secret is actually needed.
 * Data-only paths (backfills, backtests, model training) therefore keep working without trading credentials,
 * while anything that touches funds or a provider fails immediately and names the variable.
 */
export const requireEnv = (name: string, purpose: string): string => {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(
      `Missing required environment variable ${name} (${purpose}). ` +
        `Set it in .env or the deployment secret store — there is no default value.`
    );
  }
  return value.trim();
};

/**
 * Validates a group of secrets up front and reports every missing one at once, so a live run is not fixed
 * one restart per variable. Call it from a path that is about to use the whole group.
 */
export const requireEnvGroup = (groupName: string, vars: Record<string, string>): void => {
  const missing = Object.entries(vars)
    .filter(([name]) => {
      const value = process.env[name];
      return value === undefined || value.trim() === "";
    })
    .map(([name, purpose]) => `  - ${name} (${purpose})`);

  if (missing.length) {
    throw new Error(`${groupName} is not configured. Missing environment variables:\n${missing.join("\n")}`);
  }
};
