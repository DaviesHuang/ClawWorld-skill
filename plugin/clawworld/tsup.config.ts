import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["index.ts", "channel.ts"],
  format: ["esm"],
  platform: "node",
  outDir: "dist",
  splitting: false,
  external: ["openclaw"],
  noExternal: ["ws", "@anthropic-ai/sdk"],
});
