import asyncio
from bleak import BleakScanner

TARGET_NAME = "GIFCase"
TARGET_UUID = "6e400001-b5a3-f393-e0a9-e50e24dcca9e"

async def main():
    seen = {}

    def cb(device, adv):
        # adv has rssi, local_name, service_uuids, manufacturer_data, service_data
        local_name = (adv.local_name or device.name or "")
        uuids = [u.lower() for u in (adv.service_uuids or [])]

        # Print candidates only
        hit = (TARGET_NAME.lower() in local_name.lower()) or (TARGET_UUID in uuids)
        if hit:
            print("---- HIT ----")
            print("address:", device.address)
            print("name:", device.name, "local_name:", adv.local_name, "rssi:", adv.rssi)
            print("uuids:", uuids)
            print("mfg:", adv.manufacturer_data)
            print("svc_data:", adv.service_data)

        seen[device.address] = (local_name, uuids, adv.rssi)

    scanner = BleakScanner(cb)
    await scanner.start()
    await asyncio.sleep(10)
    await scanner.stop()

    print(f"Total devices seen: {len(seen)}")

asyncio.run(main())
