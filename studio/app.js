(() => {
  const $ = (id) => document.getElementById(id);
  const tracksEl = $("tracks");
  const msg = (t) => {
    $("msg").textContent = t;
  };

  const state = {
    tracks: [],
    selected: 1,
    playing: false,
    recording: false,
    ctx: null,
    graph: [],
    irCache: {},
    rec: { chunks: [], proc: null, source: null, stream: null, startSec: 0 },
    playStart: 0,
    offsetSec: 0,
    timer: 0,
    reverb: { mix: 0.22, predelayMs: 34, type: 0 },
    studioOn: false,
    deferredInstall: null,
  };

  function uid(p) {
    return p + Math.random().toString(36).slice(2, 8);
  }

  function defaultTracks() {
    state.tracks = [
      { id: "k", name: "Karaoke", type: "music", mute: false, solo: false, armed: false, volDb: -2, pan: 0, clips: [] },
      { id: "v1", name: "Vocal 1", type: "vocal", mute: false, solo: false, armed: true, volDb: 0, pan: 0, clips: [] },
      { id: "v2", name: "Vocal 2", type: "vocal", mute: false, solo: false, armed: false, volDb: 0, pan: 0, clips: [] },
    ];
    state.selected = 1;
  }

  async function ctx() {
    if (!state.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      state.ctx = new AC({ latencyHint: "interactive", sampleRate: 48000 });
    }
    if (state.ctx.state === "suspended") await state.ctx.resume();
    return state.ctx;
  }

  function dbToGain(db) {
    return Math.pow(10, db / 20);
  }

  function mixLength() {
    let m = 1;
    for (const t of state.tracks)
      for (const c of t.clips) m = Math.max(m, c.start + c.buffer.duration);
    return m;
  }

  function audible(tr) {
    const anySolo = state.tracks.some((t) => t.solo);
    if (tr.mute) return false;
    if (anySolo && !tr.solo) return false;
    return true;
  }

  function makeIR(ac, type) {
    const key = type + ":" + ac.sampleRate;
    if (state.irCache[key]) return state.irCache[key];
    const seconds = type === 2 ? 2.4 : type === 1 ? 0.9 : type === 3 ? 0.45 : 1.6;
    const decay = type === 2 ? 0.85 : type === 3 ? 0.18 : 0.45;
    const n = Math.floor(ac.sampleRate * seconds);
    const buf = ac.createBuffer(2, n, ac.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      let hp = 0;
      for (let i = 0; i < n; i++) {
        const t = i / ac.sampleRate;
        const noise = Math.random() * 2 - 1;
        const env = Math.exp(-t / decay) * (1 - Math.exp(-t * 80));
        const x = noise * env;
        hp = x - hp * 0.96;
        d[i] = hp * 0.55 * (ch ? 0.92 : 1);
      }
    }
    state.irCache[key] = buf;
    return buf;
  }

  function connectVocalFx(ac, src, dest, sitDuck) {
    const hpf = ac.createBiquadFilter();
    hpf.type = "highpass";
    hpf.frequency.value = state.studioOn ? 92 : 80;
    const air = ac.createBiquadFilter();
    air.type = "highshelf";
    air.frequency.value = 7000;
    air.gain.value = state.studioOn ? 2.2 : 0.8;
    const mud = ac.createBiquadFilter();
    mud.type = "peaking";
    mud.frequency.value = 340;
    mud.Q.value = 0.9;
    mud.gain.value = state.studioOn ? -2.4 : 0;
    const comp = ac.createDynamicsCompressor();
    comp.threshold.value = state.studioOn ? -18 : -22;
    comp.ratio.value = state.studioOn ? 3.4 : 2.2;
    comp.attack.value = 0.008;
    comp.release.value = 0.09;
    const dry = ac.createGain();
    dry.gain.value = 1;
    const send = ac.createGain();
    send.gain.value = state.reverb.mix;
    const delay = ac.createDelay(0.12);
    delay.delayTime.value = state.reverb.predelayMs / 1000;
    const conv = ac.createConvolver();
    conv.buffer = makeIR(ac, state.reverb.type);
    const wet = ac.createGain();
    wet.gain.value = 0.72;
    const hpWet = ac.createBiquadFilter();
    hpWet.type = "highpass";
    hpWet.frequency.value = 220;
    const lpWet = ac.createBiquadFilter();
    lpWet.type = "lowpass";
    lpWet.frequency.value = 6500;
    const out = ac.createGain();
    out.gain.value = sitDuck;
    src.connect(hpf);
    hpf.connect(mud);
    mud.connect(air);
    air.connect(comp);
    comp.connect(dry);
    dry.connect(out);
    comp.connect(send);
    send.connect(delay);
    delay.connect(hpWet);
    hpWet.connect(conv);
    conv.connect(lpWet);
    lpWet.connect(wet);
    wet.connect(out);
    out.connect(dest);
    return out;
  }

  function stopGraph() {
    for (const n of state.graph) {
      try {
        if (n.stop) n.stop();
        n.disconnect();
      } catch (_) {
        /* already stopped */
      }
    }
    state.graph = [];
    state.playing = false;
    $("btnPlay").classList.remove("hot");
  }

  async function playFrom(sec) {
    const ac = await ctx();
    stopGraph();
    const master = ac.createDynamicsCompressor();
    master.threshold.value = -1.2;
    master.knee.value = 2;
    master.ratio.value = 12;
    master.attack.value = 0.003;
    master.release.value = 0.08;
    master.connect(ac.destination);
    state.graph.push(master);
    const t0 = ac.currentTime + 0.05;
    state.playStart = t0;
    state.offsetSec = sec;
    for (const tr of state.tracks) {
      if (!audible(tr)) continue;
      const pan = ac.createStereoPanner();
      pan.pan.value = tr.pan;
      const vol = ac.createGain();
      vol.gain.value = dbToGain(tr.volDb);
      pan.connect(vol);
      if (tr.type === "vocal") connectVocalFx(ac, vol, master, 1);
      else {
        const duck = ac.createGain();
        duck.gain.value = 0.92;
        vol.connect(duck);
        duck.connect(master);
      }
      state.graph.push(pan, vol);
      for (const clip of tr.clips) {
        const src = ac.createBufferSource();
        src.buffer = clip.buffer;
        src.connect(pan);
        const when = t0 + Math.max(0, clip.start - sec);
        const offset = Math.max(0, sec - clip.start);
        if (offset >= clip.buffer.duration) continue;
        src.start(when, offset);
        state.graph.push(src);
      }
    }
    state.playing = true;
    $("btnPlay").classList.add("hot");
    tick();
  }

  function playhead() {
    if (!state.playing || !state.ctx) return state.offsetSec;
    return state.offsetSec + Math.max(0, state.ctx.currentTime - state.playStart);
  }

  function fmt(s) {
    s = Math.max(0, s);
    const m = Math.floor(s / 60);
    const r = s - m * 60;
    return String(m).padStart(2, "0") + ":" + r.toFixed(1).padStart(4, "0");
  }

  function tick() {
    const now = playhead();
    const len = mixLength();
    $("clock").textContent = fmt(now) + "  /  " + fmt(len);
    if (state.playing && now > len + 0.15 && !state.recording) {
      stopGraph();
      state.offsetSec = 0;
    }
    if (state.playing || state.recording) state.timer = requestAnimationFrame(tick);
  }

  function concatF32(chunks) {
    let n = 0;
    for (const c of chunks) n += c.length;
    const o = new Float32Array(n);
    let w = 0;
    for (const c of chunks) {
      o.set(c, w);
      w += c.length;
    }
    return o;
  }

  function peaks(buffer, buckets) {
    const ch = buffer.getChannelData(0);
    const out = new Array(buckets).fill(0);
    const step = Math.max(1, Math.floor(ch.length / buckets));
    for (let i = 0; i < buckets; i++) {
      let m = 0;
      const a = i * step;
      for (let j = 0; j < step && a + j < ch.length; j++) m = Math.max(m, Math.abs(ch[a + j]));
      out[i] = m;
    }
    return out;
  }

  function drawWave(canvas, clips) {
    const w = canvas.width;
    const h = canvas.height;
    const g = canvas.getContext("2d");
    g.fillStyle = "#0c0c10";
    g.fillRect(0, 0, w, h);
    if (!clips.length) return;
    const len = mixLength();
    g.strokeStyle = "#f0f0f0";
    g.lineWidth = 1;
    for (const clip of clips) {
      const x0 = (clip.start / len) * w;
      const x1 = ((clip.start + clip.buffer.duration) / len) * w;
      const cw = Math.max(2, x1 - x0);
      const p = peaks(clip.buffer, Math.max(8, Math.floor(cw)));
      g.beginPath();
      for (let i = 0; i < p.length; i++) {
        const x = x0 + (i / p.length) * cw;
        const a = p[i] * (h * 0.45);
        g.moveTo(x, h / 2 - a);
        g.lineTo(x, h / 2 + a);
      }
      g.stroke();
    }
  }

  function render() {
    tracksEl.innerHTML = "";
    state.tracks.forEach((tr, i) => {
      const el = document.createElement("div");
      el.className = "track " + tr.type + (i === state.selected ? " sel" : "");
      el.innerHTML =
        '<div class="thead">' +
        '<span class="tname"></span>' +
        '<button type="button" class="chip m" data-a="mute">M</button>' +
        '<button type="button" class="chip s" data-a="solo">S</button>' +
        (tr.type === "vocal"
          ? '<button type="button" class="chip r" data-a="arm">R</button>'
          : "") +
        '<button type="button" class="chip" data-a="del">X</button>' +
        "</div><canvas class=\"wave\"></canvas>";
      el.querySelector(".tname").textContent = tr.name;
      if (tr.mute) el.querySelector("[data-a=mute]").classList.add("on", "m");
      if (tr.solo) el.querySelector("[data-a=solo]").classList.add("on", "s");
      if (tr.armed) {
        const r = el.querySelector("[data-a=arm]");
        if (r) r.classList.add("on", "r");
      }
      const cv = el.querySelector("canvas");
      cv.width = Math.max(280, tracksEl.clientWidth - 24);
      cv.height = 36;
      drawWave(cv, tr.clips);
      el.addEventListener("click", (ev) => {
        const a = ev.target.getAttribute("data-a");
        if (a === "mute") tr.mute = !tr.mute;
        else if (a === "solo") tr.solo = !tr.solo;
        else if (a === "arm") {
          state.tracks.forEach((t) => (t.armed = false));
          tr.armed = true;
        } else if (a === "del") {
          if (state.tracks.length <= 1) {
            msg("Keep at least one track");
            return;
          }
          if (state.recording && tr.armed) {
            msg("Stop recording first");
            return;
          }
          state.tracks.splice(i, 1);
          state.selected = Math.min(i, state.tracks.length - 1);
          msg("Deleted " + tr.name);
          render();
          return;
        } else state.selected = i;
        render();
      });
      tracksEl.appendChild(el);
    });
    $("mixVal").textContent = Math.round(state.reverb.mix * 100) + "%";
    $("preVal").textContent = Math.round(state.reverb.predelayMs) + " ms";
    $("revMix").value = String(Math.round(state.reverb.mix * 100));
    $("revPre").value = String(Math.round(state.reverb.predelayMs));
    document.querySelectorAll("[data-rev]").forEach((b) => {
      b.classList.toggle("on", Number(b.getAttribute("data-rev")) === state.reverb.type);
    });
  }

  function armedVocal() {
    return state.tracks.find((t) => t.armed && t.type === "vocal") || state.tracks.find((t) => t.type === "vocal");
  }

  $("btnAdd").onclick = () => {
    const n = state.tracks.filter((t) => t.type === "vocal").length + 1;
    state.tracks.forEach((t) => (t.armed = false));
    state.tracks.push({
      id: uid("v"),
      name: "Vocal " + n,
      type: "vocal",
      mute: false,
      solo: false,
      armed: true,
      volDb: 0,
      pan: 0,
      clips: [],
    });
    state.selected = state.tracks.length - 1;
    msg("Added " + state.tracks[state.selected].name + " — tap REC to record");
    render();
  };

  $("btnDel").onclick = () => {
    if (state.tracks.length <= 1) return msg("Keep at least one track");
    const tr = state.tracks[state.selected];
    if (!tr) return;
    if (state.recording && tr.armed) return msg("Stop recording first");
    state.tracks.splice(state.selected, 1);
    state.selected = Math.min(state.selected, state.tracks.length - 1);
    msg("Deleted " + tr.name);
    render();
  };

  $("btnPlay").onclick = async () => {
    await playFrom(0);
    msg("Playing");
  };

  $("btnStop").onclick = async () => {
    if (state.recording) await stopRec();
    stopGraph();
    state.offsetSec = 0;
    $("clock").textContent = fmt(0) + "  /  " + fmt(mixLength());
    msg("Stopped");
  };

  $("btnRec").onclick = async () => {
    if (state.recording) await stopRec();
    else await startRec();
  };

  async function startRec() {
    const tr = armedVocal();
    if (!tr) return msg("Add a vocal track first");
    const ac = await ctx();
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
    } catch (e) {
      msg("Microphone permission is required to record");
      return;
    }
    await playFrom(playhead());
    const source = ac.createMediaStreamSource(stream);
    const proc = ac.createScriptProcessor(2048, 1, 1);
    const silent = ac.createGain();
    silent.gain.value = 0;
    source.connect(proc);
    proc.connect(silent);
    silent.connect(ac.destination);
    state.rec = { chunks: [], proc, source, stream, startSec: playhead(), silent };
    proc.onaudioprocess = (ev) => {
      if (!state.recording) return;
      state.rec.chunks.push(new Float32Array(ev.inputBuffer.getChannelData(0)));
    };
    state.recording = true;
    $("btnRec").classList.add("hot");
    msg("Recording on " + tr.name);
  }

  async function stopRec() {
    state.recording = false;
    $("btnRec").classList.remove("hot");
    const rec = state.rec;
    try {
      rec.proc && rec.proc.disconnect();
      rec.source && rec.source.disconnect();
      rec.silent && rec.silent.disconnect();
      rec.stream && rec.stream.getTracks().forEach((t) => t.stop());
    } catch (_) {
      /* ignore */
    }
    const ac = await ctx();
    const pcm = concatF32(rec.chunks);
    if (pcm.length < ac.sampleRate / 10) {
      msg("Take too short — discarded");
      return;
    }
    const buf = ac.createBuffer(1, pcm.length, ac.sampleRate);
    buf.getChannelData(0).set(pcm);
    const tr = armedVocal();
    if (tr) {
      tr.clips.push({ start: rec.startSec, buffer: buf });
      state.selected = state.tracks.indexOf(tr);
    }
    msg("Take saved on " + (tr ? tr.name : "vocal"));
    render();
  }

  $("fileKaraoke").onchange = async (ev) => {
    const file = ev.target.files && ev.target.files[0];
    ev.target.value = "";
    if (!file) return;
    msg("Loading " + file.name + "…");
    const ac = await ctx();
    const data = await file.arrayBuffer();
    let buffer;
    try {
      buffer = await ac.decodeAudioData(data.slice(0));
    } catch (e) {
      msg("Could not read that audio file. Use WAV, MP3, or M4A.");
      return;
    }
    let music = state.tracks.find((t) => t.type === "music");
    if (!music) {
      music = { id: "k", name: "Karaoke", type: "music", mute: false, solo: false, armed: false, volDb: -2, pan: 0, clips: [] };
      state.tracks.unshift(music);
    }
    music.clips = [{ start: 0, buffer }];
    msg("Imported karaoke: " + file.name);
    render();
  };

  $("revMix").oninput = () => {
    state.reverb.mix = Number($("revMix").value) / 100;
    $("mixVal").textContent = Math.round(state.reverb.mix * 100) + "%";
  };
  $("revPre").oninput = () => {
    state.reverb.predelayMs = Number($("revPre").value);
    $("preVal").textContent = Math.round(state.reverb.predelayMs) + " ms";
  };
  document.querySelectorAll("[data-rev]").forEach((b) => {
    b.onclick = () => {
      state.reverb.type = Number(b.getAttribute("data-rev"));
      const presets = [
        { mix: 0.22, predelayMs: 34 },
        { mix: 0.18, predelayMs: 18 },
        { mix: 0.28, predelayMs: 48 },
        { mix: 0.12, predelayMs: 18 },
      ];
      Object.assign(state.reverb, presets[state.reverb.type]);
      render();
      msg("Reverb type set — tap PLAY to hear it on vocals");
    };
  });

  $("btnReverb").onclick = async () => {
    state.reverb.mix = Math.max(state.reverb.mix, 0.22);
    state.reverb.predelayMs = Math.max(state.reverb.predelayMs, 32);
    state.reverb.type = 0;
    render();
    await playFrom(0);
    msg("Supportive plate reverb on vocals — dry voice stays, room sits behind");
  };

  $("btnStudio").onclick = async () => {
    state.studioOn = true;
    state.reverb.mix = 0.22;
    state.reverb.predelayMs = 34;
    state.reverb.type = 0;
    render();
    await playFrom(0);
    msg("Studio voice: HPF, compressor, air, supportive plate");
  };

  function encodeWav(ac, l, r) {
    const n = l.length;
    const bytes = n * 2 * 2 + 44;
    const buf = new ArrayBuffer(bytes);
    const v = new DataView(buf);
    const w = (o, s) => {
      for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
    };
    w(0, "RIFF");
    v.setUint32(4, bytes - 8, true);
    w(8, "WAVE");
    w(12, "fmt ");
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true);
    v.setUint16(22, 2, true);
    v.setUint32(24, ac.sampleRate, true);
    v.setUint32(28, ac.sampleRate * 4, true);
    v.setUint16(32, 4, true);
    v.setUint16(34, 16, true);
    w(36, "data");
    v.setUint32(40, n * 4, true);
    let o = 44;
    for (let i = 0; i < n; i++) {
      const a = Math.max(-1, Math.min(1, l[i]));
      const b = Math.max(-1, Math.min(1, r[i]));
      v.setInt16(o, a * 32767, true);
      v.setInt16(o + 2, b * 32767, true);
      o += 4;
    }
    return new Blob([buf], { type: "audio/wav" });
  }

  $("btnExport").onclick = async () => {
    const acLive = await ctx();
    const seconds = mixLength();
    const frames = Math.ceil(seconds * acLive.sampleRate);
    if (frames < 1024) return msg("Nothing to export yet");
    msg("Rendering mix…");
    const offline = new OfflineAudioContext(2, frames, acLive.sampleRate);
    const master = offline.createDynamicsCompressor();
    master.threshold.value = -1.2;
    master.ratio.value = 12;
    master.connect(offline.destination);
    for (const tr of state.tracks) {
      if (!audible(tr)) continue;
      const pan = offline.createStereoPanner();
      pan.pan.value = tr.pan;
      const vol = offline.createGain();
      vol.gain.value = dbToGain(tr.volDb);
      pan.connect(vol);
      if (tr.type === "vocal") connectVocalFx(offline, vol, master, 1);
      else {
        vol.connect(master);
      }
      for (const clip of tr.clips) {
        const src = offline.createBufferSource();
        src.buffer = clip.buffer;
        src.connect(pan);
        src.start(clip.start);
      }
    }
    const rendered = await offline.startRendering();
    const blob = encodeWav(acLive, rendered.getChannelData(0), rendered.getChannelData(1));
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "MobileStudioPro-mix.wav";
    a.click();
    msg("Exported WAV mix");
  };

  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    state.deferredInstall = e;
    $("installBar").classList.add("show");
  });
  $("btnInstall").onclick = async () => {
    if (state.deferredInstall) {
      state.deferredInstall.prompt();
      await state.deferredInstall.userChoice;
      state.deferredInstall = null;
      $("installBar").classList.remove("show");
    }
  };
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const standalone = window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone;
  if (ios && !standalone) {
    $("installBar").classList.add("show");
    $("iosHint").style.display = "block";
    $("btnInstall").style.display = "none";
  }
  if (!standalone && !ios) $("installBar").classList.add("show");

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("../sw.js").catch(() => {});
  }

  defaultTracks();
  render();
  window.addEventListener("resize", render);
})();
