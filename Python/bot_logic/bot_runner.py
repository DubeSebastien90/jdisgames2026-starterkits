# ============================== #
#                                #
#  NE PAS MODIFIER CE FICHIER    #
#   DO NOT MODIFY THIS FILE      #
#                                #
# ============================== #

import time
import traceback

from bot import Bot
from client.game_client import GameClient


class BotRunner:
    @staticmethod
    def run(server_url: str, token: str) -> None:
        bot = Bot()
        print("[SUCCESS] Bot loaded.")

        client = GameClient(server_url, token)

        def on_update(state):
            try:
                return bot.get_next_action(state)
            except Exception as ex:
                print(f"[ERROR] Bot error: {ex}")
                traceback.print_exc()
                return None

        client.backend_listening(on_update)

        try:
            print(f"[INFO] Connecting to server: {server_url}")
            connected = client.connect()
            if not connected:
                print("[ERROR] The bot could not authenticate.")
                return

            print("[SUCCESS] Connected and authenticated to the server.")
        except Exception as ex:
            print("[ERROR] Could not connect to the remote server.")
            print(f"-> Details: {ex}")
            return

        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            client.stop()
            print("[INFO] Bot stopped.")
