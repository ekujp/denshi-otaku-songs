// 曲の候補を集めて、songs テーブルに「承認待ち(pending)」で追加する(タグで絞り込み版)
import { createClient } from "@supabase/supabase-js";

const LASTFM = process.env.LASTFM_API_KEY;
const SB_URL = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;
const MAX_NEW = Number(process.env.MAX_NEW || 20);   // 1回に追加する候補の上限
const SEEDS = Number(process.env.SEEDS || 15);       // 1回に起点にする曲の数
const PER_ARTIST = 2;                                // 同じアーティストの候補は1回に最大これだけ
if (!LASTFM || !SB_URL || !SB_KEY) { console.error("Secrets が足りません"); process.exit(1); }

// ---- 好みの設定(ここを書き換えると傾向を調整できる) ----
// 候補のアーティストのタグに、これらが1つでも入っていることが必要
const WANT = new Set(["electronic","electronica","edm","trance","house","techno","dance","hardcore","hardstyle","happy hardcore","j-core","jcore","dubstep","drum and bass","dnb","synthpop","electropop","electro","future bass","vocaloid","denpa","eurobeat","bass","trap","breakbeat","speedcore","progressive trance","uplifting trance","psytrance","big room","future house","tropical house","electro house","progressive house","deep house","tech house","idm","chiptune"]);
// タグの上位3つにこれらがあれば除外
const AVOID = new Set(["rock","metal","punk","alternative","indie","folk","hip-hop","rap","country","classical","blues","hard rock","pop rock","j-rock","visual kei","post-rock","emo","heavy metal","alternative rock","indie rock","pop punk","shoegaze","grunge","soul","r&b"]);
// これらがあれば、候補の中で優先する
const BONUS = new Set(["female vocalists","female vocalist","female vocals","vocaloid","anime","idol","j-pop","jpop","japanese","seiyuu","doujin","touhou"]);
// ------------------------------------------------------

const db = createClient(SB_URL, SB_KEY, { auth: { persistSession: false } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => String(s || "").toLowerCase().replace(/[\s()\[\]（）「」『』!！?？.,、。~〜…_\-:：/'"*・·]/g, "");
const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const asArray = (x) => (Array.isArray(x) ? x : x ? [x] : []);
// 「A & B」「A feat. B」「A(CV...)」から、先頭のアーティスト名だけを取り出す
const baseName = (s) => String(s || "").replace(/[(（].*?[)）]/g, "").split(/\s*(?:&|,|、|×| feat\.?| ft\.?)\s*/i)[0].trim();

async function lf(method, params) {
  const u = new URL("https://ws.audioscrobbler.com/2.0/");
  u.search = new URLSearchParams({ method, api_key: LASTFM, format: "json", ...params });
  try {
    const r = await fetch(u, { headers: { "User-Agent": "denshi-songs-collector/1.0" } });
    await sleep(300);
    if (!r.ok) return null;
    const j = await r.json();
    return j.error ? null : j;
  } catch { return null; }
}

// 1) いまある曲(承認待ち・却下済みも含む)を全部読む
const rows = [];
for (let from = 0; ; from += 1000) {
  const { data, error } = await db.from("songs").select("title,artist,artist_group,status").range(from, from + 999);
  if (error) { console.error(error.message); process.exit(1); }
  rows.push(...data);
  if (data.length < 1000) break;
}
const known = new Set(rows.map((r) => norm(r.title) + "|" + norm(r.artist)));

// 2) アーティストのタグで判定する(結果は使い回す)
const tagCache = new Map();
async function judge(artist) {
  const k = norm(artist);
  if (!tagCache.has(k)) {
    const j = await lf("artist.gettoptags", { artist, autocorrect: "1" });
    tagCache.set(k, asArray(j?.toptags?.tag).slice(0, 6).map((t) => String(t.name).toLowerCase()));
  }
  const tags = tagCache.get(k);
  if (!tags.length) return null;                         // タグ無し=判断できないので除外
  if (tags.slice(0, 3).some((t) => AVOID.has(t))) return null;
  if (!tags.some((t) => WANT.has(t))) return null;
  return { tags: tags.slice(0, 5), bonus: tags.some((t) => BONUS.has(t)) };
}

// 3) 候補を集める
const pool = [];
const perArtist = new Map();
async function consider(title, artist, seed, how) {
  if (!title || !artist) return;
  const key = norm(title) + "|" + norm(artist);
  if (known.has(key)) return;
  if ((perArtist.get(norm(artist)) || 0) >= PER_ARTIST) return;
  const j = await judge(artist);
  if (!j) return;
  known.add(key);
  perArtist.set(norm(artist), (perArtist.get(norm(artist)) || 0) + 1);
  pool.push({ bonus: j.bonus, row: { title, artist, artist_group: artist, status: "pending", source: `Last.fm(${how}): ${seed} / タグ: ${j.tags.join(", ")}` } });
}

const seeds = shuffle(rows.filter((r) => r.status === "published")).slice(0, SEEDS);
for (const s of seeds) {
  if (pool.length >= MAX_NEW * 2) break;
  const base = baseName(s.artist);
  const label = `${s.title} / ${base}`;
  // まず「この曲に似ている曲」
  const sim = await lf("track.getsimilar", { artist: base, track: s.title, limit: "15", autocorrect: "1" });
  const tracks = asArray(sim?.similartracks?.track);
  for (const t of tracks) await consider(t.name, t.artist?.name, label, "曲");
  // 曲の情報が無ければ「このアーティストに似ているアーティストの人気曲」
  if (!tracks.length) {
    const as = await lf("artist.getsimilar", { artist: base, limit: "8", autocorrect: "1" });
    for (const a of asArray(as?.similarartists?.artist).slice(0, 4)) {
      const top = await lf("artist.gettoptracks", { artist: a.name, limit: "2", autocorrect: "1" });
      for (const t of asArray(top?.toptracks?.track)) await consider(t.name, a.name, base, "アーティスト");
    }
  }
}

// 4) 女性ボーカル系のタグがあるものを先にして、上限まで書き込む
pool.sort((a, b) => Number(b.bonus) - Number(a.bonus));
const added = pool.slice(0, MAX_NEW).map((p) => p.row);
if (added.length) {
  const { error } = await db.from("songs").upsert(added, { onConflict: "title,artist", ignoreDuplicates: true });
  if (error) { console.error(error.message); process.exit(1); }
}
console.log(`起点の曲: ${seeds.length} / 条件に合う候補: ${pool.length} / 追加: ${added.length}`);
