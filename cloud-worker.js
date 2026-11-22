const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { execFile } = require('child_process');
const { Resvg } = require('@resvg/resvg-js');

const TARGET_PLATFORM_URL = (process.env.TARGET_PLATFORM_URL || 'http://127.0.0.1:5050').trim().replace(/\/$/, '');
const TARGET_ADMIN_PASSWORD = (process.env.TARGET_ADMIN_PASSWORD || 'uni2026admin').trim();
const GEMINI_KEYS = (process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '').split(',').map((s) => s.trim()).filter(Boolean);
const ELEVEN_HUB_URL = (process.env.ELEVENLABS_HUB_URL || '').trim().replace(/\/$/, '');
const ELEVEN_KEYS = (process.env.ELEVENLABS_KEYS || '').split(',').map((k) => k.trim()).filter(Boolean);
const VOICE_ID = (process.env.ELEVENLABS_VOICE_ID || 'onwK4e9ZLuTAKqWW03F9').trim();
const BATCH_COUNT = Math.max(1, Number(process.env.BATCH_COUNT || 45));

const WORK_DIR = path.join(__dirname, 'workspace');
const ASSETS_DIR = path.join(__dirname, 'assets');

let llmIdx = 0;
let elevenIdx = 0;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fixRtlText(str) {
  const clean = String(str || '').trim();
  if (!clean) return '';
  return `\u200F${clean.replace(/([!؟?.،]+)$/g, '$1\u200F')}`;
}

function escapeXml(str) {
  return fixRtlText(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function renderSvgToPng(svgString, targetWidth = 720) {
  const resvg = new Resvg(svgString, {
    fitTo: { mode: 'width', value: targetWidth },
    font: { loadSystemFonts: true, defaultFontFamily: 'Noto Sans Arabic' }
  });
  return resvg.render().asPng();
}

function runCmd(bin, args) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { windowsHide: true }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve({ stdout, stderr });
    });
  });
}

async function getMediaDuration(filePath) {
  return new Promise((resolve) => {
    execFile('ffmpeg', ['-i', filePath], (_err, _out, stderr) => {
      const m = String(stderr || '').match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
      if (!m) return resolve(3.8);
      const sec = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
      resolve(Math.max(2.5, Math.min(12, sec)));
    });
  });
}

async function ensureSoundEffects() {
  await fsp.mkdir(ASSETS_DIR, { recursive: true });
  const whooshPath = path.join(ASSETS_DIR, 'whoosh.wav');
  const popPath = path.join(ASSETS_DIR, 'pop.wav');

  const createWav = (samples, sr = 44100) => {
    const dataSize = samples.length * 2;
    const buf = Buffer.alloc(44 + dataSize);
    buf.write('RIFF', 0);
    buf.writeUInt32LE(36 + dataSize, 4);
    buf.write('WAVE', 8);
    buf.write('fmt ', 12);
    buf.writeUInt32LE(16, 16);
    buf.writeUInt16LE(1, 20);
    buf.writeUInt16LE(1, 22);
    buf.writeUInt32LE(sr, 24);
    buf.writeUInt32LE(sr * 2, 28);
    buf.writeUInt16LE(2, 32);
    buf.writeUInt16LE(16, 34);
    buf.write('data', 36);
    buf.writeUInt32LE(dataSize, 40);
    for (let i = 0; i < samples.length; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      buf.writeInt16LE(Math.round(s * 32767), 44 + i * 2);
    }
    return buf;
  };

  if (!fs.existsSync(whooshPath)) {
    const sr = 44100;
    const len = Math.floor(sr * 0.35);
    const arr = new Float32Array(len);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / len;
      lp += (0.05 + 0.24 * Math.sin(Math.PI * t)) * ((Math.random() * 2 - 1) - lp);
      arr[i] = lp * (Math.sin(Math.PI * t) ** 1.5) * 0.45;
    }
    await fsp.writeFile(whooshPath, createWav(arr, sr));
  }

  if (!fs.existsSync(popPath)) {
    const sr = 44100;
    const len = Math.floor(sr * 0.18);
    const arr = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      arr[i] = Math.sin(2 * Math.PI * (540 * Math.exp(-t * 16) + 120) * t) * Math.exp(-t * 26) * 0.55;
    }
    await fsp.writeFile(popPath, createWav(arr, sr));
  }

  return { whooshPath, popPath };
}

