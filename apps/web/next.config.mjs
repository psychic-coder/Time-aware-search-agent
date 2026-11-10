import path from "node:path";
import { fileURLToPath } from "node:url";
import nextEnv from "@next/env";

// The single source of config is the repo-root .env, so load it here too.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
nextEnv.loadEnvConfig(root);

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  agentRules: false,
  devIndicators: false,
  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000",
  },
};

export default nextConfig;
