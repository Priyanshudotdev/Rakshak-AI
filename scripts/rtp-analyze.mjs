// rtp-analyze.mjs — offline analysis of a forked-Audio pcap.
// Usage: node scripts/rtp-analyze.mjs /tmp/fork.pcap [udpPort]
// Captured with: sudo tcpdump -i lo -w /tmp/fork.pcap udp port 17777
// Prints per-200ms RMS bars + ZCR, then a verdict on what the stream is:
// real speech (mixed loud/quiet, mid ZCR), silence (all quiet), full-scale
// blast (all loud, extreme ZCR = noise/garbage, stable low ZCR = tone/howl).
import { readFileSync } from "node:fs";

const path = process.argv[2];
const wantPort = Number(process.argv[3] ?? 17777);
if (!path) {
  console.error("usage: node scripts/rtp-analyze.mjs <pcap> [udpPort]");
  process.exit(1);
}
const buf = readFileSync(path);
if (buf.readUInt32LE(0) !== 0xa1b2c3d4) throw new Error("not a little-endian pcap");

// Collect RTP payloads -> destination wantPort.
const payloads = [];
let off = 24; // pcap global header
while (off + 16 <= buf.length) {
  const incl = buf.readUInt32LE(off + 8);
  let p = off + 16;
  const end = p + incl;
  if (end > buf.length) break;
  p += 20; // LINUX_SLL2 cooked header
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
const total = Math.floor(pcm.length / 2);
console.log(`packets=${payloads.length} samples=${total} (${(total / 16000).toFixed(1)}s @16kHz)`);

// 200ms windows: rms, peak, zero-crossing rate.
const W = 3200;
let silent = 0, loud = 0, clipped = 0, zcrSum = 0, zcrN = 0;
for (let w = 0; w + W <= total; w += W) {
  let sum = 0, peak = 0, zc = 0, prev = 0;
  for (let i = 0; i < W; i++) {
    const s = pcm.readInt16LE((w + i) * 2);
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
  console.log(`${((w / 16000).toFixed(1)).padStart(6)}s rms=${String(Math.round(rms)).padStart(6)} peak=${String(peak).padStart(6)} zcr=${zcr.toFixed(3)} ${bar}`);
}
const n = silent + loud;
console.log(`--- windows=${n} silent=${silent} loud=${loud} clippedWindows=${clipped} meanZcr=${(zcrSum / Math.max(1, zcrN)).toFixed(3)}`);
if (loud === 0) console.log("VERDICT: SILENCE — tap streams zeros (Asterisk-side, Sarvam correctly hears nothing)");
else if (silent === 0 && zcrSum / zcrN > 0.35) console.log("VERDICT: FULL-SCALE BLAST, noise-like ZCR — garbage/feedback, not speech (tap or transcode path suspect)");
else if (silent === 0) console.log("VERDICT: CONTINUOUS LOUD, tone-like ZCR — possible howl/tone or never-pausing source");
else console.log("VERDICT: MIXED speech-like dynamics — bytes look plausible, suspect Sarvam-side");