function extractValidStoryboard(rawText) {
  const cleaned = String(rawText || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .trim();

  const candidates = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < cleaned.length; i++) {
    if (cleaned[i] === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (cleaned[i] === '}') {
      depth--;
      if (depth === 0 && start !== -1) {
        candidates.push(cleaned.slice(start, i + 1));
        start = -1;
      }
    }
  }

  const types = ['cutaway_system', 'comparison_tank', 'network_attack', 'pressure_gauge', 'sonar_pulse', 'neural_grid', 'character_idea'];
  for (const jsonStr of candidates.reverse()) {
    try {
      const obj = JSON.parse(jsonStr);
      const rawScenes = Array.isArray(obj.scenes) ? obj.scenes : (Array.isArray(obj) ? obj : []);
      if (rawScenes.length >= 1) {
        const scenes = rawScenes.slice(0, 7).map((sc, idx) => ({
          narrationAr: String(sc.narrationAr || sc.text || sc.narration || '').trim() || 'حقيقة تقنية مذهلة تغير قواعد اللعبة!',
          topBanner: String(sc.topBanner || 'حقيقة تقنية!').trim().slice(0, 26),
          diagramType: types.includes(sc.diagramType) ? sc.diagramType : types[idx % types.length],
          callout1: String(sc.callout1 || 'النواة الرئيسية').slice(0, 20),
          callout2: String(sc.callout2 || 'طبقة الحماية').slice(0, 20),
          callout3: String(sc.callout3 || 'تدفق البيانات').slice(0, 20),
          leftValue: String(sc.leftValue || 'النظام الجديد').slice(0, 18),
          rightValue: String(sc.rightValue || 'النظام القديم').slice(0, 18),
          gaugeLabel: String(sc.gaugeLabel || '300×').slice(0, 14),
          theme: idx % 3 === 1 ? 'light' : 'dark'
        }));
        return {
          category: obj.category === 'ai' ? 'ai' : 'cybersecurity',
          topicTag: String(obj.topicTag || 'WONDER TECH').slice(0, 22),
          title: String(obj.title || 'أسرار التقنية الحديثة في 30 ثانية'),
          scenes
        };
      }
    } catch (_) {}
  }
  return null;
}

async function generateStoryboard(isAi) {
  if (GEMINI_KEYS.length === 0) {
    throw new Error('لا يوجد مفتاح GEMINI_API_KEYS في بيئة التشغيل');
  }

  const focus = isAi
    ? 'how a fascinating Artificial Intelligence breakthrough, photonic chip, or autonomous swarm works inside (Wonder Dose style)'
    : 'how a fascinating Cybersecurity exploit, quantum encryption, or cyber defense works inside (Wonder Dose style)';

  const prompt = `Create a fast-paced 28-second vertical Arabic explainer Short in the visual diagram style of "Wonder Dose | جرعة دهشة" about ${focus}.
Break into EXACTLY 7 fast visual scenes (8-12 Arabic words per scene, NO heavy diacritics, use ! and ؟).
Return ONLY raw JSON:
{
  "category": "${isAi ? 'ai' : 'cybersecurity'}",
  "topicTag": "WONDER TECH",
  "title": "Catchy Arabic title",
  "scenes": [
    {
      "narrationAr": "تخيل لو اخترق القراصنة عشر مليارات جهاز في ثوان معدودة!",
      "topBanner": "10 مليار جهاز!",
      "diagramType": "network_attack",
      "callout1": "نقطة الهجوم",
      "callout2": "جدار الحماية",
      "callout3": "الخادم المركزي",
      "leftValue": "هجوم آلي",
      "rightValue": "دفاع بشري",
      "gaugeLabel": "6 ثوان"
    }
  ]
}`;

  const errors = [];

  for (let i = 0; i < GEMINI_KEYS.length; i++) {
    const key = GEMINI_KEYS[(llmIdx + i) % GEMINI_KEYS.length];
    for (const model of ['gemini-2.5-flash', 'gemini-2.0-flash']) {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig: { responseMimeType: 'application/json', temperature: 0.85 }
            })
          });

          if (res.status === 429 && attempt === 0) {
            await sleep(12000);
            continue;
          }

          if (res.ok) {
            const data = await res.json();
            const raw = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
            const parsed = extractValidStoryboard(raw);
            if (parsed) {
              llmIdx = (llmIdx + i + 1) % GEMINI_KEYS.length;
              return parsed;
            }
            errors.push(`${model} نص غير صالح: ${raw.slice(0, 120)}`);
            break;
          } else {
            const errTxt = await res.text();
            errors.push(`${model} HTTP ${res.status}: ${errTxt.slice(0, 200)}`);
            break;
          }
        } catch (err) {
          errors.push(`${model} Exception: ${err.message}`);
          break;
        }
      }
    }
  }

  throw new Error(`فشل توليد السيناريو من Gemini -> ${errors.join(' | ')}`);
}

