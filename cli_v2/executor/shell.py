import subprocess


def run_shell(command: str):
    result = subprocess.run(
        command,
        shell=True,
        capture_output=True,
        text=True,
    )

    return {
        "stdout": result.stdout,
        "stderr": result.stderr,
        "return_code": result.returncode,
    }
