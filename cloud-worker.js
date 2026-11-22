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
let cachedModels = null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const COLOR_PALETTES = [
  { name: 'CYBER OCEAN', isLight: false, bgTop: '#061326', bgBottom: '#0c2748', accent: '#38bdf8', badgeBg: '#facc15', badgeText: '#0f172a', stripe: 'rgba(56,189,248,0.06)' },
  { name: 'CRIMSON ALERT', isLight: false, bgTop: '#1f0710', bgBottom: '#3b0d1e', accent: '#fb7185', badgeBg: '#facc15', badgeText: '#0f172a', stripe: 'rgba(251,113,133,0.06)' },
  { name: 'EMERALD MATRIX', isLight: false, bgTop: '#041b15', bgBottom: '#093629', accent: '#34d399', badgeBg: '#fde047', badgeText: '#052e16', stripe: 'rgba(52,211,153,0.06)' },
  { name: 'ARCTIC BLUEPRINT', isLight: true, bgTop: '#e0f2fe', bgBottom: '#bae6fd', accent: '#0284c7', badgeBg: '#0f172a', badgeText: '#facc15', stripe: 'rgba(255,255,255,0.35)' },
  { name: 'SOLAR GRAPHITE', isLight: false, bgTop: '#12131a', bgBottom: '#232634', accent: '#fbbf24', badgeBg: '#38bdf8', badgeText: '#0f172a', stripe: 'rgba(251,191,36,0.05)' },
  { name: 'ULTRAVIOLET LAB', isLight: false, bgTop: '#160b2e', bgBottom: '#2a1454', accent: '#c084fc', badgeBg: '#facc15', badgeText: '#0f172a', stripe: 'rgba(192,132,252,0.06)' },
  { name: 'CLEAN LAB PAPER', isLight: true, bgTop: '#f1f5f9', bgBottom: '#cbd5e1', accent: '#0f172a', badgeBg: '#ef4444', badgeText: '#ffffff', stripe: 'rgba(15,23,42,0.04)' },
  { name: 'DEEP ABYSS', isLight: false, bgTop: '#031926', bgBottom: '#083344', accent: '#22d3ee', badgeBg: '#fb923c', badgeText: '#0f172a', stripe: 'rgba(34,211,238,0.06)' }
];

