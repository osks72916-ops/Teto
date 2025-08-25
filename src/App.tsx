import React, { useEffect, useMemo, useRef, useState } from "react";
import JSZip from "jszip";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { Play, Square, Upload, Music, Download, Trash2 } from "lucide-react";

// =========================
// Types
// =========================

type Note = {
  id: string;
  startBeat: number; // beat index
  lengthBeats: number;
  pitch: number; // MIDI (visual only for now)
  lyric: string; // alias key from oto.ini
};

type OtoEntry = {
  filename: string;
  alias: string; // lyric/alias used in editor
  offset: number; // ms
  consonant: number; // ms
  cutoff: number; // ms (negative means from end)
  preutterance: number; // ms
  overlap: number; // ms
};

// =========================
// Utilities
// =========================

function uid(prefix = "id") {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
}

function parseOtoIni(text: string): OtoEntry[] {
  // UTAU oto.ini format: filename=alias,offset,consonant,cutoff,preutterance,overlap
  const lines = text.split(/\r?\n/);
  const out: OtoEntry[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eqIdx = line.indexOf("=");
    if (eqIdx === -1) continue;
    const filename = line.slice(0, eqIdx).trim();
    const right = line.slice(eqIdx + 1);
    const [alias, offset, consonant, cutoff, pre, overlap] = right
      .split(",")
      .map((s) => s.trim());
    const toNum = (v?: string) => (v ? Number(v) : 0);
    out.push({
      filename,
      alias,
      offset: toNum(offset),
      consonant: toNum(consonant),
      cutoff: toNum(cutoff),
      preutterance: toNum(pre),
      overlap: toNum(overlap),
    });
  }
  return out;
}

function midiToY(midi: number, keyHeight = 16) {
  // higher pitch visually higher row (invert for canvas y)
  return (127 - midi) * keyHeight;
}

function beatsToX(beat: number, pxPerBeat: number) {
  return beat * pxPerBeat;
}

// =========================
// Main Component
// =========================

