/**
 * Слепая расшифровка — сервер субтитров.
 * Cloudflare Worker: отдаёт субтитры YouTube в формате, который понимает приложение.
 *
 * Развернуть:
 *   1. dash.cloudflare.com → Workers & Pages → Create → Worker
 *   2. Вставить этот файл целиком вместо шаблона, Deploy
 *   3. Адрес вида https://имя.workers.dev вписать в приложении
 *      («Настроить автозагрузку субтитров» → «Адрес сервера субтитров»)
 *
 * Запрос:  GET /?v=VIDEO_ID[&lang=en]
 * Ответ:   { lang, asr, langs:[{code,name}], cues:[{s,e,text,w:[{t,raw}]}] }
 *
 * Оговорка: YouTube регулярно меняет внутренние ручки. Если однажды перестанет
 * работать — это не поломка приложения, субтитры всегда можно вставить руками.
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Cache-Control': 'public, max-age=3600'
};
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {status, headers: {...CORS, 'Content-Type': 'application/json; charset=utf-8'}});

export default {
  async fetch(req) {
    if (req.method === 'OPTIONS') return new Response(null, {headers: CORS});

    const url = new URL(req.url);
    const v = (url.searchParams.get('v') || '').trim();
    const want = (url.searchParams.get('lang') || '').trim();

    if (!/^[\w-]{11}$/.test(v)) return json({error: 'нужен параметр v — ID видео из 11 символов'}, 400);

    try {
      let tracks = await tracksViaInnertube(v);
      if (!tracks.length) tracks = await tracksViaWatchPage(v);
      if (!tracks.length) return json({error: 'у этого видео нет субтитров'}, 404);

      const track =
        (want && tracks.find(t => t.code === want)) ||
        tracks.find(t => !t.asr) ||
        tracks[0];

      const cues = await loadCues(track.url);
      if (!cues.length) return json({error: 'дорожка субтитров пустая'}, 404);

      return json({
        lang: track.code,
        asr: !!track.asr,
        langs: tracks.map(t => ({code: t.code, name: t.name + (t.asr ? ' (авто)' : '')})),
        cues
      });
    } catch (e) {
      return json({error: 'не удалось получить субтитры: ' + (e && e.message ? e.message : e)}, 502);
    }
  }
};

/* --- источник 1: внутренний player API (клиент ANDROID, отдаёт треки без токенов) --- */
async function tracksViaInnertube(v) {
  const r = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'com.google.android.youtube/19.09.37 (Linux; U; Android 12) gzip',
      'X-Goog-Api-Format-Version': '2'
    },
    body: JSON.stringify({
      videoId: v,
      context: {
        client: {
          clientName: 'ANDROID',
          clientVersion: '19.09.37',
          androidSdkVersion: 31,
          hl: 'en',
          gl: 'US'
        }
      }
    })
  });
  if (!r.ok) return [];
  const data = await r.json();
  return normalizeTracks(data?.captions?.playerCaptionsTracklistRenderer?.captionTracks);
}

/* --- источник 2: разбор страницы просмотра --- */
async function tracksViaWatchPage(v) {
  const r = await fetch('https://www.youtube.com/watch?v=' + v + '&hl=en', {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9'
    }
  });
  const html = await r.text();
  const m = html.match(/"captionTracks":(\[.*?\])/);
  if (!m) return [];
  return normalizeTracks(JSON.parse(m[1].replace(/\\u0026/g, '&').replace(/\\\//g, '/')));
}

function normalizeTracks(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter(t => t && t.baseUrl)
    .map(t => ({
      url: t.baseUrl.replace(/\\u0026/g, '&'),
      code: t.languageCode || 'xx',
      name: t.name?.simpleText || t.name?.runs?.[0]?.text || t.languageCode || 'субтитры',
      asr: t.kind === 'asr' || /kind=asr/.test(t.baseUrl)
    }));
}

/* --- загрузка и нормализация реплик --- */
async function loadCues(baseUrl) {
  const r = await fetch(baseUrl + (baseUrl.includes('?') ? '&' : '?') + 'fmt=json3');
  const body = await r.text();
  if (body.trim().startsWith('{')) return fromJson3(JSON.parse(body));
  return fromXml(body);
}

/* json3 даёт тайминг каждого слова — приложение режет по фразам точнее */
function fromJson3(data) {
  const out = [];
  for (const ev of data.events || []) {
    if (!ev.segs) continue;
    const s = (ev.tStartMs || 0) / 1000;
    const e = s + (ev.dDurationMs || 0) / 1000;
    const words = [];
    let text = '';
    for (const seg of ev.segs) {
      const piece = (seg.utf8 || '').replace(/\n/g, ' ');
      text += piece;
      const raw = piece.trim();
      if (raw) words.push({t: s + (seg.tOffsetMs || 0) / 1000, raw});
    }
    text = clean(text);
    if (text) out.push({s, e: Math.max(e, s + 0.3), text, w: words});
  }
  return merge(out);
}

/* старый формат timedtext — только по репликам */
function fromXml(xml) {
  const out = [];
  const re = /<text start="([\d.]+)"(?: dur="([\d.]+)")?[^>]*>([\s\S]*?)<\/text>/g;
  let m;
  while ((m = re.exec(xml))) {
    const s = parseFloat(m[1]);
    const e = s + (parseFloat(m[2]) || 3);
    const text = clean(unescapeXml(m[3]));
    if (text) out.push({s, e, text});
  }
  return merge(out);
}

function unescapeXml(t) {
  return t.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d));
}
function clean(t) {
  return t.replace(/<[^>]*>/g, ' ').replace(/\[[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim();
}
/* авто-субтитры дублируют строки внахлёст — схлопываем */
function merge(cues) {
  cues.sort((a, b) => a.s - b.s);
  const out = [];
  for (const c of cues) {
    const p = out[out.length - 1];
    if (p && p.text === c.text) { p.e = Math.max(p.e, c.e); continue; }
    if (p && p.e > c.s) p.e = Math.max(c.s, p.s + 0.1);
    out.push(c);
  }
  return out;
}
