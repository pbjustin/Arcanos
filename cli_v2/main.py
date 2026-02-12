from runtime import Runtime
from bridge.trace import generate_trace_id
from bridge.escalation import should_escalate
from bridge.client import BackendClient
from context.session import Session
from executor.runner import execute_actions


def run_command(command: str):
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
                if "stdout" in res:
                    print(f"[STDOUT] {res['stdout'][:200]}")
    else:
        print("Handled locally (no escalation).")


def main():
    command = input("ARCANOS> ")
    run_command(command)


if __name__ == "__main__":
    main()