export default function RenoidLikeBase() {
  // Audio
  const [audioCtx, setAudioCtx] = useState<AudioContext | null>(null);
  const [offlineCtx, setOfflineCtx] = useState<OfflineAudioContext | null>(null);

  // Voicebank
  const [otoEntries, setOtoEntries] = useState<OtoEntry[]>([]);
  const [aliasIndex, setAliasIndex] = useState<Record<string, OtoEntry[]>>({});
  const [buffers, setBuffers] = useState<Record<string, AudioBuffer>>({}); // key: filename

  // Editor
  const [notes, setNotes] = useState<Note[]>([]);
  const [selectedAlias, setSelectedAlias] = useState<string>("");
  const [bpm, setBpm] = useState<number>(120);
  const [beats, setBeats] = useState<number>(32); // timeline length
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const startTimeRef = useRef<number>(0);

  // Canvas refs
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  // View config
  const pxPerBeat = 32; // horizontal scale
  const keyHeight = 16; // vertical scale
  const minMidi = 48; // C3
  const maxMidi = 84; // C6

  useEffect(() => {
    const ac = new (window.AudioContext || (window as any).webkitAudioContext)();
    setAudioCtx(ac);
    // prepare a default OfflineAudioContext for export (will be recreated on export with exact length)
    setOfflineCtx(null);
    return () => {
      ac.close();
    };
  }, []);

  // Build alias index for quick lookup
  useEffect(() => {
    const idx: Record<string, OtoEntry[]> = {};
    for (const e of otoEntries) {
      const key = e.alias || e.filename;
      if (!idx[key]) idx[key] = [];
      idx[key].push(e);
    }
    setAliasIndex(idx);
  }, [otoEntries]);

  // =========================
  // ZIP / Voicebank Loader
  // =========================

  const handleZipFile = async (file: File) => {
    if (!audioCtx) return;
    const zip = await JSZip.loadAsync(file);

    // Find oto.ini files (voicebank may have multiple folders)
    const otoFiles = Object.keys(zip.files).filter((p) => p.toLowerCase().endsWith("oto.ini"));
    const parsed: OtoEntry[] = [];

    for (const otoPath of otoFiles) {
      const txt = await zip.file(otoPath)!.async("text");
      const entries = parseOtoIni(txt);
      // Normalize filenames relative to the oto.ini directory
      const dir = otoPath.split("/").slice(0, -1).join("/");
      for (const e of entries) {
        const joined = dir ? `${dir}/${e.filename}` : e.filename;
        parsed.push({ ...e, filename: joined });
      }
    }
    setOtoEntries(parsed);

    // Decode WAVs referenced by oto.ini if present; otherwise decode all wavs
    const wavPaths = Array.from(
      new Set(
        parsed.length
          ? parsed.map((e) => e.filename)
          : Object.keys(zip.files).filter((p) => p.toLowerCase().endsWith(".wav"))
      )
    );

    const nextBuffers: Record<string, AudioBuffer> = {};
    for (const p of wavPaths) {
      const f = zip.file(p);
      if (!f) continue;
      const arr = await f.async("arraybuffer");
      try {
        const buf = await audioCtx.decodeAudioData(arr.slice(0));
        nextBuffers[p] = buf;
      } catch (e) {
        console.warn("decode failed for", p, e);
      }
    }
    setBuffers(nextBuffers);
  };

  // =========================
  // Playback
  // =========================

  function beatsToSeconds(beat: number, bpmVal = bpm) {
    return (60 / bpmVal) * beat;
  }

  const stopPlayback = () => {
    setIsPlaying(false);
    startTimeRef.current = 0;
    // Best-effort: closing & recreating AudioContext is heavy; rely on one-shots naturally ending.
  };

  const play = async () => {
    if (!audioCtx) return;
    // if context suspended (user gesture), resume
    if (audioCtx.state !== "running") await audioCtx.resume();
    const now = audioCtx.currentTime;
    startTimeRef.current = now;

    // Simple scheduler: schedule one-shot sources for each note.
    // For now, we do NOT apply pitch-shift or precise oto trimming; we start from offset and play for note length.
    notes.forEach((n) => {
      const entry = (aliasIndex[n.lyric] || [])[0];
      if (!entry) return;
      const buf = buffers[entry.filename];
      if (!buf) return;

      const src = audioCtx.createBufferSource();
      src.buffer = buf;

      // Trim start from oto offset (ms -> sec)
      const startFrom = Math.max(0, entry.offset / 1000);
      // Duration: approximate using note length beats -> seconds
      const dur = Math.max(0.05, beatsToSeconds(n.lengthBeats));

      // Gain node per note for future velocity/mixing
      const g = audioCtx.createGain();
      g.gain.value = 1.0;
      src.connect(g).connect(audioCtx.destination);

      const when = now + beatsToSeconds(n.startBeat);
      try {
        src.start(when, startFrom, Math.min(dur, buf.duration - startFrom));
      } catch (e) {
        console.warn("start failed", e);
      }
    });

    setIsPlaying(true);
  };

  // =========================
  // Export (Offline render, MVP placeholder)
  // =========================
  const renderWav = async () => {
    if (!audioCtx) return;
    // Estimate total seconds
    const totalSec = beatsToSeconds(beats) + 4;
    const sr = audioCtx.sampleRate;
    const channels = 2;
    const off = new OfflineAudioContext(channels, Math.ceil(totalSec * sr), sr);

    // Schedule like realtime but in offline context
    notes.forEach((n) => {
      const entry = (aliasIndex[n.lyric] || [])[0];
      if (!entry) return;
      const bufSrc = off.createBufferSource();
      const srcBuf = buffers[entry.filename];
      if (!srcBuf) return;
      bufSrc.buffer = srcBuf;
      const g = off.createGain();
      g.gain.value = 1.0;
      bufSrc.connect(g).connect(off.destination);
      const when = beatsToSeconds(n.startBeat);
      const startFrom = Math.max(0, entry.offset / 1000);
      const dur = Math.max(0.05, beatsToSeconds(n.lengthBeats));
      try {
        bufSrc.start(when, startFrom, Math.min(dur, srcBuf.duration - startFrom));
      } catch (e) {
        console.warn("offline start failed", e);
      }
    });

    const rendered = await off.startRendering();

    // Convert to WAV blob
    const wav = audioBufferToWav(rendered);
    const url = URL.createObjectURL(new Blob([wav], { type: "audio/wav" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "render.wav";
    a.click();
    URL.revokeObjectURL(url);
  };

  function audioBufferToWav(buffer: AudioBuffer) {
    // 16-bit PCM WAV encoder
    const numCh = buffer.numberOfChannels;
    const numFrames = buffer.length;
    const sr = buffer.sampleRate;
    const bytesPerSample = 2;
    const blockAlign = numCh * bytesPerSample;
    const dataSize = numFrames * blockAlign;
    const headerSize = 44;
    const buf = new ArrayBuffer(headerSize + dataSize);
    const view = new DataView(buf);

    function writeStr(off: number, s: string) {
      for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
    }

    let off = 0;
    writeStr(off, "RIFF"); off += 4;
    view.setUint32(off, 36 + dataSize, true); off += 4;
    writeStr(off, "WAVE"); off += 4;
    writeStr(off, "fmt "); off += 4;
    view.setUint32(off, 16, true); off += 4; // PCM fmt chunk size
    view.setUint16(off, 1, true); off += 2; // PCM
    view.setUint16(off, numCh, true); off += 2;
    view.setUint32(off, sr, true); off += 4;
    view.setUint32(off, sr * blockAlign, true); off += 4;
    view.setUint16(off, blockAlign, true); off += 2;
    view.setUint16(off, bytesPerSample * 8, true); off += 2;
    writeStr(off, "data"); off += 4;
    view.setUint32(off, dataSize, true); off += 4;

    // Interleave & write samples
    const chans: Float32Array[] = [];
    for (let ch = 0; ch < numCh; ch++) chans.push(buffer.getChannelData(ch));
    let pos = headerSize;
    for (let i = 0; i < numFrames; i++) {
      for (let ch = 0; ch < numCh; ch++) {
        let s = Math.max(-1, Math.min(1, chans[ch][i]));
        s = s < 0 ? s * 0x8000 : s * 0x7fff;
        view.setInt16(pos, s | 0, true);
        pos += 2;
      }
    }
    return buf;
  }

  // =========================
  // Canvas: Piano Roll (very basic)
  // =========================

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapperRef.current;
    if (!canvas || !wrap) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const width = beatsToX(beats, pxPerBeat) + 80;
    const height = (127 - (minMidi - 1) - (127 - maxMidi)) * keyHeight + 40;
    canvas.width = width;
    canvas.height = height;

    // bg
    ctx.fillStyle = "#0b0f16";
    ctx.fillRect(0, 0, width, height);

    // grid vertical (beats)
    for (let b = 0; b <= beats; b++) {
      const x = beatsToX(b, pxPerBeat);
      ctx.globalAlpha = b % 4 === 0 ? 0.4 : 0.2;
      ctx.beginPath();
      ctx.moveTo(x + 60, 0);
      ctx.lineTo(x + 60, height);
      ctx.strokeStyle = "#8b9bb4";
      ctx.lineWidth = b % 4 === 0 ? 1.5 : 1;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // keyboard gutter
    ctx.fillStyle = "#101828";
    ctx.fillRect(0, 0, 60, height);
    ctx.fillStyle = "#cbd5e1";
    ctx.font = "12px ui-sans-serif, system-ui";

    // draw notes
    for (const n of notes) {
      const x = 60 + beatsToX(n.startBeat, pxPerBeat);
      const y = midiToY(n.pitch, keyHeight) - (127 - maxMidi) * keyHeight;
      const w = beatsToX(n.lengthBeats, pxPerBeat) - 1;
      const h = keyHeight - 2;
      ctx.fillStyle = "#38bdf8"; // cyan
      ctx.fillRect(x, y + 1, w, h);
      ctx.fillStyle = "#0b0f16";
      ctx.fillText(n.lyric || "?", x + 4, y + h - 3);
    }
  }, [notes, beats, pxPerBeat, keyHeight, minMidi, maxMidi]);

  // Mouse interaction: click to add a note using selectedAlias
  const onCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = (e.target as HTMLCanvasElement).getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    const beat = Math.floor((x - 60) / pxPerBeat);
    const midi = 127 - Math.floor(y / keyHeight) - (127 - maxMidi);

    if (beat < 0 || beat >= beats || midi < minMidi || midi > maxMidi) return;
    const lyric = selectedAlias || Object.keys(aliasIndex)[0] || "a";

    const newNote: Note = {
      id: uid("note"),
      startBeat: beat,
      lengthBeats: 1,
      pitch: midi,
      lyric,
    };
    setNotes((prev) => [...prev, newNote]);
  };

  const clearNotes = () => setNotes([]);

  const aliasKeys = useMemo(() => Object.keys(aliasIndex).sort(), [aliasIndex]);

  // =========================
  // UI
  // =========================

  return (
    <div className="w-full min-h-screen bg-slate-950 text-slate-100 p-4 space-y-4">
      <header className="flex items-center gap-3">
        <Music className="w-6 h-6" />
        <h1 className="text-xl font-semibold">Renoid-like Web App — Base</h1>
      </header>

      <div className="grid md:grid-cols-3 gap-4">
        <Card className="bg-slate-900 border-slate-800 md:col-span-2">
          <CardHeader>
            <CardTitle>Editor</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center gap-3 flex-wrap">
              <div className="flex items-center gap-2">
                <Button size="sm" onClick={play} disabled={isPlaying || !notes.length}>
                  <Play className="w-4 h-4 mr-1" /> Play
                </Button>
                <Button size="sm" variant="secondary" onClick={stopPlayback}>
                  <Square className="w-4 h-4 mr-1" /> Stop
                </Button>
                <Button size="sm" variant="secondary" onClick={clearNotes}>
                  <Trash2 className="w-4 h-4 mr-1" /> Clear
                </Button>
              </div>

              <div className="flex items-center gap-2">
                <span className="text-sm text-slate-300">BPM</span>
                <Input
                  type="number"
                  className="w-20 h-8"
                  value={bpm}
                  onChange={(e) => setBpm(Number(e.target.value) || 120)}
                />
              </div>

              <div className="flex items-center gap-2">
                <span className="text-sm text-slate-300">Beats</span>
                <Input
                  type="number"
                  className="w-24 h-8"
                  value={beats}
                  onChange={(e) => setBeats(Math.max(4, Number(e.target.value) || 32))}
                />
              </div>

              <div className="flex items-center gap-2">
                <span className="text-sm text-slate-300">Alias</span>
                <select
                  className="bg-slate-800 border border-slate-700 rounded-md px-2 py-1 text-sm"
                  value={selectedAlias}
                  onChange={(e) => setSelectedAlias(e.target.value)}
                >
                  <option value="">(auto)</option>
                  {aliasKeys.map((a) => (
                    <option key={a} value={a}>{a}</option>
                  ))}
                </select>
              </div>

              <div className="flex-1" />

              <Button size="sm" onClick={renderWav} disabled={!notes.length}>
                <Download className="w-4 h-4 mr-1" /> Export WAV (MVP)
              </Button>
            </div>

            <div className="overflow-auto rounded-2xl ring-1 ring-slate-800">
              <div ref={wrapperRef} className="relative">
                <canvas
                  ref={canvasRef}
                  onClick={onCanvasClick}
                  className="block cursor-crosshair"
                />
              </div>
            </div>

            <p className="text-xs text-slate-400">
              Tip: Click the piano roll to add a 1-beat note using the selected Alias. Playback currently uses
              a simplified scheme: it trims from <code>oto.ini offset</code> and plays for the note length.
              Future steps: consonant/vowel splitting, time-stretch & pitch-shift, preutter/overlap handling, crossfades.
            </p>
          </CardContent>
        </Card>

        <Card className="bg-slate-900 border-slate-800">
          <CardHeader>
            <CardTitle>Voicebank</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <label className="flex items-center justify-center gap-2 rounded-xl border border-slate-700 bg-slate-800 hover:bg-slate-700 transition h-24 cursor-pointer">
              <Upload className="w-5 h-5" />
              <span>Drop or choose a UTAU voicebank .zip</span>
              <input
                type="file"
                accept=".zip"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) handleZipFile(f);
                }}
              />
            </label>

            <div className="text-sm text-slate-300">Loaded WAVs: {Object.keys(buffers).length}</div>
            <div className="text-sm text-slate-300">Aliases: {Object.keys(aliasIndex).length}</div>

            <div className="max-h-64 overflow-auto rounded-lg ring-1 ring-slate-800">
              <table className="w-full text-sm">
                <thead className="bg-slate-800/60 text-slate-300">
                  <tr>
                    <th className="text-left px-2 py-1">Alias</th>
                    <th className="text-left px-2 py-1">File</th>
                  </tr>
                </thead>
                <tbody>
                  {otoEntries.slice(0, 200).map((e, i) => (
                    <tr key={i} className="odd:bg-slate-900 even:bg-slate-900/60">
                      <td className="px-2 py-1 whitespace-nowrap">{e.alias || <em>(none)</em>}</td>
                      <td className="px-2 py-1 truncate" title={e.filename}>{e.filename}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="text-xs text-slate-400">
              Supports typical UTAU <code>oto.ini</code> structure. If multiple <code>oto.ini</code> exist, entries are merged.
            </div>
          </CardContent>
        </Card>
      </div>

      <Card className="bg-slate-900 border-slate-800">
        <CardHeader>
          <CardTitle>Roadmap (from this base)</CardTitle>
        </CardHeader>
        <CardContent>
          <ol className="list-decimal ml-5 space-y-1 text-slate-300 text-sm">
            <li>Consonant/Vowel segmentation: respect <code>consonant</code>, <code>preutterance</code>, <code>overlap</code>.</li>
            <li>Time-stretch (RubberBand WASM or SoundTouch WASM) to fit note length.</li>
            <li>Pitch-shift per-note + pitch bend curves.</li>
            <li>Crossfades between adjacent notes, especially CV voicebanks.</li>
            <li>Editor tools: drag/resize notes, selection, delete, lyrics input per note.</li>
            <li>Project save/load (IndexedDB) and voicebank caching.</li>
            <li>Offline render parity with realtime playback; multi-track mixer and effects.</li>
          </ol>
        </CardContent>
      </Card>
    </div>
  );
}
