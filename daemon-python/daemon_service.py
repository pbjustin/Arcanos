"""
Daemon service for HTTP-based heartbeat and command polling.
Provides HTTP-only communication with the backend for daemon management.
"""

import os
import time
import threading
from typing import Optional, Callable, Any, Mapping
from dataclasses import dataclass
import requests

from config import Config
from backend_client import BackendApiClient, BackendRequestError


@dataclass
class DaemonHeartbeatPayload:
    """Payload for daemon heartbeat"""
    clientId: str
    instanceId: str
    version: Optional[str] = None
    uptime: Optional[float] = None
    routingMode: Optional[str] = None
    stats: Optional[Mapping[str, Any]] = None


@dataclass
class DaemonCommand:
    """Represents a command from the backend"""
    id: str
    name: str
    payload: Mapping[str, Any]
    issuedAt: str


class DaemonService:
    """
    Manages daemon HTTP-based services: heartbeat and command polling.
    Runs background threads to maintain connection and receive commands.
    """

    def __init__(
        self,
        backend_client: BackendApiClient,
        instance_id: str,
        client_id: str = "arcanos-daemon",
        command_handler: Optional[Callable[[DaemonCommand], None]] = None,
        start_time: Optional[float] = None
    ):
        """
        Initialize daemon service.

        Args:
            backend_client: Backend API client for HTTP requests
            instance_id: Persistent daemon instance ID
            client_id: Client identifier (default: "arcanos-daemon")
            command_handler: Callback function to handle received commands
            start_time: Application start time for uptime calculation
        """
        self.backend_client = backend_client
        self.instance_id = instance_id
        self.client_id = client_id
        self.command_handler = command_handler
        self.start_time = start_time or time.time()
        self.version = Config.VERSION

        self._heartbeat_thread: Optional[threading.Thread] = None
        self._command_poll_thread: Optional[threading.Thread] = None
        self._running = False
        self._heartbeat_interval = int(os.getenv("DAEMON_HEARTBEAT_INTERVAL_SECONDS", "30"))
        self._command_poll_interval = 10  # Poll commands every 10 seconds

    def start(self) -> None:
        """Start heartbeat and command polling threads"""
        if self._running:
            return

        self._running = True

        # Start heartbeat thread
        self._heartbeat_thread = threading.Thread(
            target=self._heartbeat_loop,
            daemon=True,
            name="daemon-heartbeat"
        )
        self._heartbeat_thread.start()

        # Start command polling thread
        if self.command_handler:
            self._command_poll_thread = threading.Thread(
                target=self._command_poll_loop,
                daemon=True,
                name="daemon-command-poll"
            )
            self._command_poll_thread.start()

    def stop(self) -> None:
        """Stop heartbeat and command polling threads"""
        self._running = False
        if self._heartbeat_thread:
            self._heartbeat_thread.join(timeout=5.0)
        if self._command_poll_thread:
            self._command_poll_thread.join(timeout=5.0)

    def _heartbeat_loop(self) -> None:
        """Background thread that sends periodic heartbeats"""
        while self._running:
            try:
                uptime = time.time() - self.start_time
                payload = DaemonHeartbeatPayload(
                    clientId=self.client_id,
                    instanceId=self.instance_id,
                    version=self.version,
                    uptime=uptime,
                    routingMode="http",
                    stats={}
                )

                # Send heartbeat via backend client
                response = self.backend_client._make_request(
                    "POST",
                    "/api/daemon/heartbeat",
                    json={
                        "clientId": payload.clientId,
                        "instanceId": payload.instanceId,
                        "version": payload.version,
                        "uptime": payload.uptime,
                        "routingMode": payload.routingMode,
                        "stats": payload.stats or {}
                    }
                )

                if response.status_code == 200:
                    # Heartbeat successful
                    pass
                else:
                    # Log error but continue
                    print(f"[DAEMON SERVICE] Heartbeat failed: {response.status_code}")

            except Exception as e:
                # Log error but continue
                print(f"[DAEMON SERVICE] Heartbeat error: {e}")

            # Wait for next heartbeat
            time.sleep(self._heartbeat_interval)

    def _command_poll_loop(self) -> None:
        """Background thread that polls for commands"""
        while self._running:
            try:
                # Poll for commands
                response = self.backend_client._make_request(
                    "GET",
                    f"/api/daemon/commands?instance_id={self.instance_id}"
                )

                if response.status_code == 200:
                    data = response.json()
                    commands = data.get("commands", [])

                    if commands and self.command_handler:
                        # Process each command
                        command_ids = []
                        for cmd_data in commands:
                            try:
                                command = DaemonCommand(
                                    id=cmd_data["id"],
                                    name=cmd_data["name"],
                                    payload=cmd_data["payload"],
                                    issuedAt=cmd_data["issuedAt"]
                                )
                                # Call handler
                                self.command_handler(command)
                                command_ids.append(command.id)
                            except Exception as e:
                                print(f"[DAEMON SERVICE] Error handling command {cmd_data.get('id')}: {e}")

                        # Acknowledge processed commands
                        if command_ids:
                            try:
                                ack_response = self.backend_client._make_request(
                                    "POST",
                                    "/api/daemon/commands/ack",
                                    json={
                                        "commandIds": command_ids,
                                        "instanceId": self.instance_id
                                    }
                                )
                                if ack_response.status_code != 200:
                                    print(f"[DAEMON SERVICE] Command ack failed: {ack_response.status_code}")
                            except Exception as e:
                                print(f"[DAEMON SERVICE] Command ack error: {e}")

                elif response.status_code == 401:
                    # Authentication failed, stop polling
                    print("[DAEMON SERVICE] Authentication failed, stopping command polling")
                    break
                else:
                    # Log error but continue
                    print(f"[DAEMON SERVICE] Command poll failed: {response.status_code}")

            except BackendRequestError as e:
                # Network/request error, log and continue
                print(f"[DAEMON SERVICE] Command poll request error: {e}")
            except Exception as e:
                # Unexpected error, log and continue
                print(f"[DAEMON SERVICE] Command poll error: {e}")

            # Wait before next poll
            time.sleep(self._command_poll_interval)
