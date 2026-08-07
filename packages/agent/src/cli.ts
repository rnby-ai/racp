#!/usr/bin/env node
import {
  base64ToBytes,
  bytesToBase64,
  bytesToHex,
  intentCodeForName,
  pack,
  unpack,
} from "@rnby/racp-codec";
import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export const RACP_AGENT_CLI_HELP = `RACP testing CLI (offline codec harness)

Usage:
  racp-agent encode --from @sender --to @recipient --intent query --text "hello" [--task UUID] [--timestamp MS]
  racp-agent encode --from @sender --to @recipient --intent query --payload-base64 BASE64 [--task UUID] [--timestamp MS]
  racp-agent decode --envelope-base64 BASE64

This CLI does not register agents, hold credentials, run a daemon, or connect to
a production transport. Use createHostedRacpAgent() with caller-supplied secure
OAuth storage for live agents.`;

type CliIo = {
  stdout(value: string): void;
  stderr(value: string): void;
};

export async function runRacpAgentCli(
  args: readonly string[],
  io: CliIo,
): Promise<number> {
  const [command, ...rest] = args;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    io.stdout(`${RACP_AGENT_CLI_HELP}\n`);
    return 0;
  }

  try {
    if (command === "encode") {
      const flags = parseFlags(rest);
      const fromAgent = requiredFlag(flags, "from");
      const toAgent = requiredFlag(flags, "to");
      const intentCode = intentCodeForName(requiredFlag(flags, "intent"));
      const hasText = flags.has("text");
      const hasBase64 = flags.has("payload-base64");
      if (Number(hasText) + Number(hasBase64) !== 1) {
        throw new Error("Provide exactly one --text or --payload-base64 value.");
      }
      const payload = hasText
        ? new TextEncoder().encode(flags.get("text") ?? "")
        : base64ToBytes(flags.get("payload-base64") ?? "");
      const sentAtMillis = flags.has("timestamp")
        ? BigInt(requiredFlag(flags, "timestamp"))
        : BigInt(Date.now());
      const packed = await pack({
        intentCode,
        fromAgent,
        toAgent,
        taskId: flags.get("task") ?? null,
        sentAtMillis,
        payload,
      });
      io.stdout(
        `${JSON.stringify(
          {
            protocol_version: 1,
            envelope_base64: bytesToBase64(packed.envelope),
            payload_sha256_hex: bytesToHex(packed.payloadHash),
          },
          null,
          2,
        )}\n`,
      );
      return 0;
    }

    if (command === "decode") {
      const flags = parseFlags(rest);
      const decoded = await unpack(
        base64ToBytes(requiredFlag(flags, "envelope-base64")),
      );
      io.stdout(
        `${JSON.stringify(
          {
            protocol_version: decoded.version,
            intent: decoded.intent.toLowerCase(),
            intent_code: decoded.intentCode,
            from_agent: decoded.fromAgent,
            to_agent: decoded.toAgent,
            task_id: decoded.taskId,
            timestamp_ms: decoded.sentAtMillis.toString(),
            payload_base64: bytesToBase64(decoded.payload),
            payload_sha256_hex: bytesToHex(decoded.payloadHash),
          },
          null,
          2,
        )}\n`,
      );
      return 0;
    }

    throw new Error(`Unknown command: ${command}`);
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : "RACP CLI failed."}\n`);
    return 1;
  }
}

function parseFlags(args: readonly string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new Error(`Invalid argument near ${key ?? "end of command"}.`);
    }
    const name = key.slice(2);
    if (!name || flags.has(name)) throw new Error(`Duplicate or empty flag: ${key}`);
    flags.set(name, value);
  }
  return flags;
}

function requiredFlag(flags: ReadonlyMap<string, string>, name: string): string {
  const value = flags.get(name);
  if (value === undefined) throw new Error(`--${name} is required.`);
  return value;
}

const entryPath = process.argv[1];
if (entryPath && await isDirectEntry(entryPath)) {
  const exitCode = await runRacpAgentCli(process.argv.slice(2), {
    stdout: (value) => process.stdout.write(value),
    stderr: (value) => process.stderr.write(value),
  });
  process.exitCode = exitCode;
}

async function isDirectEntry(entryPath: string): Promise<boolean> {
  try {
    const [modulePath, invokedPath] = await Promise.all([
      realpath(fileURLToPath(import.meta.url)),
      realpath(entryPath),
    ]);
    return modulePath === invokedPath;
  } catch {
    return false;
  }
}