// توليد الصوت: ElevenLabs أولاً ثم تحويل تلقائي إلى Edge Neural Arabic المجاني المفتوح بلا حدود
async function generateSceneAudio(arabicText, outAudioPath) {
  if (ELEVEN_HUB_URL) {
    try {
      const res = await fetch(`${ELEVEN_HUB_URL}/v1/audio/speech`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'eleven_multilingual_v2', input: arabicText, voice: VOICE_ID })
      });
      if (res.ok) {
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > 500) {
          await fsp.writeFile(outAudioPath, buf);
          return true;
        }
      }
    } catch (_) {}
  }

  for (let i = 0; i < ELEVEN_KEYS.length; i++) {
    const key = ELEVEN_KEYS[(elevenIdx + i) % ELEVEN_KEYS.length];
    try {
      const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(VOICE_ID)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'xi-api-key': key, Accept: 'audio/mpeg' },
        body: JSON.stringify({
          text: arabicText,
          model_id: 'eleven_multilingual_v2',
          voice_settings: { stability: 0.42, similarity_boost: 0.8 }
        })
      });
      if (res.ok) {
        elevenIdx = (elevenIdx + i + 1) % ELEVEN_KEYS.length;
        await fsp.writeFile(outAudioPath, Buffer.from(await res.arrayBuffer()));
        return true;
      }
    } catch (_) {}
  }

  // بديل مجاني غير محدود بصوت عربي حيوي (Microsoft Neural TTS)
  try {
    await runCmd('edge-tts', [
      '--voice', 'ar-EG-ShakirNeural',
      '--rate=+8%',
      '--text', arabicText,
      '--write-media', outAudioPath
    ]);
    return fs.existsSync(outAudioPath);
  } catch (_) {
    return false;
  }
}

function renderCalloutPill(text, boxX, boxY, targetX, targetY) {
  const label = escapeXml(text);
  const w = Math.max(130, Math.min(230, text.length * 13 + 36));
  const h = 44;
  const cx = boxX + w / 2;
  const cy = boxY + h / 2;
  return `
    <line x1="${cx}" y1="${cy}" x2="${targetX}" y2="${targetY}" stroke="#0f172a" stroke-width="3.5" />
    <circle cx="${targetX}" cy="${targetY}" r="7" fill="#facc15" stroke="#0f172a" stroke-width="3" />
    <rect x="${boxX}" y="${boxY}" width="${w}" height="${h}" rx="22" fill="#ffffff" stroke="#0f172a" stroke-width="3" />
    <text x="${cx}" y="${boxY + 29}" fill="#0f172a" font-size="20" font-weight="bold" text-anchor="middle">${label}</text>
  `;
}

