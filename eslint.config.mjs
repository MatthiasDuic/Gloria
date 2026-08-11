import nextConfig from "eslint-config-next";

const config = [
  { ignores: ["worker/**", ".next/**", "node_modules/**"] },
  ...nextConfig,
];

export default config;
