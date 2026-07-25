# ============================== #
#                                #
#  NE PAS MODIFIER CE FICHIER    #
#   DO NOT MODIFY THIS FILE      #
#                                #
# ============================== #

import json
import threading
import time
from typing import Callable
from urllib.parse import quote

import websocket

from client.message_protocol import ActionBase, GameState


class GameClient:
    _RECORD_SEPARATOR = "\x1e"

    def __init__(self, url: str, token: str):
        self._url = url.rstrip("/")
        self._token = token
        self._socket: websocket.WebSocket | None = None
        self._receiver_thread: threading.Thread | None = None
        self._running = False
        self._handlers: dict[str, Callable] = {}
        self._send_lock = threading.Lock()
        self._authenticated = threading.Event()
        self._auth_error: Exception | None = None
        self._current_state = GameState()
        self._action_gate = threading.Lock()
        self._last_action_tick_sent = -1
        self._on_update: Callable[[GameState], ActionBase | None] | None = None

        self._on("Authenticated", self._on_authenticated)
        self._on("Error", self._on_error)

    def connect(self) -> bool:
        try:
            self._socket = websocket.create_connection(
                self._build_hub_url(),
                timeout=10,
                header=[
                    "User-Agent: JDISBotPython/1.0",
                    f"Origin: {self._origin_url()}",
                ],
                enable_multithread=True,
            )

            self._running = True
            self._send_raw({"protocol": "json", "version": 1})
            self._receiver_thread = threading.Thread(target=self._receive_loop, daemon=True)
            self._receiver_thread.start()

            print("[INFO] Network connection established, waiting for token validation...")

            if not self._authenticated.wait(timeout=5):
                raise TimeoutError("No authentication response from the server.")

            if self._auth_error is not None:
                raise self._auth_error

            return True
        except Exception as ex:
            print(f"[ERROR] Connection failed: {ex}")
            self.stop()
            return False

    def backend_listening(self, on_update: Callable[[GameState], ActionBase | None]) -> None:
        self._on_update = on_update
        self._on("Tick", self._on_tick)
        self._on("ReceiveVisibleMap", self._on_receive_visible_map)
        self._on("ReceivePlayerInfo", self._on_receive_player_info)

    def stop(self) -> None:
        self._running = False
        if self._socket is not None:
            try:
                self._socket.close()
            except Exception:
                pass
            self._socket = None

    def _on_authenticated(self, *args) -> None:
        print("[AUTH] Successfully authenticated.")
        self._authenticated.set()

    def _on_error(self, *args) -> None:
        message = self._first_arg(args)
        if not self._authenticated.is_set():
            self._auth_error = Exception(str(message))
            print(f"[AUTH] Authentication error: {message}")
            self._authenticated.set()
            return
        print(f"[SERVER] Error: {message}")

    def _on_tick(self, *args) -> None:
        try:
            data = self._first_arg(args)
            if isinstance(data, dict):
                self._current_state.CurrentTick = int(data.get("tick", self._current_state.CurrentTick))
            self._try_send_action()
        except Exception as ex:
            print(f"[ERROR] Tick: {ex}")

    def _on_receive_visible_map(self, *args) -> None:
        try:
            data = self._first_arg(args)
            if isinstance(data, dict):
                self._current_state.update_vision_from_server(data)
            self._try_send_action()
        except Exception as ex:
            print(f"[ERROR] ReceiveVisibleMap: {ex}")

    def _on_receive_player_info(self, *args) -> None:
        data = self._first_arg(args)
        if isinstance(data, dict):
            self._current_state.update_player(data)

    def _try_send_action(self) -> None:
        if self._on_update is None:
            return

        with self._action_gate:
            self._try_send_action_core()

    def _try_send_action_core(self) -> None:
        if self._current_state.Bot is None:
            print("[BOT] Waiting for bot state initialization...")
            return

        if self._current_state.CurrentTick <= self._last_action_tick_sent:
            return

        action = self._on_update(self._current_state) if self._on_update else None
        if action is None:
            return

        self._last_action_tick_sent = self._current_state.CurrentTick

        envelope = {
            "type": "COMMAND",
            "action": action.to_server_payload(),
            "tick": self._current_state.CurrentTick,
        }

        print("=== [BOT->SERVER] Sending JSON ===")
        print(json.dumps(envelope, indent=2, ensure_ascii=False))
        print("===============================")

        self._send_invocation("SubmitAction", [envelope])

    def _on(self, target: str, handler: Callable) -> None:
        self._handlers[target] = handler

    def _origin_url(self) -> str:
        if self._url.startswith("http://") or self._url.startswith("https://"):
            return self._url
        return f"http://{self._url}"

    def _build_hub_url(self) -> str:
        scheme = "wss" if self._url.startswith("https://") else "ws"
        host = self._url.split("://", 1)[1] if "://" in self._url else self._url
        token = quote(self._token, safe="")
        return f"{scheme}://{host}/api/hub?token={token}&type=bot"

    def _receive_loop(self) -> None:
        buffer = ""

        while self._running and self._socket is not None:
            try:
                message = self._socket.recv()
                if isinstance(message, bytes):
                    message = message.decode("utf-8")
                buffer += message

                while self._RECORD_SEPARATOR in buffer:
                    frame, buffer = buffer.split(self._RECORD_SEPARATOR, 1)
                    self._handle_frame(frame)
            except websocket.WebSocketConnectionClosedException:
                break
            except Exception as ex:
                if not self._authenticated.is_set():
                    self._auth_error = ex
                    self._authenticated.set()
                else:
                    print(f"[ERROR] Connection lost: {ex}")
                break

        self._running = False

    def _handle_frame(self, frame: str) -> None:
        if frame.strip() == "":
            return

        data = json.loads(frame)
        if data == {}:
            return

        message_type = int(data.get("type", 0))
        if message_type == 1:
            target = str(data.get("target", ""))
            handler = self._handlers.get(target)
            if handler is not None:
                handler(*(data.get("arguments", []) or []))
        elif message_type == 7:
            error = data.get("error", "The server closed the connection.")
            if not self._authenticated.is_set():
                self._auth_error = Exception(str(error))
                self._authenticated.set()
            else:
                print(f"[SERVER] Connection closed: {error}")
            self.stop()

    def _send_invocation(self, target: str, arguments: list) -> None:
        self._send_raw({"type": 1, "target": target, "arguments": arguments})

    def _send_raw(self, payload: dict) -> None:
        if self._socket is None:
            raise ConnectionError("The WebSocket connection is not open.")

        with self._send_lock:
            self._socket.send(json.dumps(payload, separators=(",", ":"), ensure_ascii=False) + self._RECORD_SEPARATOR)

    @staticmethod
    def _first_arg(args):
        if len(args) == 1 and isinstance(args[0], list) and len(args[0]) > 0:
            return args[0][0]
        if len(args) > 0:
            return args[0]
        return None
