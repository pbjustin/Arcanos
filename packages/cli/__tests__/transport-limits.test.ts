import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { afterAll, beforeAll, describe, expect, it, jest } from "@jest/globals";
import { createProtocolRequest } from "@arcanos/protocol";

import {
  MAX_PYTHON_TRANSPORT_OUTPUT_BYTES,
  MAX_PYTHON_TRANSPORT_TIMEOUT_MS,
  dispatchProtocolRequest
} from "../src/transport.js";
import { requestPythonTransportProcessTreeTermination } from "../src/internal/pythonTransportProcessTree.js";

const pythonBinary = process.env.PYTHON ?? "python";
const originalRuntimeDirectory = process.env.ARCANOS_PYTHON_RUNTIME_DIR;
const originalTestMode = process.env.ARCANOS_TRANSPORT_TEST_MODE;
const originalStdoutFile = process.env.ARCANOS_TRANSPORT_TEST_STDOUT_FILE;
const originalStderrFile = process.env.ARCANOS_TRANSPORT_TEST_STDERR_FILE;
const originalExitCode = process.env.ARCANOS_TRANSPORT_TEST_EXIT_CODE;
const originalMarker = process.env.ARCANOS_TRANSPORT_TEST_MARKER;
const originalReadyMarker = process.env.ARCANOS_TRANSPORT_TEST_READY_MARKER;
const originalTriggerMarker = process.env.ARCANOS_TRANSPORT_TEST_TRIGGER_MARKER;
const describeWithPython = isPythonRuntimeAvailable() ? describe : describe.skip;
let runtimeDirectory = "";

function request(requestId = "transport-limit-request") {
  return createProtocolRequest({
    requestId,
    command: "run.start" as const,
    payload: {}
  });
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

async function configureOutput(stdout: string, stderr = "", exitCode = 0): Promise<number> {
  const stdoutPath = path.join(runtimeDirectory, `stdout-${Date.now()}-${Math.random()}.txt`);
  const stderrPath = path.join(runtimeDirectory, `stderr-${Date.now()}-${Math.random()}.txt`);
  await Promise.all([
    writeFile(stdoutPath, stdout, "utf8"),
    writeFile(stderrPath, stderr, "utf8")
  ]);
  process.env.ARCANOS_TRANSPORT_TEST_MODE = "emit-files";
  process.env.ARCANOS_TRANSPORT_TEST_STDOUT_FILE = stdoutPath;
  process.env.ARCANOS_TRANSPORT_TEST_STDERR_FILE = stderrPath;
  process.env.ARCANOS_TRANSPORT_TEST_EXIT_CODE = String(exitCode);
  return Buffer.byteLength(stdout) + Buffer.byteLength(stderr);
}

function isPythonRuntimeAvailable(): boolean {
  try {
    return spawnSync(pythonBinary, ["--version"], {
      stdio: "ignore",
      timeout: 5_000,
      windowsHide: true
    }).status === 0;
  } catch {
    return false;
  }
}

async function configureTreeScenario(mode: "timeout-tree" | "overflow-tree") {
  const suffix = `${mode}-${Date.now()}-${Math.random()}`;
  const readyMarker = path.join(runtimeDirectory, `${suffix}-ready.txt`);
  const triggerMarker = path.join(runtimeDirectory, `${suffix}-trigger.txt`);
  const lateMarker = path.join(runtimeDirectory, `${suffix}-late.txt`);
  process.env.ARCANOS_TRANSPORT_TEST_MODE = mode;
  process.env.ARCANOS_TRANSPORT_TEST_READY_MARKER = readyMarker;
  process.env.ARCANOS_TRANSPORT_TEST_TRIGGER_MARKER = triggerMarker;
  process.env.ARCANOS_TRANSPORT_TEST_MARKER = lateMarker;
  return { readyMarker, triggerMarker, lateMarker };
}

async function waitForFile(filePath: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(filePath)) {
      return;
    }
    await delay(25);
  }
  throw new Error(`Timed out waiting for fixture marker ${path.basename(filePath)}.`);
}

