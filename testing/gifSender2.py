import asyncio
from bleak import BleakClient

ADDRESS = "D0:CF:13:08:90:D9"

CTRL_UUID = "6e400002-b5a3-f393-e0a9-e50e24dcca9e"
DATA_UUID = "6e400003-b5a3-f393-e0a9-e50e24dcca9e"
STAT_UUID = "6e400004-b5a3-f393-e0a9-e50e24dcca9e"

GIF_PATH = "./Downloads/output_esp_8fps_48c.gif"
CHUNK = 240

def on_notify(sender, data: bytearray):
    try:
        print("[STAT]", data.decode(errors="ignore"))
    except:
        print("[STAT]", data)

async def main():
    with open(GIF_PATH, "rb") as f:
        blob = f.read()

    total = len(blob)
    print("GIF bytes:", total)

    async with BleakClient(ADDRESS, timeout=20.0) as client:
        print("Connected:", client.is_connected)

        try:
            await client.start_notify(STAT_UUID, on_notify)
            print("Notify subscribed OK")
        except Exception as e:
            print("Notify subscribe FAILED:", e)

        # START
        await client.write_gatt_char(CTRL_UUID, f"START:{total}".encode("utf-8"), response=True)

        # Stream bytes
        sent = 0
        while sent < total:
            chunk = blob[sent:sent + CHUNK]
            await client.write_gatt_char(DATA_UUID, chunk, response=False)
            sent += len(chunk)

            if (sent % (CHUNK * 50)) == 0:
                print(f"sent {sent}/{total}")
                await asyncio.sleep(0.02)

            await asyncio.sleep(0.001)  # small pacing for Windows stability

        print("Upload done. Waiting for ESP to finish...")

        # Give the ESP a moment to auto-close / set playRequested
        await asyncio.sleep(0.5)

        # <<< REPLAY HERE >>>
        # This tells the ESP: “play whatever is already stored in /gif.gif”
        await client.write_gatt_char(CTRL_UUID, b"REPLAY", response=True)

        # Optional: ask INFO after replay command
        await asyncio.sleep(0.2)
        await client.write_gatt_char(CTRL_UUID, b"INFO", response=True)

        # Keep connection briefly to see STAT messages
        await asyncio.sleep(3.0)

asyncio.run(main())
