import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Static public assets are not application source.
    "public/**",
    // Generated / opaque outputs
    "dist/**",
    "coverage/**",
    // Local upstream/reference archives and generated scratch are not source.
    "_archive/**",
    "_temp/**",
  ]),
  {
    rules: {
      // Sci-Pegasus does not enable the React Compiler. Mature client state
      // containers use mutable refs and external stores outside its subset.
      "react-hooks/refs": "off",
      "react-hooks/purity": "off",
      "react-hooks/preserve-manual-memoization": "off",
      "react-hooks/set-state-in-effect": "off",
    },
  },
]);

export default eslintConfig;
