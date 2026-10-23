import dotenv from 'dotenv'
import { requireEnv } from './env'
dotenv.config()

// Every field is a getter without a default: a placeholder endpoint or key used to let the Spaces client build
// successfully and fail on the first upload. Reading an unset one now throws and names the variable.
const digitalOceanConfig = {
  get accessKeyId(): string {
    return requireEnv("DO_KEY_ID", "DigitalOcean Spaces access key id");
  },
  get secretAccessKey(): string {
    return requireEnv("DO_SECRET_KEY", "DigitalOcean Spaces secret access key");
  },
  get endpoint(): string {
    return requireEnv("DO_SPACE_ENDPOINT", "DigitalOcean Spaces endpoint URL");
  },
  get bucket(): string {
    return requireEnv("DO_SPACE_BUCKET", "DigitalOcean Spaces bucket name");
  },
};

export default digitalOceanConfig;
