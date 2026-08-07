import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runRacpAgentCli } from "@rnby/racp-agent/cli";

test("testing CLI encodes and decodes without a daemon or credential", async () => {
  const stdout = [];
  const stderr = [];
  const io = {
    stdout: (value) => stdout.push(value),
    stderr: (value) => stderr.push(value),
  };
  assert.equal(
    await runRacpAgentCli(
      [
        "encode",
        "--from",
        "@a",
        "--to",
        "@b",
        "--intent",
        "query",
        "--text",
        "hello",
        "--timestamp",
        "0",
      ],
      io,
    ),
    0,
  );
  const encoded = JSON.parse(stdout.pop());
  assert.equal(encoded.protocol_version, 1);

  assert.equal(
    await runRacpAgentCli(
      ["decode", "--envelope-base64", encoded.envelope_base64],
      io,
    ),
    0,
  );
  const decoded = JSON.parse(stdout.pop());
  assert.equal(decoded.from_agent, "@a");
  assert.equal(decoded.to_agent, "@b");
  assert.equal(decoded.timestamp_ms, "0");
  assert.equal(stderr.length, 0);
});

test("packaged CLI runs through an npm-style bin symlink", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "racp-agent-bin-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const binDirectory = join(directory, "node_modules", ".bin");
  await mkdir(binDirectory, { recursive: true });
  const cliPath = fileURLToPath(
    new URL("../packages/agent/dist/cli.js", import.meta.url),
  );
  assert.notEqual((await stat(cliPath)).mode & 0o111, 0);
  const binPath = join(binDirectory, "racp-agent");
  await symlink(cliPath, binPath);

  const result = await runProcess(binPath, ["--help"]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /RACP testing CLI/);
  assert.equal(result.stderr, "");
});

function runProcess(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (value) => { stdout += value; });
    child.stderr.on("data", (value) => { stderr += value; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}
