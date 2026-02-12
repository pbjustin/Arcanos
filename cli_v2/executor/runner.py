from .shell import run_shell


def execute_actions(actions, trace_id: str):
    results = []

    for action in actions:
        # action is an Action model instance
        if action.type == "shell" and action.command:
            print(f"[EXECUTOR] Running: {action.command}")
            results.append(run_shell(action.command))
        
        elif action.type == "read_file" and action.path:
            try:
                with open(action.path, 'r') as f:
                    results.append({"path": action.path, "content": f.read()})
            except Exception as e:
                results.append({"error": str(e)})

    return results
