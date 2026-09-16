import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

test("real SDK: explicit and implicit caching preserve request prefixes", {timeout: 30000}, async () => {
 const {stdout} = await promisify(execFile)(process.execPath, ["--experimental-strip-types", "--test", fileURLToPath(new URL("../prompt-cache-sdk-worker.ts", import.meta.url))], {timeout: 25000});
 assert.match(stdout, /(?:#|ℹ) pass 4/);
 assert.match(stdout, /(?:#|ℹ) fail 0/);
});
