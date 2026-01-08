"use client";

import { useMemo, useState } from "react";

const SVC_UUID  = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
const CTRL_UUID = "6e400002-b5a3-f393-e0a9-e50e24dcca9e";
const DATA_UUID = "6e400003-b5a3-f393-e0a9-e50e24dcca9e";
const STAT_UUID = "6e400004-b5a3-f393-e0a9-e50e24dcca9e";

const BACKEND = process.env.NEXT_PUBLIC_BACKEND_URL;
const GIPHY_KEY = process.env.NEXT_PUBLIC_GIPHY_API_KEY;

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

export default function Page() {
  const [q, setQ] = useState("flight reacts");
  const [results, setResults] = useState([]);
  const [selected, setSelected] = useState(null);

  const [processedUrl, setProcessedUrl] = useState(null);
  const [processedBytes, setProcessedBytes] = useState(null);

  const [ble, setBle] = useState({ device: null, server: null, ctrl: null, data: null, stat: null });
  const [log, setLog] = useState([]);

  const canWebBle = useMemo(() => typeof navigator !== "undefined" && !!navigator.bluetooth, []);

  function pushLog(s) {
    setLog(prev => [s, ...prev].slice(0, 50));
  }

  async function search() {
    setResults([]);
    setSelected(null);
    setProcessedUrl(null);
    setProcessedBytes(null);

    const url = new URL("https://api.giphy.com/v1/gifs/search");
    url.searchParams.set("api_key", GIPHY_KEY);
    url.searchParams.set("q", q);
    url.searchParams.set("limit", "24");
    url.searchParams.set("rating", "pg");

    const r = await fetch(url.toString());
    const j = await r.json();
    setResults(j.data || []);
  }

  async function preprocess(gifUrl) {
    setProcessedUrl(null);
    setProcessedBytes(null);

    // Ask backend to return processed GIF bytes
    const u = new URL(BACKEND + "/transcode");
    u.searchParams.set("url", gifUrl);
    u.searchParams.set("maxBytes", String(650 * 1024));

    pushLog("Preprocessing via backend...");
    const r = await fetch(u.toString());
    if (!r.ok) {
      const t = await r.text();
      throw new Error("backend failed: " + t);
    }
    const blob = await r.blob();
    const arr = new Uint8Array(await blob.arrayBuffer());

    // Preview in UI
    const objUrl = URL.createObjectURL(blob);
    setProcessedUrl(objUrl);
    setProcessedBytes(arr);

    pushLog(`Processed GIF: ${arr.length} bytes`);
  }

  async function connectBle() {
    if (!canWebBle) {
      pushLog("Web Bluetooth not supported here (iOS Safari won’t work).");
      return;
    }

    pushLog("Requesting BLE device...");
    const device = await navigator.bluetooth.requestDevice({
      filters: [{ name: "GIFCase" }],
      optionalServices: [SVC_UUID]
    });

    device.addEventListener("gattserverdisconnected", () => {
      pushLog("BLE disconnected");
      setBle({ device: null, server: null, ctrl: null, data: null, stat: null });
    });

    const server = await device.gatt.connect();
    const service = await server.getPrimaryService(SVC_UUID);

    const ctrl = await service.getCharacteristic(CTRL_UUID);
    const data = await service.getCharacteristic(DATA_UUID);
    const stat = await service.getCharacteristic(STAT_UUID);

    await stat.startNotifications();
    stat.addEventListener("characteristicvaluechanged", (ev) => {
      const v = ev.target.value;
      const dec = new TextDecoder().decode(v);
      pushLog("[STAT] " + dec);
    });

    setBle({ device, server, ctrl, data, stat });
    pushLog("BLE connected");
  }

  async function writeCtrl(text) {
    const enc = new TextEncoder().encode(text);
    await ble.ctrl.writeValue(enc);
    pushLog("CTRL -> " + text);
  }

  async function sendGifToEsp() {
    if (!processedBytes) throw new Error("No processed GIF yet");
    if (!ble.ctrl || !ble.data) throw new Error("BLE not connected");

    // Conservative chunking. WebBLE often supports larger; we keep it safe.
    const CHUNK = 180;
    const bytes = processedBytes;

    await writeCtrl("CLEAR");
    await sleep(100);

    await writeCtrl(`START:${bytes.length}`);
    await sleep(50);

    let sent = 0;
    while (sent < bytes.length) {
      const chunk = bytes.slice(sent, sent + CHUNK);
      // Write without response (WebBLE doesn’t expose response toggle; it’s fine)
      await ble.data.writeValue(chunk);
      sent += chunk.length;

      if (sent % (CHUNK * 80) === 0) {
        pushLog(`sent ${sent}/${bytes.length}`);
        await sleep(15);
      }
    }

    pushLog("Upload done. Sending END...");
    await writeCtrl("END");
    await sleep(100);

    pushLog("Starting PLAY:10");
    await writeCtrl("PLAY:10");
  }

  async function replay() {
    if (!ble.ctrl) throw new Error("BLE not connected");
    await writeCtrl("PLAY:10");
  }

  return (
    <main style={{ padding: 16, fontFamily: "system-ui" }}>
      <h1>GIFCase</h1>

      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          style={{ flex: 1, padding: 8 }}
          placeholder="Search GIPHY…"
        />
        <button onClick={search} style={{ padding: 8 }}>Search</button>
      </div>

      <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 12 }}>
        <button onClick={connectBle} style={{ padding: 8 }}>
          {ble.device ? "BLE Connected" : "Connect BLE"}
        </button>
        <button onClick={sendGifToEsp} style={{ padding: 8 }} disabled={!processedBytes || !ble.ctrl}>
          Send to ESP
        </button>
        <button onClick={replay} style={{ padding: 8 }} disabled={!ble.ctrl}>
          Replay
        </button>
        <span style={{ opacity: 0.7 }}>
          {canWebBle ? "WebBLE available" : "WebBLE unavailable (iOS Safari)"}
        </span>
      </div>

      {selected && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ marginBottom: 6 }}>Selected:</div>
          <img src={selected.images.fixed_height.url} alt="" />
          <div style={{ marginTop: 8 }}>
            <button onClick={() => preprocess(selected.images.original.url)} style={{ padding: 8 }}>
              Preprocess (ESP-safe)
            </button>
          </div>
        </div>
      )}

      {processedUrl && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ marginBottom: 6 }}>
            Processed preview {processedBytes ? `(${processedBytes.length} bytes)` : ""}
          </div>
          <img src={processedUrl} alt="processed gif preview" />
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 8 }}>
        {results.map((g) => (
          <button
            key={g.id}
            onClick={() => setSelected(g)}
            style={{ border: selected?.id === g.id ? "2px solid black" : "1px solid #ccc", padding: 0 }}
            title={g.title}
          >
            <img src={g.images.fixed_width_small.url} alt="" style={{ width: "100%", display: "block" }} />
          </button>
        ))}
      </div>

      <h3 style={{ marginTop: 16 }}>Log</h3>
      <pre style={{ background: "#111", color: "#0f0", padding: 12, height: 220, overflow: "auto" }}>
        {log.join("\n")}
      </pre>
    </main>
  );
}
