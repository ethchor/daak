#!/usr/bin/env node
/**
 * Run the TypeScript CLI with no build step.
 *
 * D-02 says packages export `./src/index.ts` and nothing is compiled, which
 * works everywhere except here: Node's type stripping does not rewrite the
 * `./thing.js` specifiers the repo writes (and must write, under
 * `verbatimModuleSyntax`) onto the `./thing.ts` files that actually exist.
 * Vitest and `tsc` both do that mapping; plain `node` does not.
 *
 * Rather than add a runner dependency for one script, this maps the extension
 * itself. Fifteen lines, no build, and the same source runs under the tests.
 */
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && specifier.endsWith(".js") && context.parentURL) {
      const candidate = new URL(specifier.slice(0, -3) + ".ts", context.parentURL);
      if (existsSync(fileURLToPath(candidate))) {
        return { url: candidate.href, shortCircuit: true };
      }
    }
    return nextResolve(specifier, context);
  },
});

await import(pathToFileURL(new URL("../src/cli.ts", import.meta.url).pathname).href);
