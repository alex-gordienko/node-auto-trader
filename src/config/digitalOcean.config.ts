import dotenv from 'dotenv'
dotenv.config()

const digitalOceanConfig = {
  accessKeyId: process.env.DO_KEY_ID || "your-access-key-id",
  secretAccessKey: process.env.DO_SECRET_KEY || "your-secret",
  endpoint: process.env.DO_SPACE_ENDPOINT || "your-endpoint",
  bucket: process.env.DO_SPACE_BUCKET || "your-bucket-name",
};

export default digitalOceanConfig;