function captureDispatchOutcome(promise: ReturnType<typeof dispatchProtocolRequest>) {
  return promise.then(
    () => ({ error: null }),
    error => ({ error: error instanceof Error ? error : new Error(String(error)) })
  );
}

async function assertLateDescendantCannotWrite(
  triggerMarker: string,
  lateMarker: string
): Promise<void> {
  await writeFile(triggerMarker, "go", "utf8");
  await delay(1_200);
  expect(existsSync(lateMarker)).toBe(false);
}

describe("Python transport option bounds", () => {
  it.each([
    [{ timeoutMs: 0 }, `Python transport timeoutMs must be a positive integer no greater than ${MAX_PYTHON_TRANSPORT_TIMEOUT_MS}.`],
    [{ timeoutMs: MAX_PYTHON_TRANSPORT_TIMEOUT_MS + 1 }, `Python transport timeoutMs must be a positive integer no greater than ${MAX_PYTHON_TRANSPORT_TIMEOUT_MS}.`],
    [{ maxOutputBytes: 1.5 }, `Python transport maxOutputBytes must be a positive integer no greater than ${MAX_PYTHON_TRANSPORT_OUTPUT_BYTES}.`],
    [{ maxOutputBytes: MAX_PYTHON_TRANSPORT_OUTPUT_BYTES + 1 }, `Python transport maxOutputBytes must be a positive integer no greater than ${MAX_PYTHON_TRANSPORT_OUTPUT_BYTES}.`]
  ])("rejects invalid limits before spawning: %o", async (limits, message) => {
    await expect(dispatchProtocolRequest(
      request(),
      "python",
      { pythonBinary: "must-not-be-spawned", ...limits }
    )).rejects.toThrow(message);
  });
});