const TOPIC_IDEAS = [
  { cat: 'cybersecurity', tag: 'HARDWARE HACK', topic: 'هجوم Rowhammer: كيف يقلب القراصنة البتات داخل شريحة الرام فيزيائياً بالكهرباء دون لمس النظام' },
  { cat: 'cybersecurity', tag: 'AIR-GAP LEAK', topic: 'سرقة كلمات المرور من حاسوب مفصول عن الإنترنت تماماً عبر ذبذبات مروحة التبريد أو إشارات الشاشة الكهرومغناطيسية' },
  { cat: 'cybersecurity', tag: 'CYBER WEAPON', topic: 'فيروس Stuxnet وكيف دمر أجهزة الطرد المركزي النووية فيزيائياً عبر التلاعب بتردد المحركات بصمت' },
  { cat: 'cybersecurity', tag: 'ZERO CLICK', topic: 'ثغرات Zero-Click: كيف يُخترق الهاتف بمجرد وصول رسالة صامتة دون أن تضغط على أي رابط' },
  { cat: 'cybersecurity', tag: 'INTERNET CORE', topic: 'اختطاف مسارات الإنترنت BGP Hijacking وكيف يمكن لخطأ توجيه واحد تحويل حركة بيانات قارة كاملة' },
  { cat: 'cybersecurity', tag: 'GPS SPOOFING', topic: 'تزييف إشارات الأقمار الصناعية GPS Spoofing وكيف تُخدع السفن والطائرات لتظن أنها في مكان آخر' },
  { cat: 'cybersecurity', tag: 'SIDE CHANNEL', topic: 'هجمات القنوات الجانبية: كسر مفاتيح التشفير بمجرد قياس استهلاك المعالج للكهرباء أو صوت لوحة المفاتيح' },
  { cat: 'cybersecurity', tag: 'SUBSEA CABLES', topic: 'الكابلات البحرية العملاقة في قاع المحيطات: كيف تنقل 99% من الإنترنت العالمي وكيف تُحمى من القطع والتجسس' },
  { cat: 'cybersecurity', tag: 'SUPPLY CHAIN', topic: 'هجمات سلسلة التوريد: زرع باب خلفي مجهري داخل تحديث رسمي أو شريحة إلكترونية قبل خروجها من المصنع' },
  { cat: 'cybersecurity', tag: 'BIOS ROOTKIT', topic: 'فيروسات اللوحة الأم UEFI Rootkits التي تبقى حية حتى بعد فرمتة الهارد وتغيير نظام التشغيل بالكامل' },
  { cat: 'cybersecurity', tag: 'RFID CLONING', topic: 'استنساخ بطاقات الدخول الذكية NFC/RFID عن بعد وكيف تحمي الشرائح المشفرة DESFire نفسها' },
  { cat: 'cybersecurity', tag: 'CRYPTOGRAPHY', topic: 'التشفير المتماثل Homomorphic Encryption: كيف تعالج السحابة بياناتك السرية وتحللها دون أن تراها أو تفك تشفيرها' },
  { cat: 'cybersecurity', tag: 'DEEPFAKE FRAUD', topic: 'استنساخ الصوت بالذكاء الاصطناعي في المكالمات المباشرة وكيف تكتشف البصمة الصوتية المزيفة' },
  { cat: 'cybersecurity', tag: 'HONEYPOT TRAP', topic: 'مصائد القراصنة Honeypots: بناء سيرفرات وهمية مغرية لاصطياد المهاجمين وتحليل أدواتهم لحظة بلحظة' },
  { cat: 'cybersecurity', tag: 'TEMPEST SPY', topic: 'تقنية TEMPEST: إعادة رسم ما يظهر على شاشة حاسوبك من خلف الجدران عبر التقاط الإشعاع الراديوي للكابل' },
  { cat: 'ai', tag: 'ADVERSARIAL AI', topic: 'الهجمات الخصومية: كيف يُخدع ذكاء السيارة ذاتية القيادة بملصق صغير فتقرأ إشارة قف كأنها سرعة 120' },
  { cat: 'ai', tag: 'NEUROMORPHIC', topic: 'الرقاقات العصبية Neuromorphic Chips التي تحاكي تشابكات الدماغ البشري وتستهلك جزءاً من ألف من طاقة المعالجات' },
  { cat: 'ai', tag: 'SWARM DRONES', topic: 'أسراب الدرونات المستقلة Swarm AI: كيف تتواصل مئات الطائرات بلا قائد مركزي وتتخذ قراراتها كسرب طيور' },
  { cat: 'ai', tag: 'PROTEIN AI', topic: 'كيف حل الذكاء الاصطناعي لغز طي البروتينات في أيام بعد أن عجز العلماء عنه لخمسين عاماً' },
  { cat: 'ai', tag: 'BRAIN INTERFACE', topic: 'واجهات الدماغ والحاسوب BCI: كيف تترجم الأقطاب الدقيقة إشارات الخلايا العصبية إلى حركة أو كلام على الشاشة' },
  { cat: 'ai', tag: 'DNA STORAGE', topic: 'تخزين بيانات العالم كله داخل جرام واحد من الحمض النووي الاصطناعي DNA لآلاف السنين' },
  { cat: 'ai', tag: 'HALLUCINATION', topic: 'لماذا يهلوس الذكاء الاصطناعي ويخترع حقائق واثقة؟ نظرة داخل رياضيات التنبؤ بالكلمة التالية' },
  { cat: 'ai', tag: 'AI IMMUNE', topic: 'الأنظمة المناعية للشبكات: كيف يتعلم الذكاء الاصطناعي نبض الشبكة الطبيعي ويعزل أي جهاز مصاب خلال أجزاء من الثانية' },
  { cat: 'ai', tag: 'SYNTHETIC DATA', topic: 'انهيار النماذج Model Collapse: ماذا يحدث عندما يتدرب الذكاء الاصطناعي على محتوى صنعه ذكاء اصطناعي آخر' },
  { cat: 'ai', tag: 'EDGE AI', topic: 'تشغيل نماذج الذكاء الاصطناعي الضخمة داخل متحكم صغير بحجم العملة المعدنية دون الحاجة للإنترنت' },
  { cat: 'ai', tag: 'WORLD MODELS', topic: 'نماذج العالم World Models: كيف يتعلم الذكاء الاصطناعي قوانين الفيزياء والجاذبية بمشاهدة الفيديو فقط' },
  { cat: 'ai', tag: 'AI RADAR', topic: 'الرؤية خلف الجدران بالواي فاي: كيف يحوّل الذكاء الاصطناعي إشارات الراوتر المنزلية إلى صورة ثلاثية الأبعاد لحركة الأشخاص' },
  { cat: 'cybersecurity', tag: 'BAD USB', topic: 'كابلات الشحن المفخخة BadUSB: كيف يخفي كابل عادي شريحة تحقن أوامر اختراق بسرعة البرق فور توصيله' },
  { cat: 'cybersecurity', tag: 'ZERO KNOWLEDGE', topic: 'إثبات المعرفة الصفرية Zero-Knowledge Proof: كيف تثبت للنظام أنك تملك كلمة السر دون أن ترسلها له أبداً' },
  { cat: 'ai', tag: 'NANO ROBOTS', topic: 'الروبوتات النانوية الطبية الموجهة بالذكاء الاصطناعي لتوصيل الدواء إلى الخلية المصابة بدقة مجهرية' }
];

