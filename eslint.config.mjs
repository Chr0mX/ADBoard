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
    // Generated or vendored output that is committed or built outside src.
    "dist/**",
    "target/**",
    "temp/**",
    "site/**",
    "mockups/**",
    "tools/**",
    "ADBoard-data/**",
    "adboard-data/**",
    "data/**",
  ]),
]);

export default eslintConfig;
