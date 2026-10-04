import type { NextConfig } from "next";
import fs from "fs";
import path from "path";

// Automatically load central root .env configuration so developers only need a single config file
function loadRootEnv(): Record<string, string> {
  const rootEnvPath = path.resolve(process.cwd(), "../.env");
  const envVars: Record<string, string> = {};
  if (fs.existsSync(rootEnvPath)) {
    const content = fs.readFileSync(rootEnvPath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith("#") && trimmed.includes("=")) {
        const [key, ...vals] = trimmed.split("=");
        const k = key.trim();
        const val = vals.join("=").trim().replace(/^['"]|['"]$/g, "");
        if (k === "COMFYUI_URL") {
          envVars.NEXT_PUBLIC_COMFYUI_URL = val;
        } else if (k === "BACKEND_URL") {
          envVars.NEXT_PUBLIC_API_URL = val;
        } else if (k === "NV_API_KEY") {
          envVars.NV_API_KEY = val;
        }
      }
    }
  }
  return envVars;
}

const rootEnv = loadRootEnv();

const nextConfig: NextConfig = {
  env: {
    ...rootEnv,
  },
  images: {
    remotePatterns: [
      { protocol: 'http', hostname: 'localhost', port: '8003' },
      { protocol: 'http', hostname: '100.67.10.59', port: '8003' },
      { protocol: 'http', hostname: '127.0.0.1', port: '8003' },
    ],
  },
  allowedDevOrigins: ['100.67.10.59', '127.0.0.1', 'localhost', '192.168.0.123'],
};

export default nextConfig;