function shuffleArray(arr) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

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

function sanitizeCustomSvg(rawSvg) {
  let s = String(rawSvg || '').trim();
  if (!s) return '';
  s = s.replace(/<script[\s\S]*?<\/script>/gi, '');
  s = s.replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, '');
  s = s.replace(/<image[^>]*>/gi, '');
  s = s.replace(/\son[a-z]+\s*=\s*["'][^"']*["']/gi, '');
  const innerMatch = s.match(/<svg[^>]*>([\s\S]*?)<\/svg>/i);
  if (innerMatch) s = innerMatch[1].trim();
  if (!s || s.length < 30) return '';
  return s;
}

function extractValidStoryboard(rawText, seedTopic) {
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

  const fallbackTypes = [
    'microchip_die', 'satellite_beam', 'subsea_cable', 'vault_lock',
    'radar_sweep', 'neural_web', 'server_breach', 'waveform_scan',
    'drone_swarm', 'shield_wall'
  ];

  for (const jsonStr of candidates.reverse()) {
    try {
      const obj = JSON.parse(jsonStr);
      const rawScenes = Array.isArray(obj.scenes) ? obj.scenes : [];
      if (rawScenes.length >= 3) {
        const scenes = rawScenes.slice(0, 6).map((sc, idx) => ({
          narrationAr: String(sc.narrationAr || sc.text || '').trim() || 'حقيقة تقنية مذهلة تغير قواعد اللعبة!',
          topBanner: String(sc.topBanner || 'اكتشف السر!').trim().slice(0, 26),
          diagramType: fallbackTypes.includes(sc.diagramType) ? sc.diagramType : fallbackTypes[(idx + Math.floor(Math.random() * 5)) % fallbackTypes.length],
          customSvg: sanitizeCustomSvg(sc.customSvg || ''),
          callout1: String(sc.callout1 || 'نقطة التحول').slice(0, 22),
          callout2: String(sc.callout2 || 'آلية العمل').slice(0, 22),
          callout3: String(sc.callout3 || 'النتيجة').slice(0, 22),
          gaugeLabel: String(sc.gaugeLabel || '99.9%').slice(0, 14)
        }));
        return {
          category: seedTopic.cat,
          topicTag: seedTopic.tag,
          title: String(obj.title || seedTopic.topic.slice(0, 55)),
          scenes
        };
      }
    } catch (_) {}
  }
  return null;
}