describeWithPython("bounded Python protocol transport integration", () => {
  beforeAll(async () => {
    runtimeDirectory = await mkdtemp(path.join(tmpdir(), "arcanos-cli-transport-"));
    const packageDirectory = path.join(runtimeDirectory, "arcanos");
    await mkdir(packageDirectory);
    await writeFile(path.join(packageDirectory, "__init__.py"), "", "utf8");
    await writeFile(
      path.join(packageDirectory, "protocol_runtime.py"),
      [
        "import os",
        "import pathlib",
        "import subprocess",
        "import sys",
        "import time",
        "mode = os.environ.get('ARCANOS_TRANSPORT_TEST_MODE', '')",
        "if mode == 'emit-files':",
        "    stdout_path = os.environ.get('ARCANOS_TRANSPORT_TEST_STDOUT_FILE')",
        "    stderr_path = os.environ.get('ARCANOS_TRANSPORT_TEST_STDERR_FILE')",
        "    if stdout_path:",
        "        sys.stdout.buffer.write(pathlib.Path(stdout_path).read_bytes())",
        "        sys.stdout.buffer.flush()",
        "    if stderr_path:",
        "        sys.stderr.buffer.write(pathlib.Path(stderr_path).read_bytes())",
        "        sys.stderr.buffer.flush()",
        "    raise SystemExit(int(os.environ.get('ARCANOS_TRANSPORT_TEST_EXIT_CODE', '0')))",
        "if mode in ('timeout-tree', 'overflow-tree'):",
        "    ready_marker = os.environ['ARCANOS_TRANSPORT_TEST_READY_MARKER']",
        "    trigger_marker = os.environ['ARCANOS_TRANSPORT_TEST_TRIGGER_MARKER']",
        "    late_marker = os.environ['ARCANOS_TRANSPORT_TEST_MARKER']",
        "    child_code = '\\n'.join([",
        "        'import pathlib',",
        "        'import sys',",
        "        'import time',",
        "        'trigger = pathlib.Path(sys.argv[1])',",
        "        'marker = pathlib.Path(sys.argv[2])',",
        "        'while not trigger.exists():',",
        "        '    time.sleep(0.02)',",
        "        'time.sleep(0.5)',",
        "        'marker.write_text(\"late\", encoding=\"utf-8\")',",
        "    ])",
        "    subprocess.Popen(",
        "        [sys.executable, '-c', child_code, trigger_marker, late_marker],",
        "        stdin=subprocess.DEVNULL,",
        "        stdout=subprocess.DEVNULL,",
        "        stderr=subprocess.DEVNULL,",
        "    )",
        "    pathlib.Path(ready_marker).write_text('ready', encoding='utf-8')",
        "    if mode == 'overflow-tree':",
        "        sys.stdout.buffer.write(b'x' * 4097)",
        "        sys.stdout.buffer.flush()",
        "    time.sleep(10)",
        "raise SystemExit(2)",
        ""
      ].join("\n"),
      "utf8"
    );
    process.env.ARCANOS_PYTHON_RUNTIME_DIR = runtimeDirectory;
  });

  afterAll(async () => {
    restoreEnvironment("ARCANOS_PYTHON_RUNTIME_DIR", originalRuntimeDirectory);
    restoreEnvironment("ARCANOS_TRANSPORT_TEST_MODE", originalTestMode);
    restoreEnvironment("ARCANOS_TRANSPORT_TEST_STDOUT_FILE", originalStdoutFile);
    restoreEnvironment("ARCANOS_TRANSPORT_TEST_STDERR_FILE", originalStderrFile);
    restoreEnvironment("ARCANOS_TRANSPORT_TEST_EXIT_CODE", originalExitCode);
    restoreEnvironment("ARCANOS_TRANSPORT_TEST_MARKER", originalMarker);
    restoreEnvironment("ARCANOS_TRANSPORT_TEST_READY_MARKER", originalReadyMarker);
    restoreEnvironment("ARCANOS_TRANSPORT_TEST_TRIGGER_MARKER", originalTriggerMarker);
    await rm(runtimeDirectory, { recursive: true, force: true });
  });

  it("accepts output exactly at the byte limit even when Python exits nonzero", async () => {
    const responseJson = JSON.stringify({
      protocol: "arcanos-v1",
      requestId: "exact-limit",
      ok: false,
      error: { message: "expected protocol failure" }
    });
    const exactBytes = await configureOutput(responseJson, "", 1);

    await expect(dispatchProtocolRequest(
      request("exact-limit"),
      "python",
      { pythonBinary, timeoutMs: 2_000, maxOutputBytes: exactBytes }
    )).resolves.toMatchObject({
      requestId: "exact-limit",
      ok: false
    });
  });

  it("rejects one combined UTF-8 output byte over the limit without disclosure", async () => {
    const disclosureMarker = "credential-marker-must-not-leak";
    const responseJson = JSON.stringify({
      protocol: "arcanos-v1",
      requestId: "combined-overflow",
      ok: true
    });
    const totalBytes = await configureOutput(responseJson, disclosureMarker);

    const error = await dispatchProtocolRequest(
      request("combined-overflow"),
      "python",
      { pythonBinary, timeoutMs: 2_000, maxOutputBytes: totalBytes - 1 }
    ).catch(value => value as Error);

    expect(error.message).toBe(
      `Python transport output exceeded ${totalBytes - 1} bytes.`
    );
    expect(error.message).not.toContain(disclosureMarker);
  });

  it.each([
    ["not-json", "credential-marker-invalid-json", "Python transport returned invalid JSON."],
    ["", "credential-marker-no-output", "Python transport returned no JSON output."],
    ["", "ModuleNotFoundError: No module named 'credential-marker'", "Python transport runtime dependency is unavailable."]
  ])("returns a fixed redacted error for malformed runtime output", async (stdout, stderr, expectedMessage) => {
    await configureOutput(stdout, stderr, 1);

    const error = await dispatchProtocolRequest(
      request("redacted-error"),
      "python",
      { pythonBinary, timeoutMs: 2_000, maxOutputBytes: 4_096 }
    ).catch(value => value as Error);

    expect(error.message).toBe(expectedMessage);
    expect(error.message).not.toContain("credential-marker");
  });

  it("kills a confirmed-started subprocess tree when the deadline expires", async () => {
    const markers = await configureTreeScenario("timeout-tree");
    const outcome = captureDispatchOutcome(dispatchProtocolRequest(
      request("timeout-tree"),
      "python",
      { pythonBinary, timeoutMs: 3_000, maxOutputBytes: 4_096 }
    ));

    await waitForFile(markers.readyMarker, 2_000);
    const result = await outcome;
    expect(result.error?.message).toBe("Python transport timed out after 3000ms.");
    await assertLateDescendantCannotWrite(markers.triggerMarker, markers.lateMarker);
  }, 10_000);

  it("kills a confirmed-started subprocess tree when output exceeds the cap", async () => {
    const markers = await configureTreeScenario("overflow-tree");
    const outcome = captureDispatchOutcome(dispatchProtocolRequest(
      request("overflow-tree"),
      "python",
      { pythonBinary, timeoutMs: 5_000, maxOutputBytes: 4_096 }
    ));

    await waitForFile(markers.readyMarker, 2_000);
    const result = await outcome;
    expect(result.error?.message).toBe("Python transport output exceeded 4096 bytes.");
    await assertLateDescendantCannotWrite(markers.triggerMarker, markers.lateMarker);
  }, 10_000);
});

