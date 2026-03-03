from runtime import Runtime
from bridge.trace import generate_trace_id
from bridge.escalation import should_escalate
from bridge.client import BackendClient
from context.session import Session
from executor.runner import execute_actions


def run_command(command: str):
    """
    Purpose: Execute one cli_v2 command cycle with optional backend escalation.
    Inputs/Outputs: command string; prints backend output and action execution results.
    Edge cases: Non-escalating requests are handled locally with a no-op response.
    """
    trace_id = generate_trace_id()
    runtime = Runtime.from_env(trace_id)
    session = Session(trace_id)

    context_payload = session.gather_context(command)

    if should_escalate(context_payload, trace_id):
        backend = BackendClient(runtime)
        response = backend.analyze(context_payload, [])
        
        # Display backend result
        print(f"\n[BACKEND] {response.result}")
        
        # Execute structured actions if any
        if response.actions:
            print(f"[SYSTEM] Executing {len(response.actions)} actions...")
            results = execute_actions(response.actions, trace_id)
            # In a real scenario, we might send these results back for a second turn
            for res in results:
                # //audit Assumption: action outputs may include stdout and stderr; risk: hidden execution failures; invariant: both streams surfaced when present; handling: print each non-empty stream.
                if res.get("stdout"):
                    print(f"[STDOUT] {res['stdout'][:200]}")
                if res.get("stderr"):
                    print(f"[STDERR] {res['stderr'][:200]}")
    else:
        print("Handled locally (no escalation).")


def main():
    """
    Purpose: Interactive entrypoint for single-command cli_v2 testing.
    Inputs/Outputs: prompts for one command and runs it.
    Edge cases: Empty command still flows through run_command for policy evaluation.
    """
    command = input("ARCANOS> ")
    run_command(command)


if __name__ == "__main__":
    main()
