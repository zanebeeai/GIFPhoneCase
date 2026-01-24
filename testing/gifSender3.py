import asyncio
from bleak import BleakClient

ADDRESS = "D0:CF:13:08:90:D9"

CTRL_UUID = "6e400002-b5a3-f393-e0a9-e50e24dcca9e"
DATA_UUID = "6e400003-b5a3-f393-e0a9-e50e24dcca9e"
STAT_UUID = "6e400004-b5a3-f393-e0a9-e50e24dcca9e"

GIF_PATH = "./Downloads/output_esp_8fps_48c.gif"

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

        # Try to negotiate MTU (works on some backends; harmless if not supported)
        mtu = None
        try:
            # Some Bleak backends expose mtu_size
            mtu = getattr(client, "mtu_size", None)
        except:
            mtu = None

        # Conservative default if we can't read MTU; still better than 240 in many cases
        # Typical payload ~= MTU-3
        if mtu is None or mtu < 50:
            chunk = 240
        else:
            chunk = max(20, min(494, mtu - 3))

        print(f"Using chunk size: {chunk} (mtu={mtu})")

        # START
        await client.write_gatt_char(CTRL_UUID, f"START:{total}".encode("utf-8"), response=True)

        sent = 0
        writes_since_yield = 0

        while sent < total:
            chunk_bytes = blob[sent:sent + chunk]
            await client.write_gatt_char(DATA_UUID, chunk_bytes, response=False)
            sent += len(chunk_bytes)

            writes_since_yield += 1

            # Only yield occasionally; do NOT sleep every packet
            if writes_since_yield >= 200:
                writes_since_yield = 0
                await asyncio.sleep(0)

            if (sent % (chunk * 200)) == 0:
                print(f"sent {sent}/{total}")

        print("Upload done. Waiting for ESP to finish...")
        await asyncio.sleep(0.2)

        await client.write_gatt_char(CTRL_UUID, b"REPLAY", response=True)
        await asyncio.sleep(0.1)
        await client.write_gatt_char(CTRL_UUID, b"INFO", response=True)
        await asyncio.sleep(2.0)

asyncio.run(main())
