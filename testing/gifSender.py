import asyncio
from bleak import BleakClient

ADDRESS = "E0:72:A1:E7:DE:B9"

CTRL_UUID = "6e400002-b5a3-f393-e0a9-e50e24dcca9e"
DATA_UUID = "6e400003-b5a3-f393-e0a9-e50e24dcca9e"
STAT_UUID = "6e400004-b5a3-f393-e0a9-e50e24dcca9e"

GIF_PATH = "./Downloads/output_esp_8fps_48c.gif"

# Conservative chunk size for Windows BLE reliability
# CHUNK = 180  # bytes
# CHUNK = 120
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

        # Subscribe to status notifications (optional but very useful)
        ok_notify = False
        try:
            await client.start_notify(STAT_UUID, on_notify)
            ok_notify = True
            print("Notify subscribed OK")
        except Exception as e:
            print("Notify subscribe FAILED:", e)


        # START
        await client.write_gatt_char(CTRL_UUID, f"START:{total}".encode("utf-8"), response=True)

        # Stream bytes
        sent = 0
        while sent < total:
            chunk = blob[sent:sent+CHUNK]
            await client.write_gatt_char(DATA_UUID, chunk, response=False)
            sent += len(chunk)
            await asyncio.sleep(0.003)

            # Light pacing to avoid overrunning the ESP32/NimBLE buffers
            if (sent % (CHUNK * 50)) == 0:
                print(f"sent {sent}/{total}")
                await asyncio.sleep(0.02)

                
        print("Done upload. Asking INFO...")
        await client.write_gatt_char(CTRL_UUID, b"INFO", response=True)
        await asyncio.sleep(2.0)
        # # END (optional if your firmware auto-closes when rxCount >= expected)
        # await client.write_gatt_char(CTRL_UUID, b"END", response=True)
        await asyncio.sleep(0.2)  # let last packets settle
        await client.write_gatt_char(CTRL_UUID, b"END", response=False)


        


        # Keep connection briefly to see final STAT messages
        await asyncio.sleep(2.0)

asyncio.run(main())
