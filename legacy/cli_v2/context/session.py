from .scanner import ContextScanner

class Session:

    def __init__(self, trace_id: str):
        self.trace_id = trace_id
        self.history = []
        self.scanner = ContextScanner()

    def gather_context(self, command: str) -> dict:
        env_context = self.scanner.scan()
        token_estimate = len(command.split()) + len(str(env_context).split())

        context = {
            "command": command,
            "token_estimate": token_estimate,
            "file_count": 1,
            "content": command,
            "env": env_context
        }

        self.history.append(context)
        return context
