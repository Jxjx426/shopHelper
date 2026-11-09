import { spawn } from "node:child_process";
// Explicit opt-in: the normal test suite does not start a network listener.
const child = spawn(
  process.execPath,
  ["--import", "tsx", "--test", "tests/cloud.test.ts"],
  { stdio: "inherit", env: { ...process.env, SHOP_TEST_CLOUD: "true" } },
);
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
