import nx from "@nx/eslint-plugin";
import tseslint from "typescript-eslint";

export default [
  { ignores: ["**/node_modules/**", "**/dist/**", ".nx/**"] },
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts", "**/*.tsx"],
    plugins: { "@nx": nx },
    rules: {
      // Architecture boundaries (CLAUDE.md rules 1 and 6), enforced in CI.
      "@nx/enforce-module-boundaries": [
        "error",
        {
          allow: [],
          depConstraints: [
            { sourceTag: "type:kernel", onlyDependOnLibsWithTags: [] },
            { sourceTag: "type:context", onlyDependOnLibsWithTags: ["type:kernel", "type:context"] },
            { sourceTag: "type:app", onlyDependOnLibsWithTags: ["type:kernel", "type:context"] },
            // The data layer boundary (M1-16, decision record T-05): outside the data
            // layer, bars come only through its front door, @aia/data (tagged
            // layer:data), never straight from the stores, the cache, the bus or
            // provider code (hydration and market-data, tagged layer:data-internal).
            // An allow-list of direct dependencies, since @aia/data itself uses them.
            { sourceTag: "layer:product", onlyDependOnLibsWithTags: ["type:kernel", "layer:product", "layer:data"] },
            // Browser code never reaches the data layer at all: it would bundle
            // storage and server code, and the browser gets bars over HTTP and WebSocket.
            { sourceTag: "runtime:browser", notDependOnLibsWithTags: ["layer:data", "layer:data-internal"] },
          ],
        },
      ],
      // Contexts are used only through their package entry, never their internals.
      "no-restricted-imports": ["error", { patterns: [{ group: ["@aia/*/src/*", "@aia/*/src/**"], message: "Import a context only through its package entry (@aia/<context>)." }] }],
    },
  },
  {
    // domain/ is pure: no AWS SDK, no HTTP clients, no wall-clock time.
    files: ["**/src/domain/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [
        { group: ["@aws-sdk/*", "aws-sdk", "node:http", "node:https", "undici", "axios", "ws", "ioredis", "redis"], message: "domain/ is pure: move I/O to adapters/." },
        { group: ["@aia/*", "!@aia/shared-kernel"], message: "domain/ imports only @aia/shared-kernel." },
      ] }],
      "no-restricted-properties": ["error", { object: "Date", property: "now", message: "Pass time in as an argument." }],
    },
  },
];
