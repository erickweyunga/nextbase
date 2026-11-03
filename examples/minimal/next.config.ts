import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // No generated AGENTS.md in the repository.
  agentRules: false,
};

export default nextConfig;