function buildRichDiagramSvgs(sc, sceneIdx, totalScenes, topicTag) {
  const isLight = sc.theme === 'light';
  const bgTop = isLight ? '#e0f2fe' : '#09152b';
  const bgBottom = isLight ? '#bae6fd' : '#0f294a';
  const stripeCol = isLight ? 'rgba(255,255,255,0.28)' : 'rgba(56,189,248,0.06)';
  const strokeMain = isLight ? '#0f172a' : '#38bdf8';

  const segW = Math.floor((644 - (totalScenes - 1) * 8) / totalScenes);
  let progBars = '';
  for (let s = 0; s < totalScenes; s++) {
    const x = 38 + s * (segW + 8);
    const fill = s <= sceneIdx ? '#facc15' : isLight ? 'rgba(15,23,42,0.18)' : 'rgba(255,255,255,0.2)';
    progBars += `<rect x="${x}" y="22" width="${segW}" height="6" rx="3" fill="${fill}" />`;
  }

  const bannerTxt = escapeXml(sc.topBanner);
  const bannerW = Math.max(260, Math.min(580, sc.topBanner.length * 17 + 70));
  const bannerX = (720 - bannerW) / 2;

  let staticArt = '';
  let animArt = '';

  switch (sc.diagramType) {
    case 'cutaway_system':
      staticArt = `
        <rect x="85" y="420" width="550" height="230" rx="115" fill="#334155" stroke="#0f172a" stroke-width="5" />
        <rect x="125" y="452" width="470" height="166" rx="83" fill="#e2e8f0" stroke="#0f172a" stroke-width="4" />
        <rect x="165" y="490" width="95" height="90" rx="16" fill="#38bdf8" stroke="#0f172a" stroke-width="3" />
        <rect x="285" y="490" width="150" height="90" rx="16" fill="#0f172a" />
        <circle cx="325" cy="535" r="18" fill="#22c55e" />
        <circle cx="365" cy="535" r="18" fill="#facc15" />
        <circle cx="405" cy="535" r="18" fill="#ef4444" />
        <rect x="460" y="490" width="95" height="90" rx="16" fill="#38bdf8" stroke="#0f172a" stroke-width="3" />
        ${renderCalloutPill(sc.callout1, 60, 290, 210, 490)}
        ${renderCalloutPill(sc.callout2, 430, 290, 365, 452)}
        ${renderCalloutPill(sc.callout3, 250, 725, 505, 580)}
      `;
      animArt = `
        <path d="M212 415 L212 375 M200 388 L212 372 L224 388" fill="none" stroke="#22c55e" stroke-width="6" stroke-linecap="round" />
        <path d="M507 415 L507 375 M495 388 L507 372 L519 388" fill="none" stroke="#22c55e" stroke-width="6" stroke-linecap="round" />
      `;
      break;

    case 'comparison_tank':
      staticArt = `
        <rect x="80" y="340" width="560" height="390" rx="24" fill="#ffffff" stroke="#0f172a" stroke-width="5" />
        <rect x="85" y="490" width="550" height="235" rx="18" fill="#38bdf8" opacity="0.85" />
        <polygon points="150,455 310,455 285,525 175,525" fill="#cbd5e1" stroke="#0f172a" stroke-width="4" />
        <circle cx="490" cy="645" r="46" fill="#475569" stroke="#0f172a" stroke-width="4" />
        ${renderCalloutPill(sc.leftValue, 115, 265, 230, 455)}
        ${renderCalloutPill(sc.rightValue, 415, 265, 490, 600)}
      `;
      animArt = `
        <circle cx="230" cy="395" r="28" fill="#22c55e" stroke="#0f172a" stroke-width="3" />
        <path d="M217 395 L227 405 L245 385" fill="none" stroke="#ffffff" stroke-width="6" stroke-linecap="round" />
        <circle cx="490" cy="395" r="28" fill="#ef4444" stroke="#0f172a" stroke-width="3" />
        <path d="M479 384 L501 406 M501 384 L479 406" fill="none" stroke="#ffffff" stroke-width="6" stroke-linecap="round" />
      `;
      break;

    case 'pressure_gauge':
      staticArt = `
        <rect x="65" y="270" width="44" height="510" rx="22" fill="#e2e8f0" stroke="#0f172a" stroke-width="4" />
        <rect x="73" y="450" width="28" height="322" rx="14" fill="#ef4444" />
        <rect x="125" y="435" width="150" height="44" rx="22" fill="#ffffff" stroke="#0f172a" stroke-width="3" />
        <text x="200" y="464" fill="#0f172a" font-size="20" font-weight="bold" text-anchor="middle">${escapeXml(sc.gaugeLabel)}</text>
        <circle cx="455" cy="530" r="110" fill="#1e293b" stroke="#facc15" stroke-width="6" />
        <circle cx="455" cy="530" r="68" fill="#38bdf8" opacity="0.25" stroke="#38bdf8" stroke-width="3" />
        ${renderCalloutPill(sc.callout1, 360, 290, 455, 420)}
        ${renderCalloutPill(sc.callout2, 360, 725, 455, 640)}
      `;
      animArt = `
        <circle cx="87" cy="455" r="14" fill="#facc15" stroke="#0f172a" stroke-width="3" />
        <path d="M455 360 L455 405 M443 393 L455 408 L467 393" fill="none" stroke="#ef4444" stroke-width="6" stroke-linecap="round" />
        <path d="M455 700 L455 655 M443 667 L455 652 L467 667" fill="none" stroke="#ef4444" stroke-width="6" stroke-linecap="round" />
      `;
      break;

    default:
      staticArt = `
        <rect x="65" y="455" width="150" height="150" rx="26" fill="#450a0a" stroke="#ef4444" stroke-width="5" />
        <polygon points="140,490 175,555 105,555" fill="#ef4444" />
        <rect x="335" y="350" width="38" height="360" rx="14" fill="#facc15" stroke="#0f172a" stroke-width="4" />
        <rect x="505" y="445" width="150" height="170" rx="26" fill="#064e3b" stroke="#22c55e" stroke-width="5" />
        ${renderCalloutPill(sc.callout1, 55, 315, 140, 455)}
        ${renderCalloutPill(sc.callout2, 260, 265, 354, 350)}
        ${renderCalloutPill(sc.callout3, 470, 315, 580, 445)}
      `;
      animArt = `
        <line x1="220" y1="530" x2="330" y2="530" stroke="#ef4444" stroke-width="8" stroke-dasharray="16 10" />
        <line x1="380" y1="530" x2="498" y2="530" stroke="#22c55e" stroke-width="8" stroke-dasharray="16 10" />
      `;
      break;
  }

  const baseSvg = `<?xml version="1.0" encoding="UTF-8"?>
  <svg width="720" height="1280" viewBox="0 0 720 1280" xml:lang="ar" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="bgGrad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${bgTop}" />
        <stop offset="100%" stop-color="${bgBottom}" />
      </linearGradient>
      <pattern id="diagStripes" width="90" height="1280" patternUnits="userSpaceOnUse">
        <rect x="0" y="0" width="42" height="1280" fill="${stripeCol}" />
      </pattern>
    </defs>
    <rect width="720" height="1280" fill="url(#bgGrad)" />
    <rect width="720" height="1280" fill="url(#diagStripes)" />
    ${progBars}
    <text x="680" y="64" fill="${strokeMain}" font-size="16" font-weight="bold" text-anchor="end">${escapeXml(topicTag)}</text>
    <rect x="${bannerX}" y="96" width="${bannerW}" height="58" rx="29" fill="#facc15" stroke="#0f172a" stroke-width="4" />
    <text x="360" y="134" fill="#0f172a" font-size="27" font-weight="bold" text-anchor="middle">${bannerTxt}</text>
    ${staticArt}
  </svg>`;

  const animSvg = `<?xml version="1.0" encoding="UTF-8"?>
  <svg width="720" height="1280" viewBox="0 0 720 1280" xmlns="http://www.w3.org/2000/svg">${animArt}</svg>`;

  return { baseSvg, animSvg };
}