describe("Python transport process-tree termination", () => {
  it("kills the detached POSIX process group", async () => {
    const kill = jest.fn<() => boolean>(() => true);
    const killProcessGroup = jest.fn<(pid: number, signal: NodeJS.Signals) => void>();

    await expect(requestPythonTransportProcessTreeTermination(
      { pid: 321, kill } as never,
      { platform: "linux", killProcessGroup }
    )).resolves.toEqual({
      method: "posix-process-group",
      treeTerminationConfirmed: true
    });

    expect(killProcessGroup).toHaveBeenCalledWith(-321, "SIGKILL");
    expect(kill).not.toHaveBeenCalled();
  });

  it("uses absolute asynchronous taskkill with tree and force flags on Windows", async () => {
    const kill = jest.fn<() => boolean>(() => true);
    const taskkillProcess = Object.assign(new EventEmitter(), {
      kill: jest.fn<() => boolean>(() => true),
      unref: jest.fn<() => void>()
    });
    const spawnProcess = jest.fn(() => taskkillProcess as never);

    const termination = requestPythonTransportProcessTreeTermination(
      { pid: 654, kill } as never,
      {
        platform: "win32",
        systemRoot: "C:\\Windows",
        spawnProcess: spawnProcess as never
      }
    );
    taskkillProcess.emit("close", 0);

    await expect(termination).resolves.toEqual({
      method: "windows-taskkill",
      treeTerminationConfirmed: true
    });
    expect(spawnProcess).toHaveBeenCalledWith(
      "C:\\Windows\\System32\\taskkill.exe",
      ["/PID", "654", "/T", "/F"],
      expect.objectContaining({ windowsHide: true, stdio: "ignore" })
    );
    expect(taskkillProcess.unref).toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
  });

  it("bounds Windows taskkill and reports an unconfirmed direct-child fallback", async () => {
    const kill = jest.fn<() => boolean>(() => true);
    const taskkillProcess = Object.assign(new EventEmitter(), {
      kill: jest.fn<() => boolean>(() => true),
      unref: jest.fn<() => void>()
    });

    await expect(requestPythonTransportProcessTreeTermination(
      { pid: 765, kill } as never,
      {
        platform: "win32",
        systemRoot: "C:\\Windows",
        spawnProcess: (() => taskkillProcess as never) as never,
        windowsTaskkillTimeoutMs: 10
      }
    )).resolves.toEqual({
      method: "direct-child-fallback",
      treeTerminationConfirmed: false
    });

    expect(taskkillProcess.kill).toHaveBeenCalledWith("SIGKILL");
    expect(kill).toHaveBeenCalledWith("SIGKILL");
    taskkillProcess.emit("close", 0);
    expect(kill).toHaveBeenCalledTimes(1);
  });

  it("reports an unconfirmed direct-child fallback when group termination fails", async () => {
    const kill = jest.fn<() => boolean>(() => true);

    await expect(requestPythonTransportProcessTreeTermination(
      { pid: 987, kill } as never,
      {
        platform: "linux",
        killProcessGroup: () => {
          throw new Error("missing group");
        }
      }
    )).resolves.toEqual({
      method: "direct-child-fallback",
      treeTerminationConfirmed: false
    });

    expect(kill).toHaveBeenCalledWith("SIGKILL");
  });
});
