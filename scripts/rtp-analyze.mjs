// rtp-analyze.mjs — offline audio forensics: pcap fork captures AND wav files.
// Usage:
//   node scripts/rtp-analyze.mjs /tmp/fork.pcap [udpPort]   (tcpdump of the fork)
//   node scripts/rtp-analyze.mjs call-recording.wav         (e.g. Asterisk MixMonitor)
// Prints per-200ms RMS bars + ZCR, then a verdict on what the stream is:
// real speech (mixed loud/quiet, mid ZCR), silence (all quiet), full-scale
// blast (all loud, extreme ZCR = noise/garbage, stable low ZCR = tone/howl).
import { readFileSync } from "node:fs";

const path = process.argv[2];
if (!path) {
  console.error("usage: node scripts/rtp-analyze.mjs <pcap|wav> [udpPort]");
  process.exit(1);
}

let samples, rate;
if (path.endsWith(".wav")) {
  ({ samples, rate } = loadWav(path));
  console.log(`wav: ${samples.length} samples @ ${rate}Hz (${(samples.length / rate).toFixed(1)}s)`);
} else {
  const wantPort = Number(process.argv[3] ?? 17777);
  samples = loadPcap(path, wantPort);
  rate = 16000;
  console.log(`pcap: ${samples.length} samples (${(samples.length / 16000).toFixed(1)}s @16kHz)`);
}

// Parse a wav file -> mono int16 + rate (never assumes 44-byte header).
function loadWav(path) {
  const buf = readFileSync(path);
  if (buf.subarray(0, 4).toString() !== "RIFF") throw new Error("not a wav");
  let off = 12, rate = 0, ch = 0, bits = 0, data = null;
  while (off + 8 <= buf.length) {
    const id = buf.subarray(off, off + 4).toString();
    const size = buf.readUInt32LE(off + 4);
    if (id === "fmt " && size >= 16) {
      ch = buf.readUInt16LE(off + 10);
      rate = buf.readUInt32LE(off + 12);
      bits = buf.readUInt16LE(off + 22);
    } else if (id === "data") {
      data = buf.subarray(off + 8, off + 8 + size);
    }
    off += 8 + size + (size % 2);
  }
  if (!data || !rate || bits !== 16) throw new Error("wav must be 16-bit PCM with fmt+data");
  const frames = Math.floor(data.length / 2 / ch);
  const mono = new Int16Array(frames);
  for (let i = 0; i < frames; i++) {
    let s = 0;
    for (let c = 0; c < ch; c++) s += data.readInt16LE((i * ch + c) * 2);
    mono[i] = Math.round(s / ch);
  }
  return { samples: mono, rate };
}
// Collect RTP payloads -> destination wantPort, returned as mono int16.
function loadPcap(path, wantPort) {
  const buf = readFileSync(path);
  if (buf.readUInt32LE(0) !== 0xa1b2c3d4) throw new Error("not a little-endian pcap");
  // Link-layer header size depends on the capture interface:
  // `-i any` gives LINUX_SLL2 (20B), `-i lo`/`-i eth0` give Ethernet (14B).
  const linktype = buf.readUInt32LE(20);
  const l2len = linktype === 1 ? 14 : linktype === 101 ? 16 : linktype === 113 ? 20 : null;
  if (l2len === null) throw new Error(`unsupported pcap linktype ${linktype}`);

  const payloads = [];
  let off = 24; // pcap global header
  while (off + 16 <= buf.length) {
    const incl = buf.readUInt32LE(off + 8);
    let p = off + 16;
    const end = p + incl;
    if (end > buf.length) break;
    p += l2len;
    const ihl = (buf[p] & 0x0f) * 4;
    const proto = buf[p + 9];
    p += ihl;
    if (proto === 17) {
      const dport = buf.readUInt16BE(p + 2);
      if (dport === wantPort) {
        const udpLen = buf.readUInt16BE(p + 4); // includes 8-byte UDP header
        const rtp = p + 8;
        const cc = buf[rtp] & 0x0f;
        let ro = rtp + 12 + cc * 4;
        if (buf[rtp] & 0x10) ro += 4 + buf.readUInt16BE(ro + 2) * 4; // extension
        const rtpEnd = p + udpLen; // end of UDP datagram (not p+8+udpLen)
        if (ro < rtpEnd) payloads.push(buf.subarray(ro, rtpEnd));
      }
    }
    off = end;
  }
  if (!payloads.length) {
    console.error(`no UDP/${wantPort} packets in ${path}`);
    process.exit(1);
  }
  const pcm = Buffer.concat(payloads);
  const bytes = Buffer.from(pcm);
  const total = Math.floor(bytes.length / 2);
  console.log(`packets=${payloads.length} samples=${total} (${(total / 16000).toFixed(1)}s @16kHz)`);
  const out = new Int16Array(total);
  for (let i = 0; i < total; i++) out[i] = bytes.readInt16LE(i * 2);
  return out;
}

// 200ms windows: rms, peak, zero-crossing rate.
const total = samples.length;
const W = Math.floor(rate / 5);
let silent = 0, loud = 0, clipped = 0, zcrSum = 0, zcrN = 0;
for (let w = 0; w + W <= total; w += W) {
  let sum = 0, peak = 0, zc = 0, prev = 0;
  for (let i = 0; i < W; i++) {
    const s = samples[w + i];
    sum += s * s;
    const a = s < 0 ? -s : s;
    if (a > peak) peak = a;
    if (i > 0 && (s >= 0) !== (prev >= 0)) zc++;
    prev = s;
  }
  const rms = Math.sqrt(sum / W);
  const zcr = zc / W;
  zcrSum += zcr;
  zcrN++;
  if (rms < 100) silent++;
  else loud++;
  if (peak > 32000) clipped++;
  const bar = "#".repeat(Math.min(40, Math.round((rms / 8000) * 40)));
  console.log(`${((w / rate).toFixed(1)).padStart(6)}s rms=${String(Math.round(rms)).padStart(6)} peak=${String(peak).padStart(6)} zcr=${zcr.toFixed(3)} ${bar}`);
}
const n = silent + loud;
console.log(`--- windows=${n} silent=${silent} loud=${loud} clippedWindows=${clipped} meanZcr=${(zcrSum / Math.max(1, zcrN)).toFixed(3)}`);
if (loud === 0) console.log("VERDICT: SILENCE — tap streams zeros (Asterisk-side, Sarvam correctly hears nothing)");
else if (silent === 0 && zcrSum / zcrN > 0.35) console.log("VERDICT: FULL-SCALE BLAST, noise-like ZCR — garbage/feedback, not speech (tap or transcode path suspect)");
else if (silent === 0) console.log("VERDICT: CONTINUOUS LOUD, tone-like ZCR — possible howl/tone or never-pausing source");
else console.log("VERDICT: MIXED speech-like dynamics — bytes look plausible, suspect Sarvam-side");