function formatAssTime(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const cs = Math.floor((sec - Math.floor(sec)) * 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

async function buildAssSubtitleFile(assPath, narrationText, duration) {
  const words = String(narrationText || '')
    .replace(/[\u064B-\u065F\u0670]/g, '')
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) words.push('مذهل');

  const leadDelay = Math.min(0.2, duration * 0.07);
  const usable = Math.max(1.4, duration - leadDelay - 0.1);
  const weights = words.map((w) => Math.max(2, w.length) + (/[،,!؟?.]/.test(w) ? 2.5 : 0));
  const totalW = weights.reduce((a, b) => a + b, 0);

  let lines = `[Script Info]
ScriptType: v4.00+
PlayResX: 720
PlayResY: 1280

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Noto Sans Arabic,46,&H00FFFFFF,&H0015CCFA,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,4,0,2,40,40,175,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  let cursor = leadDelay;
  for (let i = 0; i < words.length; i += 3) {
    const group = words.slice(i, i + 3);
    const gWeights = weights.slice(i, i + 3);
    for (let g = 0; g < group.length; g++) {
      const dur = (gWeights[g] / totalW) * usable;
      const start = cursor;
      const end = i + g === words.length - 1 ? duration : cursor + dur;
      cursor = end;

      const styledText = group
        .map((w, idx) => (idx === g ? `{\\c&H0015CCFA&}${w}{\\c&H00FFFFFF&}` : w))
        .join(' ');
      lines += `Dialogue: 0,${formatAssTime(start)},${formatAssTime(end)},Default,,0,0,0,,\u200F${styledText}\n`;
    }
  }

  await fsp.writeFile(assPath, lines, 'utf8');
}

async function renderOneScene(jobDir, sc, idx, totalScenes, topicTag, whooshPath, popPath) {
  const audioPath = path.join(jobDir, `aud_${idx}.mp3`);
  const hasAudio = await generateSceneAudio(sc.narrationAr, audioPath);
  const duration = hasAudio ? await getMediaDuration(audioPath) : 3.8;
  const durStr = duration.toFixed(2);

  const { baseSvg, animSvg } = buildRichDiagramSvgs(sc, idx, totalScenes, topicTag);
  const basePng = path.join(jobDir, `base_${idx}.png`);
  const animPng = path.join(jobDir, `anim_${idx}.png`);
  const assPath = path.join(jobDir, `sub_${idx}.ass`);

  await Promise.all([
    fsp.writeFile(basePng, renderSvgToPng(baseSvg, 720)),
    fsp.writeFile(animPng, renderSvgToPng(animSvg, 720)),
    buildAssSubtitleFile(assPath, sc.narrationAr, duration)
  ]);

  const clipPath = path.join(jobDir, `clip_${idx}.mp4`);
  const escapedAss = assPath.replace(/\\/g, '/').replace(/:/g, '\\:');

  const args = [
    '-y',
    '-loop', '1', '-t', durStr, '-i', basePng,
    '-loop', '1', '-t', durStr, '-i', animPng,
    ...(hasAudio ? ['-i', audioPath] : ['-f', 'lavfi', '-t', durStr, '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100']),
    '-i', whooshPath,
    '-i', popPath,
    '-filter_complex',
    `[0:v][1:v]overlay=x='sin(t*3)*4':y='cos(t*2.6)*5':enable='gte(t,0.2)':eval=frame,ass='${escapedAss}',fps=24,format=yuv420p[vout];` +
    `[2:a]aresample=44100,aformat=channel_layouts=stereo,volume=1.18[av];` +
    `[3:a]aresample=44100,aformat=channel_layouts=stereo,volume=0.25[aw];` +
    `[4:a]aresample=44100,aformat=channel_layouts=stereo,adelay=200|200,volume=0.35[ap];` +
    `[av][aw][ap]amix=inputs=3:duration=first:dropout_transition=0[aout]`,
    '-map', '[vout]',
    '-map', '[aout]',
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-crf', '24',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-t', durStr,
    clipPath
  ];

  await runCmd('ffmpeg', args);
  return clipPath;
}

async function produceAndPublishOne(index) {
  const t0 = Date.now();
  const jobDir = path.join(WORK_DIR, `job_${t0}_${index}`);
  await fsp.mkdir(jobDir, { recursive: true });

  try {
    const { whooshPath, popPath } = await ensureSoundEffects();
    const story = await generateStoryboard(index % 2 === 1);
    const scenes = story.scenes.slice(0, 7);

    const readyClips = await Promise.all(
      scenes.map((sc, idx) => renderOneScene(jobDir, sc, idx, scenes.length, story.topicTag, whooshPath, popPath))
    );

    const concatTxt = path.join(jobDir, 'concat.txt');
    await fsp.writeFile(concatTxt, readyClips.map((p) => `file '${p.replace(/\\/g, '/')}'`).join('\n'), 'utf8');

    const outName = `short_${Date.now()}_${index}.mp4`;
    const finalMp4 = path.join(jobDir, outName);
    await runCmd('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', concatTxt, '-c', 'copy', '-movflags', '+faststart', finalMp4]);

    const buf = await fsp.readFile(finalMp4);
    const form = new FormData();
    form.append('video', new Blob([buf], { type: 'video/mp4' }), outName);
    form.append('title', story.title);
    form.append('category', story.category);
    form.append('topicTag', story.topicTag);

    const pubRes = await fetch(`${TARGET_PLATFORM_URL}/api/admin/publish`, {
      method: 'POST',
      headers: { 'x-admin-password': TARGET_ADMIN_PASSWORD },
      body: form
    });
    if (!pubRes.ok) throw new Error(await pubRes.text());

    const sec = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`✅ [${index + 1}/${BATCH_COUNT}] نُشر خلال ${sec}s -> ${story.title}`);
  } finally {
    await fsp.rm(jobDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function main() {
  await fsp.mkdir(WORK_DIR, { recursive: true });
  console.log(`🚀 بدء إنتاج دفعة (${BATCH_COUNT} فيديو) وإرسالها إلى ${TARGET_PLATFORM_URL}`);
  console.log(`🔑 مفاتيح Gemini المقروءة: ${GEMINI_KEYS.length}`);
  for (let i = 0; i < BATCH_COUNT; i++) {
    try {
      await produceAndPublishOne(i);
    } catch (err) {
      console.error(`❌ خطأ في الفيديو ${i + 1}: ${err.message}`);
    }
  }
  console.log('🏁 اكتملت الدفعة بنجاح!');
}

main();