async function resolveGeminiModels(key) {
  if (cachedModels && cachedModels.length > 0) return cachedModels;
  const defaults = ['gemini-3.0-flash', 'gemini-flash-latest'];
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`);
    if (res.ok) {
      const data = await res.json();
      const found = (data.models || [])
        .filter((m) => Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes('generateContent'))
        .map((m) => String(m.name || '').replace(/^models\//, ''))
        .filter((name) => name.includes('flash') && !name.includes('image') && !name.includes('audio'));
      const merged = [...new Set([...defaults, ...found.reverse()])];
      cachedModels = merged;
      return merged;
    }
  } catch (_) {}
  return defaults;
}

async function generateStoryboard(seedTopic, usedTitles) {
  if (GEMINI_KEYS.length === 0) {
    throw new Error('لا يوجد مفتاح GEMINI_API_KEYS في بيئة التشغيل');
  }

  const avoidList = usedTitles.slice(-15).join(' | ');

  const prompt = `You are a viral Arabic science & tech visual storyteller (like Kurzgesagt + Wonder Dose).
Create a UNIQUE, deeply engaging 25-second vertical Arabic Short specifically about this exact subject:
"${seedTopic.topic}"

STRICT RULES:
1. Do NOT use generic clichés. Explain the real, fascinating mechanism behind THIS specific topic!
2. Do NOT repeat any of these previous titles: [${avoidList || 'none'}]
3. Break into EXACTLY 6 distinct visual scenes (8-12 Arabic words per scene, NO heavy diacritics, use ! and ؟).
4. For EACH scene, write a custom vector illustration in "customSvg" designed specifically for that scene's story inside a 720x520 coordinate box (x: 40..680, y: 20..500). Use rich colorful SVG shapes (<rect>, <circle>, <polygon>, <path>, <line>, <ellipse>) with bold strokes (#0f172a or #38bdf8), glowing accents (#facc15, #22c55e, #ef4444, #38bdf8), NO <text> inside customSvg (labels are handled separately by callout1/2/3).
5. Also pick the closest "diagramType" from: ["microchip_die", "satellite_beam", "subsea_cable", "vault_lock", "radar_sweep", "neural_web", "server_breach", "waveform_scan", "drone_swarm", "shield_wall"].

Return ONLY valid JSON:
{
  "title": "عنوان عربي مشوق ومحدد لهذا الموضوع فقط",
  "scenes": [
    {
      "narrationAr": "جملة عربية قصيرة ومشوقة تشرح المشهد الأول!",
      "topBanner": "عنوان قصير للمشهد",
      "diagramType": "subsea_cable",
      "customSvg": "<rect x='80' y='240' width='560' height='60' rx='30' fill='#0284c7' stroke='#facc15' stroke-width='4'/><circle cx='360' cy='270' r='22' fill='#ef4444'/>",
      "callout1": "تسمية الجزء الأول",
      "callout2": "تسمية الجزء الثاني",
      "callout3": "تسمية النتيجة",
      "gaugeLabel": "100x"
    }
  ]
}`;

  const errors = [];

  for (let i = 0; i < GEMINI_KEYS.length; i++) {
    const key = GEMINI_KEYS[(llmIdx + i) % GEMINI_KEYS.length];
    const models = await resolveGeminiModels(key);

    for (const model of models) {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig: { responseMimeType: 'application/json', temperature: 0.95 }
            })
          });

          if (res.status === 429 && attempt === 0) {
            await sleep(12000);
            continue;
          }

          if (res.ok) {
            const data = await res.json();
            const raw = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
            const parsed = extractValidStoryboard(raw, seedTopic);
            if (parsed) {
              llmIdx = (llmIdx + i + 1) % GEMINI_KEYS.length;
              cachedModels = [model, ...models.filter((m) => m !== model)];
              return parsed;
            }
            errors.push(`${model} نص غير صالح`);
            break;
          } else {
            const errTxt = await res.text();
            errors.push(`${model} HTTP ${res.status}: ${errTxt.slice(0, 140)}`);
            break;
          }
        } catch (err) {
          errors.push(`${model} Exception: ${err.message}`);
          break;
        }
      }
    }
  }

  throw new Error(`فشل توليد السيناريو -> ${errors.slice(0, 2).join(' | ')}`);
}

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
  const w = Math.max(140, Math.min(250, text.length * 13 + 38));
  const h = 44;
  const cx = boxX + w / 2;
  const cy = boxY + h / 2;
  return `
    <line x1="${cx}" y1="${cy}" x2="${targetX}" y2="${targetY}" stroke="#facc15" stroke-width="3" stroke-dasharray="6 4" />
    <circle cx="${targetX}" cy="${targetY}" r="7" fill="#facc15" stroke="#0f172a" stroke-width="3" />
    <rect x="${boxX}" y="${boxY}" width="${w}" height="${h}" rx="22" fill="#ffffff" stroke="#0f172a" stroke-width="3" />
    <text x="${cx}" y="${boxY + 29}" fill="#0f172a" font-size="20" font-weight="bold" text-anchor="middle">${label}</text>
  `;
}

function buildFallbackArt(sc) {
  switch (sc.diagramType) {
    case 'microchip_die':
      return `
        <rect x="190" y="340" width="340" height="340" rx="28" fill="#1e293b" stroke="#38bdf8" stroke-width="5" />
        <rect x="245" y="395" width="230" height="230" rx="16" fill="#0f172a" stroke="#facc15" stroke-width="4" />
        <rect x="295" y="445" width="130" height="130" rx="12" fill="#0284c7" />
        <line x1="140" y1="410" x2="190" y2="410" stroke="#facc15" stroke-width="6" />
        <line x1="140" y1="510" x2="190" y2="510" stroke="#facc15" stroke-width="6" />
        <line x1="140" y1="610" x2="190" y2="610" stroke="#facc15" stroke-width="6" />
        <line x1="530" y1="410" x2="580" y2="410" stroke="#facc15" stroke-width="6" />
        <line x1="530" y1="510" x2="580" y2="510" stroke="#facc15" stroke-width="6" />
        <line x1="530" y1="610" x2="580" y2="610" stroke="#facc15" stroke-width="6" />
      `;
    case 'satellite_beam':
      return `
        <circle cx="360" cy="690" r="150" fill="#0284c7" stroke="#38bdf8" stroke-width="5" />
        <path d="M250 640 Q360 580 470 650 Q410 760 280 730 Z" fill="#22c55e" opacity="0.85" />
        <rect x="320" y="310" width="80" height="50" rx="10" fill="#e2e8f0" stroke="#0f172a" stroke-width="4" />
        <rect x="190" y="318" width="120" height="34" rx="6" fill="#38bdf8" stroke="#0f172a" stroke-width="3" />
        <rect x="410" y="318" width="120" height="34" rx="6" fill="#38bdf8" stroke="#0f172a" stroke-width="3" />
        <polygon points="360,365 290,560 430,560" fill="#facc15" opacity="0.32" />
      `;
    case 'subsea_cable':
      return `
        <rect x="60" y="340" width="600" height="350" rx="28" fill="#0c4a6e" stroke="#38bdf8" stroke-width="4" />
        <path d="M60 580 Q220 530 360 580 T660 570 L660 690 L60 690 Z" fill="#1e293b" />
        <path d="M60 565 Q220 515 360 565 T660 555" fill="none" stroke="#facc15" stroke-width="14" />
        <circle cx="360" cy="565" r="24" fill="#ef4444" stroke="#ffffff" stroke-width="4" />
      `;
    case 'vault_lock':
      return `
        <rect x="170" y="330" width="380" height="360" rx="36" fill="#334155" stroke="#94a3b8" stroke-width="6" />
        <circle cx="360" cy="510" r="115" fill="#0f172a" stroke="#facc15" stroke-width="8" />
        <circle cx="360" cy="510" r="55" fill="#38bdf8" />
        <line x1="360" y1="395" x2="360" y2="625" stroke="#facc15" stroke-width="6" />
        <line x1="245" y1="510" x2="475" y2="510" stroke="#facc15" stroke-width="6" />
      `;
    case 'radar_sweep':
      return `
        <circle cx="360" cy="510" r="185" fill="#052e16" stroke="#22c55e" stroke-width="5" />
        <circle cx="360" cy="510" r="125" fill="none" stroke="#22c55e" stroke-width="2" stroke-dasharray="8 8" />
        <circle cx="360" cy="510" r="65" fill="none" stroke="#22c55e" stroke-width="2" />
        <path d="M360 510 L495 385 A185 185 0 0 1 540 510 Z" fill="#22c55e" opacity="0.35" />
        <circle cx="445" cy="435" r="14" fill="#ef4444" stroke="#ffffff" stroke-width="3" />
      `;
    case 'neural_web':
      return `
        <line x1="170" y1="400" x2="360" y2="350" stroke="#38bdf8" stroke-width="4" />
        <line x1="170" y1="400" x2="360" y2="510" stroke="#38bdf8" stroke-width="4" />
        <line x1="170" y1="600" x2="360" y2="510" stroke="#38bdf8" stroke-width="4" />
        <line x1="170" y1="600" x2="360" y2="660" stroke="#38bdf8" stroke-width="4" />
        <line x1="360" y1="350" x2="550" y2="510" stroke="#facc15" stroke-width="5" />
        <line x1="360" y1="510" x2="550" y2="510" stroke="#facc15" stroke-width="5" />
        <line x1="360" y1="660" x2="550" y2="510" stroke="#facc15" stroke-width="5" />
        <circle cx="170" cy="400" r="32" fill="#0284c7" stroke="#ffffff" stroke-width="4" />
        <circle cx="170" cy="600" r="32" fill="#0284c7" stroke="#ffffff" stroke-width="4" />
        <circle cx="360" cy="350" r="34" fill="#7c3aed" stroke="#ffffff" stroke-width="4" />
        <circle cx="360" cy="510" r="38" fill="#7c3aed" stroke="#ffffff" stroke-width="4" />
        <circle cx="360" cy="660" r="34" fill="#7c3aed" stroke="#ffffff" stroke-width="4" />
        <circle cx="550" cy="510" r="44" fill="#facc15" stroke="#0f172a" stroke-width="5" />
      `;
    default:
      return `
        <polygon points="360,320 510,385 510,530 360,685 210,530 210,385" fill="#0f172a" stroke="#38bdf8" stroke-width="6" />
        <polygon points="360,360 470,410 470,515 360,640 250,515 250,410" fill="#0284c7" opacity="0.5" />
        <path d="M315 505 L348 538 L415 465" fill="none" stroke="#22c55e" stroke-width="12" stroke-linecap="round" />
      `;
  }
}

function buildSceneMasterSvg(sc, sceneIdx, totalScenes, topicTag, palette, useCustomSvg) {
  const segW = Math.floor((644 - (totalScenes - 1) * 8) / totalScenes);
  let progBars = '';
  for (let s = 0; s < totalScenes; s++) {
    const x = 38 + s * (segW + 8);
    const fill = s <= sceneIdx ? '#facc15' : palette.isLight ? 'rgba(15,23,42,0.18)' : 'rgba(255,255,255,0.2)';
    progBars += `<rect x="${x}" y="120" width="${segW}" height="6" rx="3" fill="${fill}" />`;
  }

  const bannerTxt = escapeXml(sc.topBanner);
  const bannerW = Math.max(280, Math.min(620, sc.topBanner.length * 17 + 76));
  const bannerX = (720 - bannerW) / 2;

  const centerIllustration = (useCustomSvg && sc.customSvg)
    ? `<g transform="translate(0, 245)">${sc.customSvg}</g>`
    : buildFallbackArt(sc);

  const callouts = `
    ${renderCalloutPill(sc.callout1, 48, 250, 220, 410)}
    ${renderCalloutPill(sc.callout2, 430, 250, 500, 410)}
    ${renderCalloutPill(sc.callout3, 240, 745, 360, 620)}
  `;

  const baseSvg = `<?xml version="1.0" encoding="UTF-8"?>
  <svg width="720" height="1280" viewBox="0 0 720 1280" xml:lang="ar" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="bgGrad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${palette.bgTop}" />
        <stop offset="100%" stop-color="${palette.bgBottom}" />
      </linearGradient>
      <pattern id="diagStripes" width="90" height="1280" patternUnits="userSpaceOnUse">
        <rect x="0" y="0" width="42" height="1280" fill="${palette.stripe}" />
      </pattern>
    </defs>
    <rect width="720" height="1280" fill="url(#bgGrad)" />
    <rect width="720" height="1280" fill="url(#diagStripes)" />
    ${progBars}
    <text x="680" y="152" fill="${palette.accent}" font-size="15" font-weight="bold" text-anchor="end">${escapeXml(topicTag)}</text>
    <rect x="${bannerX}" y="168" width="${bannerW}" height="56" rx="28" fill="${palette.badgeBg}" stroke="#0f172a" stroke-width="4" />
    <text x="360" y="204" fill="${palette.badgeText}" font-size="25" font-weight="bold" text-anchor="middle">${bannerTxt}</text>
    ${centerIllustration}
    ${callouts}
  </svg>`;

  const animSvg = `<?xml version="1.0" encoding="UTF-8"?>
  <svg width="720" height="1280" viewBox="0 0 720 1280" xmlns="http://www.w3.org/2000/svg">
    <circle cx="360" cy="510" r="225" fill="none" stroke="${palette.accent}" stroke-width="3" stroke-dasharray="18 14" opacity="0.55" />
  </svg>`;

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
Style: Default,Noto Sans Arabic,44,&H00FFFFFF,&H0015CCFA,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,4,0,2,45,45,250,1

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

async function renderOneScene(jobDir, sc, idx, totalScenes, topicTag, palette, whooshPath, popPath) {
  const audioPath = path.join(jobDir, `aud_${idx}.mp3`);
  const hasAudio = await generateSceneAudio(sc.narrationAr, audioPath);
  const duration = hasAudio ? await getMediaDuration(audioPath) : 3.8;
  const durStr = duration.toFixed(2);

  const basePng = path.join(jobDir, `base_${idx}.png`);
  const animPng = path.join(jobDir, `anim_${idx}.png`);
  const assPath = path.join(jobDir, `sub_${idx}.ass`);

  let renderedBase;
  let renderedAnim;
  try {
    const { baseSvg, animSvg } = buildSceneMasterSvg(sc, idx, totalScenes, topicTag, palette, true);
    renderedBase = renderSvgToPng(baseSvg, 720);
    renderedAnim = renderSvgToPng(animSvg, 720);
  } catch (_) {
    const { baseSvg, animSvg } = buildSceneMasterSvg(sc, idx, totalScenes, topicTag, palette, false);
    renderedBase = renderSvgToPng(baseSvg, 720);
    renderedAnim = renderSvgToPng(animSvg, 720);
  }

  await Promise.all([
    fsp.writeFile(basePng, renderedBase),
    fsp.writeFile(animPng, renderedAnim),
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

async function produceAndPublishOne(index, seedTopic, usedTitles) {
  const t0 = Date.now();
  const jobDir = path.join(WORK_DIR, `job_${t0}_${index}`);
  await fsp.mkdir(jobDir, { recursive: true });

  try {
    const { whooshPath, popPath } = await ensureSoundEffects();
    const story = await generateStoryboard(seedTopic, usedTitles);
    usedTitles.push(story.title);

    const palette = COLOR_PALETTES[(index + Math.floor(Math.random() * COLOR_PALETTES.length)) % COLOR_PALETTES.length];
    const scenes = story.scenes.slice(0, 6);

    const readyClips = await Promise.all(
      scenes.map((sc, idx) => renderOneScene(jobDir, sc, idx, scenes.length, story.topicTag, palette, whooshPath, popPath))
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
    console.log(`✅ [${index + 1}/${BATCH_COUNT}] (${palette.name}) نُشر خلال ${sec}s -> ${story.title}`);
  } finally {
    await fsp.rm(jobDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function main() {
  await fsp.mkdir(WORK_DIR, { recursive: true });
  console.log(`🚀 بدء إنتاج دفعة (${BATCH_COUNT} فيديو متنوع) وإرسالها إلى ${TARGET_PLATFORM_URL}`);

  let shuffledPool = shuffleArray(TOPIC_IDEAS);
  const usedTitles = [];

  for (let i = 0; i < BATCH_COUNT; i++) {
    if (shuffledPool.length === 0) shuffledPool = shuffleArray(TOPIC_IDEAS);
    const seedTopic = shuffledPool.pop();
    try {
      await produceAndPublishOne(i, seedTopic, usedTitles);
    } catch (err) {
      console.error(`❌ خطأ في الفيديو ${i + 1}: ${err.message}`);
    }
  }
  console.log('🏁 اكتملت الدفعة المتنوعة بنجاح!');
}

main();
