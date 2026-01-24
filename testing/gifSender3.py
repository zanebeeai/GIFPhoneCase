import asyncio
from bleak import BleakClient, BleakError

ADDRESS = "D0:CF:13:08:90:D9"

CTRL_UUID = "6e400002-b5a3-f393-e0a9-e50e24dcca9e"
DATA_UUID = "6e400003-b5a3-f393-e0a9-e50e24dcca9e"
STAT_UUID = "6e400004-b5a3-f393-e0a9-e50e24dcca9e"

GIF_PATH = "./Downloads/output_esp_8fps_48c.gif"

# Start conservative for WinRT stability; raise gradually after stable.
CHUNK = 240

# Breather tuning (helps avoid WinRT queue collapse)
YIELD_EVERY_WRITES = 200
BREATHER_EVERY_BYTES = 240 * 2000
BREATHER_SLEEP_S = 0.01

# How many times to retry if WinRT closes the GATT object
MAX_ATTEMPTS = 6


def decode_bytes(b: bytes) -> str:
    return b.decode(errors="ignore").strip("\x00").strip()


def stat_indicates_ok(stat_s: str, total: int) -> bool:
    # Firmware emits either OK tags or INFO string including bytes=.../... and file=...
    if ("OK:rx_done" in stat_s) or ("OK:rx_done_auto" in stat_s):
        return True
    if f"bytes={total}/{total}" in stat_s:
        return True
    # Some statuses might just report file size as complete
    if f"file={total}" in stat_s:
        return True
    return False


async def read_stat(client: BleakClient) -> str:
    v = await client.read_gatt_char(STAT_UUID)
    return decode_bytes(v)


async def write_ctrl(client: BleakClient, payload: bytes) -> None:
    # Use write-without-response; WinRT is often more stable with this.
    await client.write_gatt_char(CTRL_UUID, payload, response=False)


async def send_gif_once(blob: bytes) -> tuple[bool, str]:
    total = len(blob)

    async with BleakClient(ADDRESS, timeout=20.0) as client:
        print("Connected:", client.is_connected)

        # Let WinRT settle before first GATT op
        await asyncio.sleep(0.25)

        # START
        await write_ctrl(client, f"START:{total}".encode("utf-8"))
        await asyncio.sleep(0.05)

        sent = 0
        writes_since_yield = 0

        while sent < total:
            part = blob[sent:sent + CHUNK]
            await client.write_gatt_char(DATA_UUID, part, response=False)
            sent += len(part)

            writes_since_yield += 1
            if writes_since_yield >= YIELD_EVERY_WRITES:
                writes_since_yield = 0
                await asyncio.sleep(0)

            if (sent % BREATHER_EVERY_BYTES) == 0:
                print(f"sent {sent}/{total}")
                await asyncio.sleep(BREATHER_SLEEP_S)

        print("Upload done. Sending END...")
        await write_ctrl(client, b"END")
        await asyncio.sleep(0.2)

        # Validate via STAT read (notify often fails on Windows)
        stat_s = await read_stat(client)
        print("STAT_READ:", stat_s)

        if stat_indicates_ok(stat_s, total):
            print("Validated. Sending REPLAY...")
            await write_ctrl(client, b"REPLAY")
            await asyncio.sleep(0.2)
            await write_ctrl(client, b"INFO")
            return True, stat_s

        # If not OK, request INFO once and re-check (sometimes END status is stale)
        await asyncio.sleep(0.1)
        await write_ctrl(client, b"INFO")
        await asyncio.sleep(0.2)
        stat2 = await read_stat(client)
        print("STAT_READ2:", stat2)

        return stat_indicates_ok(stat2, total), stat2


async def main():
    with open(GIF_PATH, "rb") as f:
        blob = f.read()

    total = len(blob)
    print("GIF bytes:", total)

    global CHUNK

    # Retry loop: handle WinRT "object closed" and packet loss (len mismatch)
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            ok, stat = await send_gif_once(blob)
            if ok:
                return

            print(f"Transfer did not validate. Status: {stat}")

            # Step-down strategy if we see mismatch
            if "len_mismatch" in stat or f"bytes={total}/" in stat:
                if CHUNK > 200:
                    CHUNK = 200
                elif CHUNK > 160:
                    CHUNK = 160
                elif CHUNK > 120:
                    CHUNK = 120
                else:
                    # If already very small, add more breathing
                    global BREATHER_SLEEP_S
                    BREATHER_SLEEP_S = min(0.05, BREATHER_SLEEP_S + 0.01)

            await asyncio.sleep(0.4)

        except (OSError, BleakError) as e:
            msg = str(e)
            print(f"[Attempt {attempt}] Error:", msg)

            # WinRT often throws "operation was canceled" / "object closed" transiently
            await asyncio.sleep(0.5 * attempt)
            continue

    raise RuntimeError("Failed after multiple attempts (WinRT instability or packet loss).")


asyncio.run(main())
