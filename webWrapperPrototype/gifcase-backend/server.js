import express from "express";
import fetch from "node-fetch";
import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";

const app = express();
app.use(express.json({ limit: "2mb" }));

const DEFAULTS = {
  width: 320,
  maxSeconds: 3.0,
  fps: 8,
  colors: 48,
  maxBytes: 650 * 1024
};

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    p.stdout.on("data", d => out += d.toString());
    p.stderr.on("data", d => err += d.toString());
    p.on("close", code => {
      if (code === 0) resolve({ out, err });
      else reject(new Error(`${cmd} failed (${code}): ${err}`));
    });
  });
}

async function transcodeGif({ inputPath, outputPath, width, maxSeconds, fps, colors }) {
  // palette workflow to get decent color result:
  // 1) trim + fps + scale into split
  // 2) palettegen with max_colors
  // 3) paletteuse
  const palettePath = outputPath.replace(/\.gif$/i, ".png");

  const vf = `trim=0:${maxSeconds},setpts=PTS-STARTPTS,fps=${fps},scale=${width}:-1:flags=lanczos`;

  await run("ffmpeg", [
    "-y",
    "-i", inputPath,
    "-vf", vf + ",palettegen=max_colors=" + colors + ":stats_mode=diff",
    palettePath
  ]);

  await run("ffmpeg", [
    "-y",
    "-i", inputPath,
    "-i", palettePath,
    "-filter_complex",
    `${vf}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3`,
    "-gifflags", "+transdiff",
    outputPath
  ]);

  try { fs.unlinkSync(palettePath); } catch {}
}

async function makeEspSafeGif(url, opts) {
  const cfg = { ...DEFAULTS, ...(opts || {}) };

  // Fetch source GIF
  const r = await fetch(url);
  if (!r.ok) throw new Error(`fetch failed: ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gifcase-"));
  const id = crypto.randomBytes(8).toString("hex");
  const inPath = path.join(tmpDir, `${id}.gif`);
  fs.writeFileSync(inPath, buf);

  // Size enforcement loop
  const candidates = [
    { fps: cfg.fps, colors: cfg.colors, maxSeconds: cfg.maxSeconds, width: cfg.width },
    { fps: cfg.fps, colors: 32,        maxSeconds: cfg.maxSeconds, width: cfg.width },
    { fps: 6,       colors: 32,        maxSeconds: cfg.maxSeconds, width: cfg.width },
    { fps: 6,       colors: 24,        maxSeconds: 2.5,            width: cfg.width },
    { fps: 6,       colors: 24,        maxSeconds: 2.5,            width: 280 }
  ];

  let bestPath = null;
  let bestBuf = null;

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const outPath = path.join(tmpDir, `${id}-out-${i}.gif`);

    await transcodeGif({
      inputPath: inPath,
      outputPath: outPath,
      width: c.width,
      maxSeconds: c.maxSeconds,
      fps: c.fps,
      colors: c.colors
    });

    const outBuf = fs.readFileSync(outPath);
    if (!bestBuf || outBuf.length < bestBuf.length) {
      bestBuf = outBuf;
      bestPath = outPath;
    }

    if (outBuf.length <= cfg.maxBytes) {
      bestBuf = outBuf;
      bestPath = outPath;
      break;
    }
  }

  // Cleanup directory can be left; but we’ll attempt:
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}

  return bestBuf;
}

app.get("/health", (req, res) => res.json({ ok: true }));

// GET /transcode?url=<gif_url>&maxBytes=650000
app.get("/transcode", async (req, res) => {
  try {
    const url = req.query.url;
    if (!url) return res.status(400).json({ error: "missing url" });

    const maxBytes = req.query.maxBytes ? parseInt(req.query.maxBytes, 10) : DEFAULTS.maxBytes;

    const outBuf = await makeEspSafeGif(url, { maxBytes });

    res.setHeader("Content-Type", "image/gif");
    res.setHeader("Content-Length", String(outBuf.length));
    res.setHeader("Cache-Control", "no-store");
    res.send(outBuf);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log("gifcase-backend listening on", PORT));
